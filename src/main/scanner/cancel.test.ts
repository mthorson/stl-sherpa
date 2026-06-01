import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import migration001 from '../db/migrations/001_init.sql?raw';
import migration002 from '../db/migrations/002_fts_triggers.sql?raw';
import migration003 from '../db/migrations/003_thumb_errors.sql?raw';
import migration004 from '../db/migrations/004_file_orientation.sql?raw';
import migration005 from '../db/migrations/005_collections.sql?raw';
import migration006 from '../db/migrations/006_ratings_labels.sql?raw';
import migration007 from '../db/migrations/007_smart_collections.sql?raw';
import migration008 from '../db/migrations/008_notes.sql?raw';
import migration009 from '../db/migrations/009_hierarchical_tags.sql?raw';
import migration010 from '../db/migrations/010_file_camera.sql?raw';
import { ScannerService } from './service';
import { createFilesRepo } from '../db/repos/files';
import type { ScanProgress } from '../../shared/types';

const localRequire = createRequire(import.meta.url);
let DatabaseCtor: typeof import('better-sqlite3') | null = null;
try {
  DatabaseCtor = localRequire('better-sqlite3');
} catch {
  DatabaseCtor = null;
}

const canRun = DatabaseCtor !== null;

function freshDb() {
  const db = new DatabaseCtor!(':memory:');
  db.exec(migration001);
  db.exec(migration002);
  db.exec(migration003);
  db.exec(migration004);
  db.exec(migration005);
  db.exec(migration006);
  db.exec(migration007);
  db.exec(migration008);
  db.exec(migration009);
  db.exec(migration010);
  return db;
}

describe.runIf(canRun)('ScannerService cancellation', () => {
  let root: string;

  beforeEach(() => {
    // A small synthetic library: a handful of .stl files in a subfolder.
    root = mkdtempSync(join(tmpdir(), 'meshflask-cancel-'));
    const sub = join(root, 'parts');
    mkdirSync(sub);
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(sub, `part-${i}.stl`), `solid p${i}\nendsolid p${i}\n`);
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('cancelling a scan leaves the DB untouched and ends in cancelled state', async () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'lib-cancel');
    expect(files.count()).toBe(0);

    const scanner = new ScannerService();
    const cancelled = new Promise<ScanProgress>((resolveProgress) => {
      scanner.on('scan-cancelled', (_id, progress) => resolveProgress(progress));
    });

    // attach() kicks off the scan; it is now mid-walk (awaiting readdir).
    scanner.attach('lib-cancel', db, root);
    expect(scanner.getProgress('lib-cancel')?.state).toBe('scanning');

    // Cancel before the walk can finish. The diff is only applied after the
    // walk resolves, so an abort guarantees no rows were written.
    scanner.cancelScan('lib-cancel');

    const progress = await cancelled;
    expect(progress.state).toBe('cancelled');
    // Nothing was inserted/updated/removed — partial state is consistent.
    expect(files.count()).toBe(0);
    expect(progress.inserted).toBe(0);
    expect(progress.updated).toBe(0);
    expect(progress.removed).toBe(0);
    expect(scanner.getProgress('lib-cancel')?.state).toBe('cancelled');

    scanner.detach('lib-cancel');
    db.close();
  });
});
