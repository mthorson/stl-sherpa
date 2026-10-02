/**
 * IPC contract between the main-process worker pool and the hidden render
 * BrowserWindow. Lives in shared so both ends import the same types and
 * channel constants.
 */
import type { ExtractedMetadata } from './types';
import type { LightingStyle } from './lighting-types';
import type { FileOrientation } from './orientation';

export const THUMB_WORKER_CHANNEL = {
  ready: 'thumb-worker:ready',
  render: 'thumb-worker:render',
  result: 'thumb-worker:result'
} as const;

export const THUMB_WORKER_RENDER_SIZE = 512;

export interface ThumbRenderRequest {
  jobId: number;
  /** File identity resolved through the same checked protocol as the live viewer. */
  libraryId: string;
  fileId: number;
  ext: string;
  /** Optional lighting preset; falls back to default if omitted. */
  lightingStyle?: LightingStyle;
  /** Optional orientation override; falls back to format default if omitted. */
  orientation?: FileOrientation;
}

export type ThumbRenderResult =
  | {
      jobId: number;
      ok: true;
      png: Uint8Array;
      metadata: ExtractedMetadata;
      jobsRendered: number;
    }
  | { jobId: number; ok: false; error: string; jobsRendered: number };

export interface ThumbWorkerApi {
  onRender(handler: (request: ThumbRenderRequest) => void): void;
  ready(): void;
  result(result: ThumbRenderResult): void;
}
