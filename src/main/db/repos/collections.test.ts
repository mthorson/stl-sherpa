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
import { createCollectionsRepo } from './collections';

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

describe.runIf(canRun)('CollectionsRepo', () => {
  it('creates a collection with trimmed name and timestamps', () => {
    const db = freshDb();
    const repo = createCollectionsRepo(db);
    const c = repo.create('  Print Batch  ');
    expect(c.name).toBe('Print Batch');
    expect(c.id).toBeGreaterThan(0);
    expect(c.createdAt).toBeGreaterThan(0);
    expect(repo.list()).toHaveLength(1);
    db.close();
  });

  it('rejects empty name on create and rename', () => {
    const db = freshDb();
    const repo = createCollectionsRepo(db);
    expect(() => repo.create('   ')).toThrow();
    const c = repo.create('ok');
    expect(() => repo.rename(c.id, '')).toThrow();
    db.close();
  });

  it('enforces case-insensitive unique names', () => {
    const db = freshDb();
    const repo = createCollectionsRepo(db);
    repo.create('Tuesday');
    expect(() => repo.create('tuesday')).toThrow();
    db.close();
  });

  it('renames and updates updated_at', () => {
    const db = freshDb();
    const repo = createCollectionsRepo(db);
    const c = repo.create('old');
    const renamed = repo.rename(c.id, 'new')!;
    expect(renamed.name).toBe('new');
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(c.updatedAt);
    db.close();
  });

  it('addFiles appends with sequential positions and skips duplicates', () => {
    const db = freshDb();
    const files = seedFiles(db);
    const repo = createCollectionsRepo(db);
    const c = repo.create('batch');
    const ids = files.query({}).map((f) => f.id);
    expect(repo.addFiles(c.id, ids)).toBe(3);
    expect(repo.listFileIds(c.id)).toEqual(ids);
    // Re-adding the first two should be a no-op
    expect(repo.addFiles(c.id, ids.slice(0, 2))).toBe(0);
    expect(repo.listFileIds(c.id)).toEqual(ids);
    db.close();
  });

  it('listWithCounts reflects membership', () => {
    const db = freshDb();
    const files = seedFiles(db);
    const repo = createCollectionsRepo(db);
    const c = repo.create('partial');
    repo.addFiles(c.id, files.query({}).slice(0, 2).map((f) => f.id));
    const list = repo.listWithCounts();
    expect(list).toHaveLength(1);
    expect(list[0].fileCount).toBe(2);
    db.close();
  });

  it('removeFiles deletes individual rows but leaves others', () => {
    const db = freshDb();
    const files = seedFiles(db);
    const repo = createCollectionsRepo(db);
    const c = repo.create('batch');
    const ids = files.query({}).map((f) => f.id);
    repo.addFiles(c.id, ids);
    expect(repo.removeFiles(c.id, [ids[1]])).toBe(1);
    expect(repo.listFileIds(c.id)).toEqual([ids[0], ids[2]]);
    db.close();
  });

  it('delete cascades to collection_files', () => {
    const db = freshDb();
    const files = seedFiles(db);
    const repo = createCollectionsRepo(db);
    const c = repo.create('batch');
    repo.addFiles(c.id, files.query({}).map((f) => f.id));
    repo.delete(c.id);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM collection_files').get() as { n: number };
    expect(rows.n).toBe(0);
    db.close();
  });

  it('deleting a file removes it from collections (FK cascade)', () => {
    const db = freshDb();
    const files = seedFiles(db);
    const repo = createCollectionsRepo(db);
    const c = repo.create('batch');
    const ids = files.query({}).map((f) => f.id);
    repo.addFiles(c.id, ids);
    files.deleteByRelPaths(['a.glb']);
    expect(repo.listFileIds(c.id)).toEqual(ids.slice(1));
    db.close();
  });
});
