import { canRun as sqliteLoadable } from '@main/db/test-utils';

/**
 * Integration suites touch the real filesystem and the chokidar watcher, so
 * they are slower and flakier than the in-memory unit tests. They stay opt-in:
 * default `npm test` / `npm run test:full` skips them. Enable with
 *
 *   npm run test:integration            (sets MESHFLASK_INTEGRATION=1)
 *
 * or by exporting MESHFLASK_INTEGRATION=1 before any vitest invocation. (vitest
 * runs specs in worker threads with their own argv, so an env var — which it
 * propagates to workers — is the reliable switch; a CLI flag would not reach
 * here.)
 *
 * They also require a loadable better-sqlite3 (see db/test-utils), so the gate
 * folds that in — an enabled-but-unbuildable env still skips cleanly rather
 * than erroring.
 */
function flagRequested(): boolean {
  const v = process.env.MESHFLASK_INTEGRATION;
  return v === '1' || v === 'true';
}

export const runIntegration = flagRequested() && sqliteLoadable;
