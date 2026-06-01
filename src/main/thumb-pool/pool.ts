import { app, BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import {
  THUMB_WORKER_CHANNEL,
  type ThumbRenderRequest,
  type ThumbRenderResult
} from '@shared/thumb-worker-protocol';
import { POOL_SHUTDOWN_ERROR, WORKER_SHUTDOWN_ERROR } from '@shared/transient-errors';
import type { ExtractedMetadata } from '@shared/types';
import type { LightingStyle } from '@shared/lighting-types';
import type { FileOrientation } from '@shared/orientation';
import { scopedLogger } from '@main/logger';

const log = scopedLogger('thumb-pool');

export interface RenderOutput {
  png: Uint8Array;
  metadata: ExtractedMetadata;
}

interface PendingJob {
  req: ThumbRenderRequest;
  resolve: (out: RenderOutput) => void;
  reject: (err: Error) => void;
}

interface Worker {
  id: number;
  window: BrowserWindow;
  webContentsId: number;
  ready: boolean;
  jobsRendered: number;
  currentJob: PendingJob | null;
  currentTimer: NodeJS.Timeout | null;
  destroyed: boolean;
}

export interface PoolOptions {
  workerCount?: number;
  maxJobsPerWorker?: number;
  perJobTimeoutMs?: number;
}

export class ThumbPool {
  private readonly workerCount: number;
  private readonly maxJobsPerWorker: number;
  private readonly perJobTimeoutMs: number;
  private readonly workers: Worker[] = [];
  private readonly waitQueue: PendingJob[] = [];
  private nextWorkerId = 1;
  private nextJobId = 1;
  private listenersBound = false;
  private shuttingDown = false;

  constructor(opts: PoolOptions = {}) {
    this.workerCount = opts.workerCount ?? 2;
    this.maxJobsPerWorker = opts.maxJobsPerWorker ?? 50;
    this.perJobTimeoutMs = opts.perJobTimeoutMs ?? 30_000;
  }

  /** Lazily start the pool on the first render request. */
  private ensureStarted(): void {
    if (!this.listenersBound) {
      this.bindIpc();
      this.listenersBound = true;
    }
    while (this.workers.length < this.workerCount && !this.shuttingDown) {
      this.spawnWorker();
    }
  }

  render(input: {
    absPath: string;
    ext: string;
    lightingStyle?: LightingStyle;
    orientation?: FileOrientation;
  }): Promise<RenderOutput> {
    if (this.shuttingDown) {
      return Promise.reject(new Error(POOL_SHUTDOWN_ERROR));
    }
    this.ensureStarted();
    const req: ThumbRenderRequest = { jobId: this.nextJobId++, ...input };
    return new Promise<RenderOutput>((resolve, reject) => {
      const job: PendingJob = { req, resolve, reject };
      const idle = this.workers.find((w) => w.ready && w.currentJob === null && !w.destroyed);
      if (idle) this.assign(idle, job);
      else this.waitQueue.push(job);
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    while (this.waitQueue.length > 0) {
      // Reject queued-but-not-yet-assigned work with the same canonical
      // message render() uses, so the queue runner classifier treats it as
      // transient instead of persisting a fake failure.
      this.waitQueue.shift()!.reject(new Error(POOL_SHUTDOWN_ERROR));
    }
    for (const w of this.workers) this.destroyWorker(w, new Error(WORKER_SHUTDOWN_ERROR));
    this.workers.length = 0;
    if (this.listenersBound) {
      ipcMain.removeAllListeners(THUMB_WORKER_CHANNEL.ready);
      ipcMain.removeAllListeners(THUMB_WORKER_CHANNEL.result);
      this.listenersBound = false;
    }
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private bindIpc(): void {
    ipcMain.on(THUMB_WORKER_CHANNEL.ready, (event: IpcMainEvent) => {
      const w = this.workers.find((w) => w.webContentsId === event.sender.id);
      if (!w) return;
      w.ready = true;
      this.drain();
    });

    ipcMain.on(THUMB_WORKER_CHANNEL.result, (event: IpcMainEvent, result: ThumbRenderResult) => {
      const w = this.workers.find((w) => w.webContentsId === event.sender.id);
      if (!w || !w.currentJob) return;
      const job = w.currentJob;
      this.clearJobTimer(w);
      w.currentJob = null;
      w.jobsRendered = result.jobsRendered;

      if (result.jobId !== job.req.jobId) {
        // Out-of-order result — shouldn't happen since one job at a time per worker,
        // but defensive: reject the assigned job and continue.
        job.reject(new Error(`Worker returned wrong jobId (${result.jobId})`));
      } else if (result.ok) {
        job.resolve({ png: result.png, metadata: result.metadata });
      } else {
        job.reject(new Error(result.error));
      }

      // Recycle the worker if it has hit its lifetime cap.
      if (w.jobsRendered >= this.maxJobsPerWorker) {
        this.recycle(w);
      } else {
        this.drain();
      }
    });
  }

  private spawnWorker(): Worker {
    const id = this.nextWorkerId++;
    // ─────────────────────────────────────────────────────────────────────
    // SECURITY: thumb-worker BrowserWindow threat model
    //
    // The worker runs with nodeIntegration:true / contextIsolation:false /
    // sandbox:false / webSecurity:false. These are normally renderer-side
    // red flags, but the worker has no user-controlled attack surface:
    //
    //  1. It only loads our own bundled `thumb-worker.html` (loadURL/
    //     loadFile below) — never arbitrary URLs and never user input.
    //  2. Its only inputs are ThumbRenderRequest messages this main process
    //     sends over IPC. The `absPath` field is always produced by
    //     `PathResolver.toAbsolute(file.relPath)` on a row this main
    //     process pulled from the library DB; `relPath` is validated for
    //     traversal segments in PathResolver, so the worker's `fs.readFile`
    //     cannot be steered outside an attached library by IPC payload.
    //  3. webSecurity is off because Three.js loaders need to follow
    //     sibling `.bin` / texture references via `file://` URLs from the
    //     model's directory — there's no remote origin in the picture.
    //  4. Untrusted file content (the 3MF zip parse) goes through the
    //     zip-safety guards in src/renderer/three/zip-safety.ts before
    //     fflate is allowed to allocate decompression buffers.
    //
    // If you ever want to accept absPath from the renderer side (drag/drop
    // import, "open this loose file" feature, etc.), validate it against
    // an attached library mount in the main process FIRST.
    // ─────────────────────────────────────────────────────────────────────
    const window = new BrowserWindow({
      show: false,
      width: 600,
      height: 600,
      backgroundColor: '#000000',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
        // The worker loads only our trusted code, so disable web security to
        // let Three.js load any external resources from the model's directory
        // (e.g., glTF + .bin + textures via file://).
        webSecurity: false,
        offscreen: false
      }
    });

    const worker: Worker = {
      id,
      window,
      webContentsId: window.webContents.id,
      ready: false,
      jobsRendered: 0,
      currentJob: null,
      currentTimer: null,
      destroyed: false
    };
    this.workers.push(worker);

    window.webContents.on('render-process-gone', (_e, details) => {
      // Detach + reject + respawn. A bad model file shouldn't take down the app.
      log.error('worker render process gone', { workerId: id, reason: details.reason });
      const err = new Error(`Worker render process exited: ${details.reason}`);
      this.destroyWorker(worker, err);
      const idx = this.workers.indexOf(worker);
      if (idx >= 0) this.workers.splice(idx, 1);
      if (!this.shuttingDown) this.spawnWorker();
      this.drain();
    });

    // Surface worker-side console output and load failures in the main
    // process log. Without this, breakage inside the hidden BrowserWindow
    // (e.g. an unresolved import in dev mode) is silent — jobs just sit in
    // the wait queue forever with nothing in any visible log.
    window.webContents.on('did-fail-load', (_e, code, description, url) => {
      log.error('worker did-fail-load', { workerId: id, code, description, url });
    });
    window.webContents.on(
      'console-message',
      // Older signature: (event, level, message, line, sourceId). Cast the
      // any-typed handler so this compiles across Electron versions.
      ((_e: unknown, level: number, message: string, line: number, sourceId: string) => {
        // Ignore electron-log's own renderer-side output. Worker code that logs
        // via `electron-log/renderer` already reaches main through the dedicated
        // log IPC channel, so re-capturing its console print here would only
        // duplicate it — and feed a potential feedback loop. This bridge exists
        // solely to surface raw breakage that bypasses electron-log (unresolved
        // imports, Three.js console errors, etc.).
        if (sourceId.includes('electron-log')) return;
        const sink = level >= 2 ? log.warn : log.info;
        sink(`[worker ${id}] ${message}`, { sourceId, line });
      }) as never
    );

    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      const base = process.env.ELECTRON_RENDERER_URL.replace(/\/$/, '');
      void window.loadURL(`${base}/thumb-worker.html`);
    } else {
      void window.loadFile(join(__dirname, '../renderer/thumb-worker.html'));
    }

    return worker;
  }

  private assign(worker: Worker, job: PendingJob): void {
    worker.currentJob = job;
    worker.currentTimer = setTimeout(() => {
      // Timed out — assume worker is wedged. Recycle it.
      const stuckJob = worker.currentJob;
      worker.currentJob = null;
      worker.currentTimer = null;
      log.warn('worker render timeout', {
        workerId: worker.id,
        jobId: stuckJob?.req.jobId,
        absPath: stuckJob?.req.absPath,
        timeoutMs: this.perJobTimeoutMs
      });
      if (stuckJob) stuckJob.reject(new Error(`Render timed out after ${this.perJobTimeoutMs}ms`));
      this.recycle(worker);
    }, this.perJobTimeoutMs);
    worker.window.webContents.send(THUMB_WORKER_CHANNEL.render, job.req);
  }

  private clearJobTimer(worker: Worker): void {
    if (worker.currentTimer) {
      clearTimeout(worker.currentTimer);
      worker.currentTimer = null;
    }
  }

  /** Drain the wait queue onto any idle ready workers. */
  private drain(): void {
    if (this.shuttingDown) return;
    for (const w of this.workers) {
      if (w.destroyed || !w.ready || w.currentJob) continue;
      const next = this.waitQueue.shift();
      if (!next) break;
      this.assign(w, next);
    }
  }

  private recycle(worker: Worker): void {
    if (this.shuttingDown) {
      this.destroyWorker(worker, new Error(WORKER_SHUTDOWN_ERROR));
      return;
    }
    log.info('recycling worker', { workerId: worker.id, jobsRendered: worker.jobsRendered });
    this.destroyWorker(worker, new Error('recycle'));
    const idx = this.workers.indexOf(worker);
    if (idx >= 0) this.workers.splice(idx, 1);
    this.spawnWorker();
    this.drain();
  }

  private destroyWorker(worker: Worker, err: Error): void {
    if (worker.destroyed) return;
    worker.destroyed = true;
    this.clearJobTimer(worker);
    if (worker.currentJob) {
      const job = worker.currentJob;
      worker.currentJob = null;
      job.reject(err);
    }
    if (!worker.window.isDestroyed()) {
      try {
        worker.window.destroy();
      } catch {
        // best-effort
      }
    }
  }
}

export const thumbPool = new ThumbPool();
