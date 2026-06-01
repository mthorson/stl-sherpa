import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { looksLikeNetworkMount } from '@shared/paths';
import { scopedLogger } from '@main/logger';
import migration001 from './migrations/001_init.sql?raw';
import migration002 from './migrations/002_fts_triggers.sql?raw';
import migration003 from './migrations/003_thumb_errors.sql?raw';
import migration004 from './migrations/004_file_orientation.sql?raw';
import migration005 from './migrations/005_collections.sql?raw';
import migration006 from './migrations/006_ratings_labels.sql?raw';
import migration007 from './migrations/007_smart_collections.sql?raw';
import migration008 from './migrations/008_notes.sql?raw';
import migration009 from './migrations/009_hierarchical_tags.sql?raw';
import migration010 from './migrations/010_file_camera.sql?raw';

export const SCHEMA_VERSION = 10;
export const DB_FILENAME = '.meshFlask.db';

const log = scopedLogger('db');

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  { version: 1, sql: migration001 },
  { version: 2, sql: migration002 },
  { version: 3, sql: migration003 },
  { version: 4, sql: migration004 },
  { version: 5, sql: migration005 },
  { version: 6, sql: migration006 },
  { version: 7, sql: migration007 },
  { version: 8, sql: migration008 },
  { version: 9, sql: migration009 },
  { version: 10, sql: migration010 }
];

/**
 * SQLite's user_version pragma is the source of truth for the applied
 * schema. The `library.schema_version` column is left for human inspection
 * but is not authoritative. Phase 1/2/3 DBs were created without setting
 * user_version, so we detect them as "baseline 1" via the presence of the
 * `library` table before applying any pending migrations.
 */
function readUserVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

function setUserVersion(db: Database.Database, v: number): void {
  db.pragma(`user_version = ${v}`);
}

function detectBaseline(db: Database.Database): number {
  const current = readUserVersion(db);
  if (current > 0) return current;
  // user_version == 0 either means brand-new DB or a Phase 1/2/3 DB that
  // pre-dates the migration runner.
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='library' LIMIT 1`)
    .get() as { name: string } | undefined;
  if (row) {
    setUserVersion(db, 1);
    return 1;
  }
  return 0;
}

function applyMigrations(db: Database.Database): void {
  const baseline = detectBaseline(db);
  for (const m of MIGRATIONS) {
    if (baseline >= m.version) continue;
    try {
      const tx = db.transaction(() => {
        db.exec(m.sql);
        setUserVersion(db, m.version);
        // Keep library.schema_version in lock-step for human inspection if the
        // table exists at this point.
        const hasLib = db
          .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='library' LIMIT 1`)
          .get();
        if (hasLib) {
          db.prepare('UPDATE library SET schema_version = ?').run(m.version);
        }
      });
      tx();
      log.info('migration applied', { version: m.version });
    } catch (err) {
      log.error('migration failed', { version: m.version, err: (err as Error).message });
      throw err;
    }
  }
}

export function openLibraryDatabase(libraryRoot: string): Database.Database {
  const dbPath = join(libraryRoot, DB_FILENAME);
  const isNew = !existsSync(dbPath);
  const db = new Database(dbPath);

  // SQLite WAL is unsafe over network mounts; fall back to TRUNCATE there.
  // foreign_keys is per-connection and must be re-enabled every open.
  const journalMode = looksLikeNetworkMount(libraryRoot) ? 'TRUNCATE' : 'WAL';
  db.pragma(`journal_mode = ${journalMode}`);
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  applyMigrations(db);
  void isNew;
  return db;
}

export function readLibraryRow(db: Database.Database): { id: string; name: string } | null {
  return db.prepare('SELECT id, name FROM library LIMIT 1').get() as
    | { id: string; name: string }
    | null;
}

export function insertLibraryRow(
  db: Database.Database,
  args: { id: string; name: string }
): void {
  db.prepare(
    'INSERT INTO library (id, name, schema_version, created_at) VALUES (?, ?, ?, ?)'
  ).run(args.id, args.name, SCHEMA_VERSION, Date.now());
}

/**
 * `PRAGMA integrity_check` returns one row with value `'ok'` when the DB is
 * healthy, or one or more rows describing errors. We collapse multi-row
 * failures to the first error so the notification stays terse.
 */
export function runIntegrityCheck(db: Database.Database): { ok: true } | { ok: false; error: string } {
  const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  if (rows.length === 1 && rows[0].integrity_check === 'ok') return { ok: true };
  const first = rows[0]?.integrity_check ?? 'unknown error';
  const more = rows.length > 1 ? ` (+${rows.length - 1} more)` : '';
  return { ok: false, error: first + more };
}
