import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DB_FILENAME } from './connection';
import { scopedLogger } from '@main/logger';

const log = scopedLogger('db-backup');

const BACKUPS_DIR = '.meshFlask/backups';
const FILE_PREFIX = 'meshFlask-';
const FILE_SUFFIX = '.db';
const DEFAULT_KEEP = 7;

function timestampForFilename(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const padMs = (n: number) => n.toString().padStart(3, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds()) +
    '-' +
    padMs(d.getMilliseconds())
  );
}

function availableDestination(dir: string, timestamp: string): string {
  const base = join(dir, FILE_PREFIX + timestamp);
  let dest = base + FILE_SUFFIX;
  let suffix = 1;
  while (existsSync(dest)) {
    dest = `${base}-${suffix++}${FILE_SUFFIX}`;
  }
  return dest;
}

/**
 * Copy `<libraryRoot>/.meshFlask.db` into a timestamped slot under
 * `.meshFlask/backups/`, then prune the directory to the `keep` most recent.
 * Filename layout: `meshFlask-YYYYMMDD-HHmmss-SSS.db` (sortable as strings).
 *
 * No-op (with debug log) when the library has no DB yet (brand-new mount) or
 * when the file is zero bytes. Failures are caught and logged — backup is a
 * defense-in-depth feature and must never block library open.
 */
export function rotateBackup(libraryRoot: string, keep: number = DEFAULT_KEEP): void {
  const src = join(libraryRoot, DB_FILENAME);
  try {
    if (!existsSync(src)) {
      log.debug('skip backup: no db yet', { libraryRoot });
      return;
    }
    const srcStat = statSync(src);
    if (srcStat.size === 0) {
      log.debug('skip backup: db is zero bytes', { libraryRoot });
      return;
    }

    const dir = join(libraryRoot, BACKUPS_DIR);
    mkdirSync(dir, { recursive: true });

    const dest = availableDestination(dir, timestampForFilename(new Date()));
    copyFileSync(src, dest);
    // A crashed session leaves unheckpointed writes in the WAL sidecar; back
    // it up alongside the main file so a restore doesn't lose them. (After a
    // clean close SQLite checkpoints and removes the WAL, so this is a no-op.)
    if (existsSync(`${src}-wal`)) {
      copyFileSync(`${src}-wal`, `${dest}-wal`);
    }
    if (existsSync(`${src}-journal`)) {
      copyFileSync(`${src}-journal`, `${dest}-journal`);
    }
    log.info('backup created', { libraryRoot, dest, bytes: srcStat.size });

    pruneOldBackups(dir, keep);
  } catch (err) {
    log.warn('backup failed', { libraryRoot, err: (err as Error).message });
  }
}

function pruneOldBackups(dir: string, keep: number): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const ours = entries
    .filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith(FILE_SUFFIX))
    .sort(); // timestamp filenames sort chronologically
  if (ours.length <= keep) return;
  const remove = ours.slice(0, ours.length - keep);
  for (const name of remove) {
    try {
      unlinkSync(join(dir, name));
      // Remove the WAL sidecar (if any) along with its backup.
      const wal = join(dir, `${name}-wal`);
      if (existsSync(wal)) unlinkSync(wal);
      const journal = join(dir, `${name}-journal`);
      if (existsSync(journal)) unlinkSync(journal);
      log.debug('pruned old backup', { name });
    } catch (err) {
      log.warn('prune failed', { name, err: (err as Error).message });
    }
  }
}

// Exported for tests
export const __test = { BACKUPS_DIR, FILE_PREFIX, FILE_SUFFIX, timestampForFilename };
