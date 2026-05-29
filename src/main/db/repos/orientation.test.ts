import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import migration001 from '../migrations/001_init.sql?raw';
import migration002 from '../migrations/002_fts_triggers.sql?raw';
import migration003 from '../migrations/003_thumb_errors.sql?raw';
import migration004 from '../migrations/004_file_orientation.sql?raw';
import migration005 from '../migrations/005_collections.sql?raw';
import migration006 from '../migrations/006_ratings_labels.sql?raw';
import migration007 from '../migrations/007_smart_collections.sql?raw';
import migration008 from '../migrations/008_notes.sql?raw';
import migration009 from '../migrations/009_hierarchical_tags.sql?raw';
import migration010 from '../migrations/010_file_camera.sql?raw';
import { createFilesRepo } from './files';

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
  db.pragma('foreign_keys = ON');
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

describe.runIf(canRun)('orientation: default per format + user override', () => {
  it('STL and 3MF default to +Z up; GLB defaults to +Y up', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'test-library');
    files.upsertMany([
      { relPath: 'a.stl', parentDir: '', filename: 'a.stl', ext: 'stl', sizeBytes: 1, mtimeMs: 1 },
      { relPath: 'b.3mf', parentDir: '', filename: 'b.3mf', ext: '3mf', sizeBytes: 1, mtimeMs: 2 },
      { relPath: 'c.glb', parentDir: '', filename: 'c.glb', ext: 'glb', sizeBytes: 1, mtimeMs: 3 }
    ]);
    const a = files.getByRelPath('a.stl')!;
    const b = files.getByRelPath('b.3mf')!;
    const c = files.getByRelPath('c.glb')!;
    expect(a.orientation.upAxis).toBe('+Z');
    expect(a.orientationCustomized).toBe(false);
    expect(b.orientation.upAxis).toBe('+Z');
    expect(c.orientation.upAxis).toBe('+Y');
    db.close();
  });

  it('setOrientation persists override; clear restores format default', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'test-library');
    files.upsert({
      relPath: 'a.stl',
      parentDir: '',
      filename: 'a.stl',
      ext: 'stl',
      sizeBytes: 1,
      mtimeMs: 1
    });
    const id = files.getByRelPath('a.stl')!.id;

    files.setOrientation(id, { upAxis: '-Y' });
    const after = files.getByRelPath('a.stl')!;
    expect(after.orientation.upAxis).toBe('-Y');
    expect(after.orientationCustomized).toBe(true);

    files.setOrientation(id, null);
    const reset = files.getByRelPath('a.stl')!;
    expect(reset.orientation.upAxis).toBe('+Z'); // format default
    expect(reset.orientationCustomized).toBe(false);
    db.close();
  });

  it('round-trips yaw alongside upAxis', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'test-library');
    files.upsert({
      relPath: 'a.stl',
      parentDir: '',
      filename: 'a.stl',
      ext: 'stl',
      sizeBytes: 1,
      mtimeMs: 1
    });
    const id = files.getByRelPath('a.stl')!.id;

    files.setOrientation(id, { upAxis: '+Z', yaw: 90 });
    const after = files.getByRelPath('a.stl')!;
    expect(after.orientation.upAxis).toBe('+Z');
    expect(after.orientation.yaw).toBe(90);
    expect(after.orientationCustomized).toBe(true);
    db.close();
  });

  it('listInFolder includes the effective orientation', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'test-library');
    files.upsertMany([
      { relPath: 'x.stl', parentDir: 'sub', filename: 'x.stl', ext: 'stl', sizeBytes: 1, mtimeMs: 1 },
      { relPath: 'y.glb', parentDir: 'sub', filename: 'y.glb', ext: 'glb', sizeBytes: 1, mtimeMs: 2 }
    ]);
    files.setOrientation(files.getByRelPath('y.glb')!.id, { upAxis: '+Z' });
    const list = files.listInFolder('sub');
    const x = list.find((f) => f.filename === 'x.stl')!;
    const y = list.find((f) => f.filename === 'y.glb')!;
    expect(x.orientation.upAxis).toBe('+Z'); // default for stl
    expect(x.orientationCustomized).toBe(false);
    expect(y.orientation.upAxis).toBe('+Z'); // user override
    expect(y.orientationCustomized).toBe(true);
    db.close();
  });
});
