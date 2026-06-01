import { scopedLogger } from '@main/logger';
import { broadcastLibraryEvent } from '@main/events';
import { undoQueue } from './queue';

const log = scopedLogger('undo-runner');

/**
 * Pop the most recent undo entry and execute its inverse. On success or
 * partial failure, surface the result to the renderer via a notification
 * library event so the user gets feedback.
 *
 * Returns the outcome to callers that want to plumb status into a UI
 * response (e.g. the IPC handler), but the menu-driven path is fire-and-
 * forget — it relies on the event broadcast for user feedback.
 */
export async function runUndo(): Promise<
  | { ok: false; reason: 'empty' }
  | { ok: true; label: string }
  | { ok: false; reason: 'failed'; label: string; error: string }
> {
  const entry = undoQueue.pop();
  if (!entry) {
    log.debug('undo: queue empty');
    return { ok: false, reason: 'empty' };
  }
  log.info('undo: running', { label: entry.label, libraryId: entry.libraryId });
  let result: { ok: true } | { ok: false; error: string };
  try {
    result = await entry.undo();
  } catch (err) {
    result = { ok: false, error: (err as Error).message };
  }
  if (result.ok) {
    broadcastLibraryEvent({
      kind: 'undo-completed',
      libraryId: entry.libraryId,
      label: entry.label
    });
    return { ok: true, label: entry.label };
  }
  log.warn('undo: failed', { label: entry.label, err: result.error });
  broadcastLibraryEvent({
    kind: 'undo-failed',
    libraryId: entry.libraryId,
    label: entry.label,
    error: result.error
  });
  return { ok: false, reason: 'failed', label: entry.label, error: result.error };
}
