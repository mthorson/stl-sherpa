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
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/**
 * Copy `<libraryRoot>/.meshFlask.db` into a timestamped slot under
 * `.meshFlask/backups/`, then prune the directory to the `keep` most recent.
 * Filename layout: `meshFlask-YYYYMMDD-HHmmss.db` (sortable as strings).
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

    const dest = join(dir, FILE_PREFIX + timestampForFilename(new Date()) + FILE_SUFFIX);
    copyFileSync(src, dest);
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
      log.debug('pruned old backup', { name });
    } catch (err) {
      log.warn('prune failed', { name, err: (err as Error).message });
    }
  }
}

// Exported for tests
export const __test = { BACKUPS_DIR, FILE_PREFIX, FILE_SUFFIX, timestampForFilename };
