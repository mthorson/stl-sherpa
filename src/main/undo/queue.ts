import { scopedLogger } from '@main/logger';

const log = scopedLogger('undo');

export interface UndoEntry {
  libraryId: string;
  /** Short human-readable label, e.g. "Move foo.stl". Used in the Edit menu. */
  label: string;
  /** Reverses the original operation. Returns ok/error so the menu can toast on failure. */
  undo: () => Promise<{ ok: true } | { ok: false; error: string }>;
}

export type Listener = () => void;

const MAX_ENTRIES = 50;

/**
 * Singleton in-memory undo "queue" (semantically a stack — most-recent op is
 * undone first). Bounded at MAX_ENTRIES to cap memory; older entries are
 * silently dropped when the buffer fills.
 *
 * Entries hold closures that may capture OpenLibrary handles; call
 * `clear(libraryId)` on library detach so those handles can be GC'd.
 *
 * Subscribe via `subscribe()` to rebuild the Edit menu when the top of the
 * stack changes.
 */
class UndoQueue {
  private entries: UndoEntry[] = [];
  private listeners = new Set<Listener>();

  push(entry: UndoEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
    log.debug('push', { label: entry.label, depth: this.entries.length });
    this.notify();
  }

  peek(): UndoEntry | null {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1] : null;
  }

  pop(): UndoEntry | null {
    const e = this.entries.pop() ?? null;
    if (e) {
      log.debug('pop', { label: e.label, depth: this.entries.length });
      this.notify();
    }
    return e;
  }

  /** Drop every entry tied to the given library. Called on detach. */
  clear(libraryId: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.libraryId !== libraryId);
    if (this.entries.length !== before) {
      log.debug('clear library', { libraryId, removed: before - this.entries.length });
      this.notify();
    }
  }

  /** Test-only: full reset. */
  reset(): void {
    this.entries = [];
    this.notify();
  }

  size(): number {
    return this.entries.length;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        log.warn('listener threw', { err: (err as Error).message });
      }
    }
  }
}

export const undoQueue = new UndoQueue();

export const __test = { MAX_ENTRIES };
