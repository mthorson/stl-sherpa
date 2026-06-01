import { EventEmitter } from 'node:events';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenLibrary } from '@main/libraries/manager';
import { queueRunner } from '@main/thumb-pool/queue-runner';
import type { CacheProgress } from '@shared/types';
import { scopedLogger } from '@main/logger';

const THUMBS_DIR = '.meshFlask/thumbs';
const log = scopedLogger('cache');

function idleProgress(libraryId: string): CacheProgress {
  return { libraryId, state: 'idle', done: 0, total: 0 };
}

/**
 * Tracks thumbnail-cache rebuilds so the renderer can show determinate progress
 * and cancel a long rebuild. A rebuild clears the thumbnails table and re-queues
 * every file, then watches the queue runner's per-thumb events to advance a
 * counter. There is at most one rebuild per library at a time; this is not a
 * generic job framework — just the bookkeeping the cache rebuild needs.
 */
export class CacheRebuildService extends EventEmitter {
  private progress = new Map<string, CacheProgress>();
  /** Libraries with an active rebuild, mapped to remaining file ids we expect. */
  private active = new Set<string>();
  private bound = false;

  private ensureBound(): void {
    if (this.bound) return;
    this.bound = true;
    const onDone = (libraryId: string) => this.onThumbSettled(libraryId);
    queueRunner.on('thumb-rendered', onDone);
    // A persistent failure also "settles" a file — it won't render, so it
    // shouldn't keep the progress bar from ever completing.
    queueRunner.on('thumb-failed', onDone);
  }

  /**
   * Wipe every thumbnail row + error for a library and re-queue every file at
   * background priority. Sets up progress tracking against the total file count.
   */
  start(library: OpenLibrary): void {
    this.ensureBound();
    const libraryId = library.entry.id;
    library.thumbnails.deleteAll();
    library.thumbErrors.clearAll();
    const total = library.files.count();
    const progress: CacheProgress = {
      libraryId,
      state: 'rebuilding',
      done: 0,
      total,
      startedAt: Date.now(),
      finishedAt: undefined
    };
    this.progress.set(libraryId, progress);
    if (total === 0) {
      // Nothing to render — complete immediately so the UI doesn't hang.
      this.finish(libraryId, 'complete');
      return;
    }
    this.active.add(libraryId);
    this.emit('progress', libraryId, progress);
    log.info('cache rebuild started', { libraryId, total });
    // The queueRunner's reconcile() enqueues every file needing a thumb.
    queueRunner.reconcile(library);
  }

  /**
   * Cancel an in-progress rebuild: drop the queued (unclaimed) jobs so no more
   * renders start. In-flight renders finish on their own — their thumbnails are
   * harmless extra rows — leaving DB + sidecars consistent. The remaining files
   * simply have no thumb yet and get picked up by the next scan/open reconcile.
   */
  cancel(library: OpenLibrary): void {
    const libraryId = library.entry.id;
    if (!this.active.has(libraryId)) return;
    const cleared = library.thumbJobs.clearPending();
    log.info('cache rebuild cancelled', { libraryId, clearedJobs: cleared });
    this.finish(libraryId, 'cancelled');
  }

  getStatus(libraryId: string): CacheProgress | null {
    return this.progress.get(libraryId) ?? null;
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private onThumbSettled(libraryId: string): void {
    if (!this.active.has(libraryId)) return;
    const progress = this.progress.get(libraryId);
    if (!progress || progress.state !== 'rebuilding') return;
    const done = Math.min(progress.total, progress.done + 1);
    const next: CacheProgress = { ...progress, done };
    this.progress.set(libraryId, next);
    if (done >= next.total) {
      this.finish(libraryId, 'complete');
    } else {
      this.emit('progress', libraryId, next);
    }
  }

  private finish(libraryId: string, state: 'complete' | 'cancelled'): void {
    this.active.delete(libraryId);
    const prev = this.progress.get(libraryId) ?? idleProgress(libraryId);
    const final: CacheProgress = {
      ...prev,
      state,
      finishedAt: Date.now()
    };
    this.progress.set(libraryId, final);
    this.emit('complete', libraryId, final);
    log.info('cache rebuild finished', { libraryId, state, done: final.done, total: final.total });
  }
}

export const cacheRebuilds = new CacheRebuildService();

/**
 * Wipe every `thumbnails` row for a library and re-queue every known file
 * at background priority, with progress + cancel support via the rebuild
 * service. The queueRunner's reconcile() walks files needing thumbs and
 * enqueues them.
 */
export function rebuildThumbnailCache(library: OpenLibrary): void {
  cacheRebuilds.start(library);
}

/**
 * Walk `<root>/.meshFlask/thumbs/**` and delete any sidecar PNG/WebP whose
 * `file_id` (encoded in the filename) is no longer present in the DB.
 * Returns the number of files removed.
 *
 * Sidecar layout: `.meshFlask/thumbs/<aa>/<bb>/<file_id>.webp`
 */
export function purgeOrphanThumbs(library: OpenLibrary): { removed: number } {
  const root = library.resolver.getMountPath();
  const base = join(root, THUMBS_DIR);
  const known = new Set(library.thumbnails.listAllFileIds());
  let removed = 0;

  let l1: string[];
  try {
    l1 = readdirSync(base);
  } catch {
    return { removed: 0 };
  }
  for (const a of l1) {
    const aDir = join(base, a);
    let l2: string[];
    try {
      l2 = readdirSync(aDir);
    } catch {
      continue;
    }
    for (const b of l2) {
      const bDir = join(aDir, b);
      let files: string[];
      try {
        files = readdirSync(bDir);
      } catch {
        continue;
      }
      for (const f of files) {
        // Filename is `<id>.<ext>` — strip extension and parse.
        const dot = f.lastIndexOf('.');
        const idStr = dot < 0 ? f : f.slice(0, dot);
        const id = Number.parseInt(idStr, 10);
        if (Number.isNaN(id) || known.has(id)) continue;
        try {
          rmSync(join(bDir, f), { force: true });
          removed++;
        } catch {
          // best-effort
        }
      }
    }
  }
  void statSync;
  return { removed };
}
