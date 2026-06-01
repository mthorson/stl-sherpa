/**
 * Renderer + thumb-worker logger shim. Forwards everything to the main
 * process over IPC, so entries surface in `main.log` alongside main-side
 * subsystem logs. Use `scopedLogger('viewer' | 'thumb-worker' | ...)` so
 * messages carry a subsystem tag.
 */
import log from 'electron-log/renderer';

export const logger = log;
export const scopedLogger = (scope: string) => log.scope(scope);
