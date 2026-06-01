import { EventEmitter } from 'node:events';
import { listOpenLibraries, type OpenLibrary } from '@main/libraries/manager';
import { RENDERER_VERSION } from '@main/db/repos/thumbnails';
import { PRIORITY_BACKGROUND, PRIORITY_USER, PRIORITY_VISIBLE } from '@main/db/repos/thumb-jobs';
import type { ExtractedMetadata } from '@shared/types';
import { DEFAULT_LIGHTING_STYLE, type LightingStyle } from '@shared/lighting-types';
import {
  TRANSIENT_RENDER_ERROR_MESSAGES,
  isTransientRenderError
} from '@shared/transient-errors';
import { thumbAbsPath, thumbRelPath, writeThumbnailFile } from './storage';
import { thumbPool } from './pool';
import { scopedLogger } from '@main/logger';

const log = scopedLogger('queue-runner');

const RECONCILE_BATCH = 1000;
const STALE_CLAIM_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;

export interface QueueStats {
  libraryId: string;
  pending: number;
  inFlight: number;
}

export class ThumbQueueRunner extends EventEmitter {
  private maxConcurrent: number;
  private inFlight = 0;
  private readonly processId = `pid-${process.pid}-${Date.now().toString(36)}`;
  private draining = false;
  private shuttingDown = false;
  /**
   * Latest user-selected lighting style for new renders. Pushed from the
   * renderer via IPC whenever the SegmentedControl changes. The visible
   * viewer always reflects this immediately; for background queue dispatches
   * the runner reads it here.
   */
  private lightingStyle: LightingStyle = DEFAULT_LIGHTING_STYLE;

  constructor(maxConcurrent = 2) {
    super();
    this.maxConcurrent = maxConcurrent;
  }

  setLightingStyle(style: LightingStyle): void {
    this.lightingStyle = style;
  }

  getLightingStyle(): LightingStyle {
    return this.lightingStyle;
  }

  /**
   * Find files in the library without an up-to-date thumb and enqueue jobs
   * for them at background priority. Cheap to call repeatedly — duplicate
   * jobs for the same file get coalesced by enqueueMany.
   */
  reconcile(library: OpenLibrary): void {
    library.thumbJobs.reapStale(this.processId, STALE_CLAIM_MS);
    // Scrub spurious failures from a prior shutdown — they aren't real model
    // failures, just jobs that were in flight when the app exited.
    library.thumbErrors.clearWithMessages([...TRANSIENT_RENDER_ERROR_MESSAGES]);
    const needing = library.thumbnails.findFilesNeedingThumbs(RECONCILE_BATCH);
    if (needing.length === 0) return;
    library.thumbJobs.enqueueMany(
      needing.map((n) => ({ fileId: n.fileId, priority: PRIORITY_BACKGROUND }))
    );
    this.drain();
  }

  /** Bump priority for files that are currently visible in the grid. */
  bumpVisible(library: OpenLibrary, fileIds: number[]): void {
    for (const fileId of fileIds) {
      library.thumbJobs.bumpPriority(fileId, PRIORITY_VISIBLE);
    }
    this.drain();
  }

  /**
   * Force a re-render of a single file even if a thumbnail already exists or
   * the file is in the failure cache. Wipes both so the worker retries from
   * a clean slate at high priority.
   */
  forceRerender(library: OpenLibrary, fileId: number): void {
    library.thumbnails.deleteByFileId(fileId);
    library.thumbErrors.clear(fileId);
    library.thumbJobs.enqueue(fileId, PRIORITY_USER);
    this.drain();
  }

  /**
   * Persist a caller-supplied PNG as the thumbnail (skips the worker
   * pipeline). The metadata panel uses this to snapshot the in-UI viewer
   * after the user has rotated the model. Same downstream effects as a
   * normal render: PNG to sidecar, thumbnails row upserted, error cleared,
   * 'thumb-rendered' event emitted so the grid refreshes.
   */
  async saveCustomThumbnail(
    library: OpenLibrary,
    fileId: number,
    png: Uint8Array
  ): Promise<void> {
    const file = library.files.getById(fileId);
    if (!file) return;
    const thumbAbs = thumbAbsPath(library.entry.mountPath, fileId);
    await writeThumbnailFile(thumbAbs, png);
    safeDb(library, () => {
      library.thumbnails.upsert({
        fileId,
        thumbRelPath: thumbRelPath(fileId),
        renderedAt: Date.now(),
        sourceMtimeMs: file.mtimeMs,
        sourceSha256: null,
        rendererVersion: RENDERER_VERSION
      });
      library.thumbErrors.clear(fileId);
    });
    this.emit('thumb-rendered', library.entry.id, fileId);
  }

