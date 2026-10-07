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
 * Queue an event that fired before any renderer could hear it (e.g. an
 * integrity check during startup). The renderer PULLS these via the
 * drainPendingEvents IPC right after it subscribes — pushing them on
 * did-finish-load raced React's subscription and could lose them.
 */
const pending: LibraryFilesEvent[] = [];

export function drainPendingEvents(): LibraryFilesEvent[] {
  return pending.splice(0, pending.length);
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
