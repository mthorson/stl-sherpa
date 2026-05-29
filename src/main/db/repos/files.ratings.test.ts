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

function seedFiles(db: ReturnType<typeof freshDb>) {
  const files = createFilesRepo(db, 'test-library');
  files.upsertMany([
    { relPath: 'a.glb', parentDir: '', filename: 'a.glb', ext: 'glb', sizeBytes: 1, mtimeMs: 1 },
    { relPath: 'b.glb', parentDir: '', filename: 'b.glb', ext: 'glb', sizeBytes: 2, mtimeMs: 2 },
    { relPath: 'c.stl', parentDir: '', filename: 'c.stl', ext: 'stl', sizeBytes: 3, mtimeMs: 3 }
  ]);
  return files;
}

describe.runIf(canRun)('files ratings + color labels', () => {
  it('defaults rating to 0 and color_label to null for new files', () => {
    const db = freshDb();
    const files = seedFiles(db);
    const all = files.query({});
    for (const f of all) {
      expect(f.rating).toBe(0);
      expect(f.colorLabel).toBeNull();
    }
    db.close();
  });

  it('setRatings updates many and clamps invalid values', () => {
    const db = freshDb();
    const files = seedFiles(db);
    const ids = files.query({}).map((f) => f.id);
    expect(files.setRatings(ids, 4)).toBe(3);
    for (const f of files.query({})) expect(f.rating).toBe(4);
    // Clamp out-of-range
    files.setRatings([ids[0]], 99);
    expect(files.getById(ids[0])!.rating).toBe(5);
    files.setRatings([ids[0]], -7);
    expect(files.getById(ids[0])!.rating).toBe(0);
    db.close();
  });

  it('setColorLabels writes labels and clears with null', () => {
    const db = freshDb();
    const files = seedFiles(db);
    const ids = files.query({}).map((f) => f.id);
    files.setColorLabels(ids, 'green');
    for (const f of files.query({})) expect(f.colorLabel).toBe('green');
    files.setColorLabels([ids[1]], null);
    expect(files.getById(ids[1])!.colorLabel).toBeNull();
    db.close();
  });

  it('rejects invalid color labels silently (treats as null)', () => {
    const db = freshDb();
    const files = seedFiles(db);
    const ids = files.query({}).map((f) => f.id);
    // Pass a bogus value; repo coerces to null. Use as unknown cast.
    files.setColorLabels(ids, 'chartreuse' as unknown as 'red');
    for (const f of files.query({})) expect(f.colorLabel).toBeNull();
    db.close();
  });

  it('query filters by minRating', () => {
    const db = freshDb();
    const files = seedFiles(db);
    const all = files.query({});
    files.setRatings([all[0].id], 3);
    files.setRatings([all[1].id], 5);
    expect(files.query({ minRating: 4 })).toHaveLength(1);
    expect(files.query({ minRating: 3 })).toHaveLength(2);
    expect(files.query({ minRating: 1 })).toHaveLength(2);
    expect(files.query({ minRating: 0 })).toHaveLength(3); // no filter
    db.close();
  });

  it('query filters by colorLabels', () => {
    const db = freshDb();
    const files = seedFiles(db);
    const all = files.query({});
    files.setColorLabels([all[0].id], 'red');
    files.setColorLabels([all[2].id], 'green');
    expect(files.query({ colorLabels: ['red'] })).toHaveLength(1);
    expect(files.query({ colorLabels: ['red', 'green'] })).toHaveLength(2);
    expect(files.query({ colorLabels: ['blue'] })).toHaveLength(0);
    db.close();
  });
});