  drain(): void {
    if (this.shuttingDown || this.draining) return;
    this.draining = true;
    try {
      while (this.inFlight < this.maxConcurrent && !this.shuttingDown) {
        const claim = this.claimAcrossLibraries();
        if (!claim) break;
        this.inFlight++;
        void this.dispatch(claim).finally(() => {
          this.inFlight--;
          if (!this.shuttingDown) this.drain();
        });
      }
    } finally {
      this.draining = false;
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // The in-flight jobs hold onto the pool; pool.shutdown() rejects them.
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private claimAcrossLibraries(): { lib: OpenLibrary; jobId: number; fileId: number } | null {
    for (const lib of listOpenLibraries()) {
      const job = lib.thumbJobs.claimNext(this.processId);
      if (job) return { lib, jobId: job.id, fileId: job.fileId };
    }
    return null;
  }

  private async dispatch(claim: {
    lib: OpenLibrary;
    jobId: number;
    fileId: number;
  }): Promise<void> {
    const { lib, jobId, fileId } = claim;
    if (!isLibraryDbOpen(lib)) return;

    const file = lib.files.getById(fileId);
    if (!file) {
      safeDb(lib, () => lib.thumbJobs.finish(jobId));
      return;
    }
    const absPath = lib.resolver.toAbsolute(file.relPath);

    let png: Uint8Array | null = null;
    let metadata: ExtractedMetadata | null = null;
    let finalErr: string | null = null;
    try {
      const out = await thumbPool.render({
        absPath,
        ext: file.ext,
        lightingStyle: this.lightingStyle,
        orientation: file.orientation
      });
      png = out.png;
      metadata = out.metadata;
    } catch (err) {
      finalErr = (err as Error).message ?? String(err);
    }

    // Library may have detached (or the app may be shutting down) during the
    // render. Don't touch the DB after that point — the writes would throw
    // unhandled rejections.
    if (!isLibraryDbOpen(lib)) return;

    if (finalErr === null && png && metadata) {
      try {
        const thumbAbs = thumbAbsPath(lib.entry.mountPath, file.id);
        await writeThumbnailFile(thumbAbs, png);
        if (!isLibraryDbOpen(lib)) return;
        safeDb(lib, () => {
          lib.thumbnails.upsert({
            fileId: file.id,
            thumbRelPath: thumbRelPath(file.id),
            renderedAt: Date.now(),
            sourceMtimeMs: file.mtimeMs,
            sourceSha256: null,
            rendererVersion: RENDERER_VERSION
          });
          // The AFTER UPDATE OF metadata_json trigger refreshes the FTS row
          // so material names become searchable.
          lib.files.setMetadata(file.id, JSON.stringify(metadata));
          lib.thumbErrors.clear(file.id);
          lib.thumbJobs.finish(jobId);
        });
        this.emit('thumb-rendered', lib.entry.id, file.id);
        return;
      } catch (writeErr) {
        // Writing the sidecar PNG can fail (NAS hiccup, disk full); fall
        // through to the failure handler.
        finalErr = (writeErr as Error).message ?? String(writeErr);
      }
    }

    if (finalErr !== null) {
      const message = finalErr;
      // Transient shutdown errors are not the file's fault — release the
      // claim and roll the attempt counter back so the job is picked up
      // cleanly on the next session.
      if (isTransientRenderError(message)) {
        safeDb(lib, () => lib.thumbJobs.releaseForRetry(jobId));
        return;
      }
      safeDb(lib, () => {
        const attempts = readJobAttempts(lib, jobId);
        if (attempts >= MAX_ATTEMPTS) {
          log.error('thumb render giving up', {
            libraryId: lib.entry.id,
            fileId: file.id,
            relPath: file.relPath,
            attempts,
            err: message
          });
          lib.thumbErrors.upsert({
            fileId: file.id,
            error: message,
            failedAt: Date.now(),
            attempts,
            sourceMtimeMs: file.mtimeMs,
            rendererVersion: RENDERER_VERSION
          });
          lib.thumbJobs.finish(jobId);
        } else {
          log.warn('thumb render failed, will retry', {
            libraryId: lib.entry.id,
            fileId: file.id,
            relPath: file.relPath,
            attempts,
            err: message
          });
          lib.thumbJobs.fail(jobId, message);
        }
      });
      this.emit('thumb-failed', lib.entry.id, file.id, message);
    }
  }
}

function isLibraryDbOpen(lib: OpenLibrary): boolean {
  return lib.db.open === true;
}

/** Run a DB-touching block; swallow errors that come from a closed connection. */
function safeDb(lib: OpenLibrary, fn: () => void): void {
  if (!isLibraryDbOpen(lib)) return;
  try {
    fn();
  } catch (err) {
    if ((err as Error).message?.includes('database connection is not open')) return;
    throw err;
  }
}

function readJobAttempts(lib: OpenLibrary, jobId: number): number {
  const row = lib.db
    .prepare<[number]>('SELECT attempts FROM thumb_jobs WHERE id = ?')
    .get(jobId) as { attempts: number } | undefined;
  return row?.attempts ?? MAX_ATTEMPTS;
}

export const queueRunner = new ThumbQueueRunner();
