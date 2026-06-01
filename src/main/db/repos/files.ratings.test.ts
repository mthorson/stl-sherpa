import { describe, expect, it } from 'vitest';
import { canRun, freshDb } from '../test-utils';
import { createFilesRepo } from './files';

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
