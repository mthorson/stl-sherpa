import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { MIGRATIONS } from './connection';

// better-sqlite3 ships as a native module rebuilt against Electron's Node ABI
// by postinstall. Under system Node (plain `vitest`) the .node file won't load,
// so we require it lazily here and let suites skip cleanly via `canRun` rather
// than crashing everyone who hasn't run `npm rebuild better-sqlite3` first.
// `npm run test:full` rebuilds for Node's ABI before running and restores the
// Electron build afterwards.
const localRequire = createRequire(import.meta.url);
let ctor: typeof import('better-sqlite3') | null = null;
try {
  ctor = localRequire('better-sqlite3');
} catch {
  ctor = null;
}

export const DatabaseCtor: typeof import('better-sqlite3') | null = ctor;
export const canRun = DatabaseCtor !== null;

/**
 * Build a fresh in-memory database with the full schema applied by looping the
 * exact MIGRATIONS array used by the real connection. This is the single place
 * tests get a schema from, so a newly added migration can never be silently
 * missed by a hand-maintained copy of the SQL list.
 */
export function freshDb(): Database.Database {
  if (!DatabaseCtor) {
    throw new Error('better-sqlite3 is not loadable; gate the suite on `canRun`');
  }
  const db = new DatabaseCtor(':memory:');
  db.pragma('foreign_keys = ON');
  for (const m of MIGRATIONS) db.exec(m.sql);
  return db;
}
