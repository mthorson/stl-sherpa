/**
 * Renderer + thumb-worker logger shim. Forwards everything to the main
 * process over IPC, so entries surface in `main.log` alongside main-side
 * subsystem logs. Use `scopedLogger('viewer' | 'thumb-worker' | ...)` so
 * messages carry a subsystem tag.
 */
import log from 'electron-log/renderer';

// Main applies the user's live log level to both file and console output.
// Avoid a second, unfiltered console copy (especially in hidden workers).
log.transports.console.level = false;

export const logger = log;
export const scopedLogger = (scope: string) => log.scope(scope);
