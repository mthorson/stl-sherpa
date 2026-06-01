/**
 * Centralized logger for the main process. Subsystems pull a scoped child
 * via `scopedLogger('scanner' | 'db' | 'ipc' | ...)`.
 *
 * Logs land at `app.getPath('userData')/logs/main.log` so they sit next to
 * `preferences.json` and `libraries.json` (the same per-machine app-data
 * folder users already know about). The file transport rotates by size:
 * each file caps at 5 MB, electron-log keeps the previous file as
 * `main.old.log`, so disk usage is bounded at ~10 MB total per machine.
 */
import log from 'electron-log/main';
import { app, shell } from 'electron';
import { join } from 'node:path';
import type { LogLevel } from '@shared/preferences';

export { LOG_LEVELS, isLogLevel, type LogLevel } from '@shared/preferences';
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

function logsDir(): string {
  return join(app.getPath('userData'), 'logs');
}

export function initLogger(initialLevel: LogLevel = DEFAULT_LOG_LEVEL): void {
  log.transports.file.resolvePathFn = () => join(logsDir(), 'main.log');
  log.transports.file.maxSize = 5 * 1024 * 1024;
  log.transports.file.level = initialLevel;
  log.transports.console.level = initialLevel;
  // Disable the main→renderer broadcast transport. In dev electron-log
  // defaults this to 'silly', which echoes every main-process log into every
  // renderer's console. Combined with the thumb-pool's `console-message`
  // bridge (which re-logs worker console output through main), that echo
  // forms an infinite feedback loop: main log → renderer console → captured
  // by the bridge → main log → … We only forward renderer→main, never the
  // reverse, so this transport has no use here.
  log.transports.ipc.level = false;
  // `initialize` is what makes the renderer-side `electron-log/renderer`
  // import work — it registers the IPC handlers that receive forwarded
  // log entries from any renderer process (including thumb workers).
  log.initialize();
}

export function setLogLevel(level: LogLevel): void {
  log.transports.file.level = level;
  log.transports.console.level = level;
  // `ipc` (main→renderer broadcast) stays disabled — see initLogger.
}

export function getLogsDir(): string {
  return logsDir();
}

export async function openLogsFolder(): Promise<void> {
  await shell.openPath(logsDir());
}

export const logger = log;
export const scopedLogger = (scope: string) => log.scope(scope);
