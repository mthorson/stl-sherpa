import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { PathResolver } from '@shared/paths';
import type { ScanProgress } from '@shared/types';
import {
  createFilesRepo,
  type FilesRepo,
  type RenameEntry,
  type UpsertInput
} from '@main/db/repos/files';
import { walkLibrary, WalkAbortedError } from './walker';
import { startWatcher, type LibraryWatcher } from './watcher';
import { getAll as getPreferences } from '@main/preferences/store';
import { scopedLogger, time } from '@main/logger';
import { hashFileContent } from '@main/files/hash';

const log = scopedLogger('scanner');

interface PerLibrary {
  resolver: PathResolver;
  files: FilesRepo;
  progress: ScanProgress;
  watcher?: LibraryWatcher;
  changeFlushTimer?: NodeJS.Timeout;
  /** Set while a scan is running so it can be cancelled mid-walk. */
  abort?: AbortController;
  scanTask?: Promise<void>;
  hashTask?: Promise<void>;
  hashAgain?: boolean;
  mutationTask?: Promise<unknown>;
  closing?: boolean;
}

export interface ScannerEvents {
  'scan-progress': (libraryId: string, progress: ScanProgress) => void;
  'scan-complete': (libraryId: string, progress: ScanProgress) => void;
  'scan-cancelled': (libraryId: string, progress: ScanProgress) => void;
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
    const lib: PerLibrary = { resolver, files, progress: emptyProgress(libraryId) };
    this.libs.set(libraryId, lib);
    this.startScan(libraryId, lib);
  }

  async detach(libraryId: string): Promise<void> {
    const lib = this.libs.get(libraryId);
    if (!lib) return;
    lib.closing = true;
    lib.abort?.abort();
    if (lib.changeFlushTimer) clearTimeout(lib.changeFlushTimer);
    await lib.scanTask;
    await lib.mutationTask;
    await lib.watcher?.close();
    await lib.hashTask;
    this.libs.delete(libraryId);
  }

  async detachAll(): Promise<void> {
    await Promise.all([...this.libs.keys()].map((id) => this.detach(id)));
  }

  async rescan(libraryId: string): Promise<{ ok: boolean; error?: string }> {
    const lib = this.libs.get(libraryId);
    if (!lib) return { ok: false, error: `Library ${libraryId} is not attached` };
    if (lib.mutationTask) return { ok: false, error: 'File operation in progress' };
    if (lib.scanTask || lib.progress.state === 'scanning') {
      return { ok: false, error: 'Scan already in progress' };
    }
    this.startScan(libraryId, lib);
    return { ok: true };
  }

  /** Serialize batch disk operations and hide their temporary paths from scanning. */
  async withFileMutation<T>(libraryId: string, operation: () => Promise<T>): Promise<T> {
    const lib = this.libs.get(libraryId);
    if (!lib || lib.closing) throw new Error('Library no longer open');
    const previous = lib.mutationTask;
    const task = (async () => {
      await previous?.catch(() => undefined);
      await lib.scanTask;
      if (lib.closing) throw new Error('Library no longer open');
      log.debug('pausing watcher for file operation', { libraryId });
      await lib.watcher?.close({ flushPending: false });
      lib.watcher = undefined;
      await lib.hashTask;
      return operation();
    })();
    lib.mutationTask = task;
    try {
      return await task;
    } finally {
      if (lib.mutationTask === task) {
        lib.mutationTask = undefined;
        // Reconcile changes made while watching was suspended, including rollback.
        if (!lib.closing) this.startScan(libraryId, lib);
      }
    }
  }

  private startScan(libraryId: string, lib: PerLibrary): void {
    const task = this.runScan(libraryId);
    lib.scanTask = task;
    void task.finally(() => {
      if (lib.scanTask === task) lib.scanTask = undefined;
    });
  }

  /**
   * Abort an in-progress scan. The walk throws an AbortError, runScan catches
   * it and leaves the DB untouched (the diff is only applied after the walk
   * completes), so partial state stays consistent. No-op if nothing is scanning.
   */
  cancelScan(libraryId: string): void {
    const lib = this.libs.get(libraryId);
    if (!lib || lib.progress.state !== 'scanning') return;
    lib.abort?.abort();
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
    if (lib.hashTask) await lib.hashTask;
    if (lib.closing) return;
    if (lib.watcher) {
      await lib.watcher.close({ flushPending: false });
      lib.watcher = undefined;
    }
    if (lib.closing) return;

    const abort = new AbortController();
    lib.abort = abort;

    this.updateProgress(libraryId, {
      ...emptyProgress(libraryId),
      state: 'scanning',
      startedAt: Date.now(),
      finishedAt: undefined,
      error: undefined
    });
    log.info('scan started', { libraryId });

    try {
      await time(log, 'scan', () => this.indexLibrary(libraryId, lib), {
        meta: { libraryId }
      });
      // Hash new/changed files for exact-duplicate detection. Upsert clears
      // content_sha256 to NULL whenever a file's content changes, so the
      // missing-hash list is exactly the set that needs (re)hashing. Done
      // after scan-complete (emitted inside indexLibrary) so the grid shows
      // up promptly; the hashes arrive with the follow-up files-changed event.
      if (lib.closing) return;
      this.requestHashing(libraryId, lib);

      const prefs = getPreferences();
      const nasPollIntervalMs = (prefs.nasPollIntervalSec ?? 10) * 1000;
      if (lib.closing) return;
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
      // A cancelled scan threw before any DB diff was applied (the diff runs
      // only after the walk resolves), so partial state is consistent — nothing
      // was inserted, updated, or removed. Surface it as 'cancelled', not an
      // error, and don't start the watcher.
      if (err instanceof WalkAbortedError) {
        const cancelledProgress: ScanProgress = {
          ...lib.progress,
          state: 'cancelled',
          finishedAt: Date.now(),
          error: undefined
        };
        lib.progress = cancelledProgress;
        lib.abort = undefined;
        this.emit('scan-cancelled', libraryId, cancelledProgress);
        log.info('scan cancelled', { libraryId, filesSeen: cancelledProgress.filesSeen });
        return;
      }
      log.error('scan failed', { libraryId, err: (err as Error).message });
      lib.abort = undefined;
      this.updateProgress(libraryId, {
        state: 'error',
        finishedAt: Date.now(),
        error: (err as Error).message
      });
    }
  }

  private async indexLibrary(libraryId: string, lib: PerLibrary): Promise<void> {
    // Two-pass scan so we can detect renames before applying inserts/deletes.
    // Pass 1: collect everything from disk.
    const seen: UpsertInput[] = [];
    await walkLibrary(lib.resolver, {
      batchSize: 500,
      signal: lib.abort?.signal,
      onBatch: async (batch: UpsertInput[]) => {
        seen.push(...batch);
        this.updateProgress(libraryId, { filesSeen: seen.length });
      }
    });
    if (lib.abort?.signal.aborted) throw new WalkAbortedError();

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
    const newCountBySig = new Map<string, number>();
    for (const file of newPaths) {
      const key = `${file.sizeBytes}:${file.mtimeMs}`;
      newCountBySig.set(key, (newCountBySig.get(key) ?? 0) + 1);
    }

    const renames: RenameEntry[] = [];
    const trueInserts: UpsertInput[] = [];
    for (const np of newPaths) {
      const key = `${np.sizeBytes}:${np.mtimeMs}`;
      const candidates = staleBySig.get(key);
      const candidate =
        candidates?.length === 1 && newCountBySig.get(key) === 1 ? candidates[0] : null;
      const digest =
        candidate?.contentSha256 && candidate.ext === np.ext
          ? await hashFileContent(lib.resolver.toAbsolute(np.relPath))
          : null;
      if (candidate && digest === candidate.contentSha256) {
        renames.push({
          id: candidate.id,
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
    if (lib.abort?.signal.aborted) throw new WalkAbortedError();
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
    // Scan finished cleanly; release the abort handle before signalling done.
    lib.abort = undefined;
    this.emit('scan-complete', libraryId, finalProgress);
    log.info('scan complete', {
      libraryId,
      filesSeen: seen.length,
      inserted: upsertResult.inserted,
      updated: upsertResult.updated,
      renamed: renamedCount,
      removed: removedCount
    });
  }

  /**
   * Stream-hash every file in the library that lacks a content_sha256 and
   * persist the digests in batches. Runs concurrently with a small worker
   * pool so a big library doesn't serialize on disk one file at a time, but
   * stays bounded so we never open thousands of read streams at once. Best
   * effort: read failures leave that row's hash NULL (skipped by dup grouping).
   */
  private async hashMissing(libraryId: string): Promise<void> {
    const lib = this.libs.get(libraryId);
    if (!lib) return;
    const pending = lib.files.listMissingContentHash();
    if (pending.length === 0) return;
    log.debug('content hashing started', { libraryId, count: pending.length });

    const CONCURRENCY = 4;
    const BATCH = 200;
    let buffer: Array<{
      id: number;
      sha256: string;
      sizeBytes: number;
      mtimeMs: number;
    }> = [];
    let hashed = 0;

    const flush = () => {
      if (buffer.length === 0) return;
      // The library may have detached (or detached and re-attached with a
      // fresh handle) mid-hash; writing through the old repo would then throw
      // on a closed DB. Identity check catches both.
      if (this.libs.get(libraryId) === lib) {
        hashed += lib.files.setContentSha256Many(buffer);
      }
      buffer = [];
    };

    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const item = pending[cursor++];
        // Library may have been detached mid-hash (removed / app quitting).
        if (lib.closing || this.libs.get(libraryId) !== lib) return;
        const abs = lib.resolver.toAbsolute(item.relPath);
        let before: Awaited<ReturnType<typeof stat>>;
        try {
          before = await stat(abs);
        } catch {
          continue;
        }
        if (before.size !== item.sizeBytes || Math.floor(before.mtimeMs) !== item.mtimeMs) continue;
        const digest = await hashFileContent(abs);
        let after: Awaited<ReturnType<typeof stat>>;
        try {
          after = await stat(abs);
        } catch {
          continue;
        }
        if (
          digest &&
          after.size === item.sizeBytes &&
          Math.floor(after.mtimeMs) === item.mtimeMs
        ) {
          buffer.push({
            id: item.id,
            sha256: digest,
            sizeBytes: item.sizeBytes,
            mtimeMs: item.mtimeMs
          });
          if (buffer.length >= BATCH) flush();
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker())
      );
      flush();
    } catch (err) {
      flush();
      log.warn('content hashing failed', { libraryId, err: (err as Error).message });
    }

    if (hashed > 0 && !lib.closing) {
      log.info('content hashing complete', { libraryId, hashed, scanned: pending.length });
      // Let the renderer pick up newly populated hashes (duplicates view).
      this.emit('files-changed', libraryId);
    }
  }

  private requestHashing(libraryId: string, lib: PerLibrary): void {
    if (lib.closing) return;
    lib.hashAgain = true;
    if (lib.hashTask) return;
    const task = (async () => {
      do {
        lib.hashAgain = false;
        await this.hashMissing(libraryId);
      } while (lib.hashAgain && !lib.closing);
    })();
    lib.hashTask = task;
    void task.finally(() => {
      if (lib.hashTask === task) lib.hashTask = undefined;
    });
  }

  private scheduleChangeFlush(libraryId: string): void {
    const lib = this.libs.get(libraryId);
    if (!lib || lib.closing) return;
    if (lib.changeFlushTimer) return;
    lib.changeFlushTimer = setTimeout(() => {
      lib.changeFlushTimer = undefined;
      this.emit('files-changed', libraryId);
      if (!lib.mutationTask && lib.progress.state !== 'scanning') this.requestHashing(libraryId, lib);
    }, 250);
  }
}

export const scanner = new ScannerService();
