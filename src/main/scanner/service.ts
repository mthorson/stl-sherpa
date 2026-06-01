import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { PathResolver } from '@shared/paths';
import type { ScanProgress } from '@shared/types';
import {
  createFilesRepo,
  type FilesRepo,
  type RenameEntry,
  type UpsertInput
} from '@main/db/repos/files';
import { walkLibrary } from './walker';
import { startWatcher, type LibraryWatcher } from './watcher';
import { getAll as getPreferences } from '@main/preferences/store';
import { scopedLogger } from '@main/logger';

const log = scopedLogger('scanner');

interface PerLibrary {
  resolver: PathResolver;
  files: FilesRepo;
  progress: ScanProgress;
  watcher?: LibraryWatcher;
  changeFlushTimer?: NodeJS.Timeout;
}

export interface ScannerEvents {
  'scan-progress': (libraryId: string, progress: ScanProgress) => void;
  'scan-complete': (libraryId: string, progress: ScanProgress) => void;
  'files-changed': (libraryId: string) => void;
}

function emptyProgress(libraryId: string): ScanProgress {
  return {
    libraryId,
    state: 'idle',
    filesSeen: 0,
    inserted: 0,
    updated: 0,
    renamed: 0,
    removed: 0
  };
}

export class ScannerService extends EventEmitter {
  private libs = new Map<string, PerLibrary>();

  attach(libraryId: string, db: Database.Database, mountPath: string): void {
    if (this.libs.has(libraryId)) return;
    const resolver = new PathResolver(mountPath);
    const files = createFilesRepo(db, libraryId);
    this.libs.set(libraryId, { resolver, files, progress: emptyProgress(libraryId) });
    void this.runScan(libraryId);
  }

  detach(libraryId: string): void {
    const lib = this.libs.get(libraryId);
    if (!lib) return;
    if (lib.changeFlushTimer) clearTimeout(lib.changeFlushTimer);
    void lib.watcher?.close();
    this.libs.delete(libraryId);
  }

  detachAll(): void {
    for (const id of [...this.libs.keys()]) this.detach(id);
  }

  async rescan(libraryId: string): Promise<{ ok: boolean; error?: string }> {
    const lib = this.libs.get(libraryId);
    if (!lib) return { ok: false, error: `Library ${libraryId} is not attached` };
    if (lib.progress.state === 'scanning') {
      return { ok: false, error: 'Scan already in progress' };
    }
    void this.runScan(libraryId);
    return { ok: true };
  }

  getProgress(libraryId: string): ScanProgress | null {
    return this.libs.get(libraryId)?.progress ?? null;
  }

  private updateProgress(libraryId: string, patch: Partial<ScanProgress>): void {
    const lib = this.libs.get(libraryId);
    if (!lib) return;
    lib.progress = { ...lib.progress, ...patch };
    this.emit('scan-progress', libraryId, lib.progress);
  }

  private async runScan(libraryId: string): Promise<void> {
    const lib = this.libs.get(libraryId);
    if (!lib) return;
    if (lib.watcher) {
      await lib.watcher.close();
      lib.watcher = undefined;
    }

    this.updateProgress(libraryId, {
      ...emptyProgress(libraryId),
      state: 'scanning',
      startedAt: Date.now(),
      finishedAt: undefined,
      error: undefined
    });
    log.info('scan started', { libraryId });

    try {
      // Two-pass scan so we can detect renames before applying inserts/deletes.
      // Pass 1: collect everything from disk.
      const seen: UpsertInput[] = [];
      await walkLibrary(lib.resolver, {
        batchSize: 500,
        onBatch: async (batch: UpsertInput[]) => {
          seen.push(...batch);
          this.updateProgress(libraryId, { filesSeen: seen.length });
        }
      });

      // Pass 2: diff against the DB to classify each entry.
      const known = lib.files.listAllForDiff();
      const knownByPath = new Map(known.map((k) => [k.relPath, k] as const));

      const matched: UpsertInput[] = []; // present in both — needs upsert (mtime check)
      const newPaths: UpsertInput[] = []; // in seen, not in DB
      for (const s of seen) {
        const k = knownByPath.get(s.relPath);
        if (k) {
          matched.push(s);
          knownByPath.delete(s.relPath);
        } else {
          newPaths.push(s);
        }
      }
      // Remaining in knownByPath = in DB, not seen → candidate stale entries.
      const stale = [...knownByPath.values()];

      // Rename detection: bucket stale entries by (size, mtime); when a new
      // path uniquely matches an unmatched stale entry, treat as rename.
      const staleBySig = new Map<string, typeof stale>();
      for (const s of stale) {
        const key = `${s.sizeBytes}:${s.mtimeMs}`;
        const list = staleBySig.get(key);
        if (list) list.push(s);
        else staleBySig.set(key, [s]);
      }

      const renames: RenameEntry[] = [];
      const trueInserts: UpsertInput[] = [];
      for (const np of newPaths) {
        const key = `${np.sizeBytes}:${np.mtimeMs}`;
        const candidates = staleBySig.get(key);
        if (candidates && candidates.length === 1) {
          renames.push({
            id: candidates[0].id,
            toRelPath: np.relPath,
            toParentDir: np.parentDir,
            toFilename: np.filename
          });
          staleBySig.delete(key);
        } else {
          trueInserts.push(np);
        }
      }
      const toDelete = [...staleBySig.values()].flat().map((s) => s.relPath);

      // Apply: renames first (keeps id/thumb/tags), then upsert for
      // (matched + new), then delete remaining stale paths.
      const renamedCount = lib.files.applyRenames(renames);
      const upsertResult = lib.files.upsertMany([...matched, ...trueInserts]);
      const removedCount = lib.files.deleteByRelPaths(toDelete);

      const finalProgress: ScanProgress = {
        ...lib.progress,
        filesSeen: seen.length,
        inserted: upsertResult.inserted,
        updated: upsertResult.updated,
        renamed: renamedCount,
        removed: removedCount,
        state: 'watching',
        finishedAt: Date.now()
      };
      lib.progress = finalProgress;
      this.emit('scan-complete', libraryId, finalProgress);
      log.info('scan complete', {
        libraryId,
        filesSeen: seen.length,
        inserted: upsertResult.inserted,
        updated: upsertResult.updated,
        renamed: renamedCount,
        removed: removedCount
      });

      const prefs = getPreferences();
      const nasPollIntervalMs = (prefs.nasPollIntervalSec ?? 10) * 1000;
      lib.watcher = startWatcher(
        lib.resolver,
        lib.files,
        {
          onChange: () => this.scheduleChangeFlush(libraryId),
          onError: (err) => {
            log.warn('watcher error', { libraryId, err: err.message });
            this.updateProgress(libraryId, { state: 'error', error: err.message });
          }
        },
        { nasPollIntervalMs }
      );
    } catch (err) {
      log.error('scan failed', { libraryId, err: (err as Error).message });
      this.updateProgress(libraryId, {
        state: 'error',
        finishedAt: Date.now(),
        error: (err as Error).message
      });
    }
  }

  private scheduleChangeFlush(libraryId: string): void {
    const lib = this.libs.get(libraryId);
    if (!lib) return;
    if (lib.changeFlushTimer) return;
    lib.changeFlushTimer = setTimeout(() => {
      lib.changeFlushTimer = undefined;
      this.emit('files-changed', libraryId);
    }, 250);
  }
}

export const scanner = new ScannerService();
