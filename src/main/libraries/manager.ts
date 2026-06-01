import { existsSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import type { LibrarySummary } from '@shared/types';
import {
  DB_FILENAME,
  insertLibraryRow,
  openLibraryDatabase,
  readLibraryRow,
  runIntegrityCheck
} from '@main/db/connection';
import { rotateBackup } from '@main/db/backups';
import { broadcastOrQueue } from '@main/events';
import { undoQueue } from '@main/undo/queue';
import { createFilesRepo, type FilesRepo } from '@main/db/repos/files';
import { createTagsRepo, type TagsRepo } from '@main/db/repos/tags';
import { createThumbnailsRepo, type ThumbnailsRepo } from '@main/db/repos/thumbnails';
import { createThumbJobsRepo, type ThumbJobsRepo } from '@main/db/repos/thumb-jobs';
import { createThumbErrorsRepo, type ThumbErrorsRepo } from '@main/db/repos/thumb-errors';
import { createCollectionsRepo, type CollectionsRepo } from '@main/db/repos/collections';
import { scanner } from '@main/scanner/service';
import { PathResolver } from '@shared/paths';
import { scopedLogger } from '@main/logger';
import * as registry from './registry';

const log = scopedLogger('libraries');

/**
 * One open library: the per-machine registry entry plus a live DB handle and
 * cached repos. Held in memory for the app's lifetime so IPC doesn't reopen
 * the DB on every call.
 */
export interface OpenLibrary {
  entry: registry.RegistryEntry;
  db: Database.Database;
  resolver: PathResolver;
  files: FilesRepo;
  tags: TagsRepo;
  thumbnails: ThumbnailsRepo;
  thumbJobs: ThumbJobsRepo;
  thumbErrors: ThumbErrorsRepo;
  collections: CollectionsRepo;
}

const open = new Map<string, OpenLibrary>();

function toSummary(entry: registry.RegistryEntry, online: boolean): LibrarySummary {
  return {
    id: entry.id,
    name: entry.label,
    mountPath: entry.mountPath,
    online,
    lastSeen: entry.lastSeen
  };
}

function attachLibrary(entry: registry.RegistryEntry, db: Database.Database): OpenLibrary {
  const handle: OpenLibrary = {
    entry,
    db,
    resolver: new PathResolver(entry.mountPath),
    files: createFilesRepo(db, entry.id),
    tags: createTagsRepo(db),
    thumbnails: createThumbnailsRepo(db),
    thumbJobs: createThumbJobsRepo(db),
    thumbErrors: createThumbErrorsRepo(db),
    collections: createCollectionsRepo(db)
  };
  open.set(entry.id, handle);

  // Integrity check runs against the open connection (so it sees pending WAL
  // pages); a failure doesn't prevent attachment — users still want their
  // sidebar entry — but it's broadcast to the renderer for a visible warning.
  const integrity = runIntegrityCheck(db);
  if (!integrity.ok) {
    log.error('integrity check failed', {
      id: entry.id,
      mountPath: entry.mountPath,
      err: integrity.error
    });
    broadcastOrQueue({
      kind: 'integrity-failed',
      libraryId: entry.id,
      libraryName: entry.label,
      error: integrity.error
    });
  } else {
    log.info('integrity check ok', { id: entry.id });
  }

  scanner.attach(entry.id, db, entry.mountPath);
  log.info('library attached', { id: entry.id, name: entry.label, mountPath: entry.mountPath });
  return handle;
}

function detachLibrary(id: string): void {
  scanner.detach(id);
  const handle = open.get(id);
  if (handle) {
    try {
      handle.db.close();
    } catch (e) {
      log.warn('library db.close failed', { id, err: (e as Error).message });
    }
    open.delete(id);
    // Drop pending undo entries — their closures hold references to this
    // library's repos and resolver and are useless against a closed DB.
    undoQueue.clear(id);
    log.info('library detached', { id });
  }
}

/**
 * Try to open every library in the registry. Missing mounts and id mismatches
 * are reported as offline rather than throwing — the user can still see the
 * library in the sidebar and remediate.
 */
export function openAllFromRegistry(): LibrarySummary[] {
  const summaries: LibrarySummary[] = [];
  for (const entry of registry.listEntries()) {
    if (open.has(entry.id)) {
      summaries.push(toSummary(entry, true));
      continue;
    }
    const dbPath = join(entry.mountPath, DB_FILENAME);
    if (!existsSync(dbPath)) {
      log.warn('library mount missing on startup', { id: entry.id, mountPath: entry.mountPath });
      summaries.push(toSummary(entry, false));
      continue;
    }
    try {
      // Snapshot the DB before opening — better-sqlite3 takes a WAL lock on
      // open, so doing this first guarantees a clean file copy.
      rotateBackup(entry.mountPath);
      const db = openLibraryDatabase(entry.mountPath);
      const row = readLibraryRow(db);
      if (!row || row.id !== entry.id) {
        log.warn('library id mismatch on registry open', {
          id: entry.id,
          rowId: row?.id,
          mountPath: entry.mountPath
        });
        db.close();
        summaries.push(toSummary(entry, false));
        continue;
      }
      attachLibrary(entry, db);
      registry.touchLastSeen(entry.id);
      summaries.push(toSummary({ ...entry, lastSeen: Date.now() }, true));
    } catch (e) {
      log.error('failed to open library from registry', {
        id: entry.id,
        mountPath: entry.mountPath,
        err: (e as Error).message
      });
      summaries.push(toSummary(entry, false));
    }
  }
  return summaries;
}

export function listLibraries(): LibrarySummary[] {
  return registry.listEntries().map((entry) => toSummary(entry, open.has(entry.id)));
}

export function getOpenLibrary(id: string): OpenLibrary | undefined {
  return open.get(id);
}

export function listOpenLibraries(): OpenLibrary[] {
  return [...open.values()];
}

export function addLibrary(args: {
  mountPath: string;
  name?: string;
}): { ok: true; library: LibrarySummary } | { ok: false; error: string } {
  const { mountPath } = args;

  if (!existsSync(mountPath)) {
    return { ok: false, error: `Folder does not exist: ${mountPath}` };
  }
  if (!statSync(mountPath).isDirectory()) {
    return { ok: false, error: `Not a directory: ${mountPath}` };
  }

  let db: Database.Database;
  try {
    rotateBackup(mountPath);
    db = openLibraryDatabase(mountPath);
  } catch (e) {
    return { ok: false, error: `Failed to open DB: ${(e as Error).message}` };
  }

  let id: string;
  let name: string;
  try {
    const existing = readLibraryRow(db);
    if (existing) {
      id = existing.id;
      name = existing.name;
    } else {
      id = uuid();
      name = args.name?.trim() || basename(mountPath) || 'Library';
      insertLibraryRow(db, { id, name });
    }
  } catch (e) {
    db.close();
    return { ok: false, error: `Failed to read/write library row: ${(e as Error).message}` };
  }

  // Upsert covers both first-add and re-mounting an existing library at a
  // new path (the supported way to "move" a library between mounts).
  registry.upsertEntry({ id, label: name, mountPath, lastSeen: Date.now() });

  // Detach any prior handle for this id (different mount) and re-attach.
  if (open.has(id)) detachLibrary(id);
  const entry = registry.findById(id)!;
  attachLibrary(entry, db);
  log.info('library added', { id, name, mountPath });

  return { ok: true, library: toSummary(entry, true) };
}

export function renameLibrary(args: {
  id: string;
  name: string;
}): { ok: true; library: LibrarySummary } | { ok: false; error: string } {
  const name = args.name.trim();
  if (!name) return { ok: false, error: 'Name cannot be empty' };
  const entry = registry.findById(args.id);
  if (!entry) return { ok: false, error: 'Library not found' };

  const handle = open.get(args.id);
  if (handle) {
    try {
      handle.db.prepare('UPDATE library SET name = ?').run(name);
    } catch (e) {
      return { ok: false, error: `Failed to update DB: ${(e as Error).message}` };
    }
  }
  registry.upsertEntry({ ...entry, label: name });
  return { ok: true, library: toSummary({ ...entry, label: name }, !!handle) };
}

export function removeLibrary(args: {
  id: string;
  deleteCache?: boolean;
}): { ok: true } | { ok: false; error: string } {
  detachLibrary(args.id);
  const entry = registry.findById(args.id);
  registry.removeEntry(args.id);
  log.info('library removed', { id: args.id, deleteCache: !!args.deleteCache });

  if (args.deleteCache && entry) {
    try {
      rmSync(join(entry.mountPath, DB_FILENAME), { force: true });
      rmSync(join(entry.mountPath, '.meshFlask'), { recursive: true, force: true });
    } catch (e) {
      log.error('library cache delete failed', {
        id: args.id,
        mountPath: entry.mountPath,
        err: (e as Error).message
      });
      return {
        ok: false,
        error: `Removed registry entry but cache delete failed: ${(e as Error).message}`
      };
    }
  }
  return { ok: true };
}

export function shutdown(): void {
  scanner.detachAll();
  for (const { db } of open.values()) {
    try {
      db.close();
    } catch {
      // best-effort
    }
  }
  open.clear();
}
