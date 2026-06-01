import { describe, expect, it } from 'vitest';
import { canRun, freshDb } from '../test-utils';
import { createFilesRepo } from './files';
import { createCollectionsRepo } from './collections';

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
