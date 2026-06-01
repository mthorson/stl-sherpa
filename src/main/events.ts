import { BrowserWindow } from 'electron';
import { IPC_EVENT } from '@shared/ipc-channels';
import type { LibraryFilesEvent } from '@shared/types';

/**
 * Send a library event to every live BrowserWindow. The renderer-side handler
 * in App.tsx demultiplexes by `event.libraryId` and `event.kind`. Safe to
 * call before any window exists — it's a no-op in that case.
 */
export function broadcastLibraryEvent(event: LibraryFilesEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENT.libraryEvent, event);
  }
}

/**
 * Queue an event for the next BrowserWindow to become ready. Use when an
 * event fires before any window exists (e.g. integrity check during startup)
 * — direct broadcast would be lost. Delivered exactly once per (event)
 * registration, on the first window that finishes loading.
 */
const pending: LibraryFilesEvent[] = [];

export function deliverPendingOnReady(win: BrowserWindow): void {
  if (pending.length === 0) return;
  const drained = pending.splice(0, pending.length);
  win.webContents.once('did-finish-load', () => {
    for (const ev of drained) {
      if (!win.isDestroyed()) win.webContents.send(IPC_EVENT.libraryEvent, ev);
    }
  });
}

export function broadcastOrQueue(event: LibraryFilesEvent): void {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  if (wins.length === 0) {
    pending.push(event);
    return;
  }
  for (const win of wins) {
    win.webContents.send(IPC_EVENT.libraryEvent, event);
  }
}
