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
import migration011 from '../migrations/011_content_sha256.sql?raw';
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
  for (const sql of [
    migration001,
    migration002,
    migration003,
    migration004,
    migration005,
    migration006,
    migration007,
    migration008,
    migration009,
    migration010,
    migration011
  ]) {
    db.exec(sql);
  }
  return db;
}

function seed(db: ReturnType<typeof freshDb>) {
  const files = createFilesRepo(db, 'test-library');
  files.upsertMany([
    { relPath: 'a.stl', parentDir: '', filename: 'a.stl', ext: 'stl', sizeBytes: 1, mtimeMs: 1 },
    { relPath: 'sub/b.stl', parentDir: 'sub', filename: 'b.stl', ext: 'stl', sizeBytes: 1, mtimeMs: 2 },
    { relPath: 'c.stl', parentDir: '', filename: 'c.stl', ext: 'stl', sizeBytes: 9, mtimeMs: 3 },
    { relPath: 'd.glb', parentDir: '', filename: 'd.glb', ext: 'glb', sizeBytes: 4, mtimeMs: 4 }
  ]);
  return files;
}

describe.runIf(canRun)('files content_sha256 + duplicate grouping', () => {
  it('new files start with content_sha256 = null and are not flagged as dups', () => {
    const db = freshDb();
    const files = seed(db);
    for (const f of files.query({})) expect(f.contentSha256).toBeNull();
    expect(files.query({ duplicatesOnly: true })).toHaveLength(0);
    db.close();
  });

  it('listMissingContentHash returns rows lacking a hash, then shrinks as they fill', () => {
    const db = freshDb();
    const files = seed(db);
    const missing = files.listMissingContentHash();
    expect(missing).toHaveLength(4);
    const first = missing[0];
    files.setContentSha256Many([{ id: first.id, sha256: 'deadbeef' }]);
    expect(files.listMissingContentHash()).toHaveLength(3);
    expect(files.getById(first.id)!.contentSha256).toBe('deadbeef');
    db.close();
  });

  it('duplicatesOnly returns only files whose hash is shared by another file', () => {
    const db = freshDb();
    const files = seed(db);
    const byPath = new Map(files.query({}).map((f) => [f.relPath, f.id] as const));
    // a + sub/b share a hash (an exact dup across folders); c is unique; d unhashed.
    files.setContentSha256Many([
      { id: byPath.get('a.stl')!, sha256: 'AAAA' },
      { id: byPath.get('sub/b.stl')!, sha256: 'AAAA' },
      { id: byPath.get('c.stl')!, sha256: 'CCCC' }
    ]);

    const dups = files.query({ duplicatesOnly: true });
    expect(dups.map((f) => f.relPath).sort()).toEqual(['a.stl', 'sub/b.stl']);
    // Unique + unhashed files are excluded.
    expect(dups.some((f) => f.relPath === 'c.stl')).toBe(false);
    expect(dups.some((f) => f.relPath === 'd.glb')).toBe(false);
    db.close();
  });

  it('duplicate results are ordered so same-hash files are adjacent', () => {
    const db = freshDb();
    const files = seed(db);
    const byPath = new Map(files.query({}).map((f) => [f.relPath, f.id] as const));
    files.setContentSha256Many([
      { id: byPath.get('a.stl')!, sha256: 'ZZZZ' },
      { id: byPath.get('c.stl')!, sha256: 'AAAA' },
      { id: byPath.get('sub/b.stl')!, sha256: 'ZZZZ' },
      { id: byPath.get('d.glb')!, sha256: 'AAAA' }
    ]);
    const dups = files.query({ duplicatesOnly: true });
    const hashes = dups.map((f) => f.contentSha256);
    // Adjacent grouping: no hash should reappear after a different one.
    const seen = new Set<string>();
    let prev: string | null = null;
    for (const h of hashes) {
      if (h !== prev && seen.has(h!)) throw new Error('hash group not contiguous');
      seen.add(h!);
      prev = h;
    }
    expect(dups).toHaveLength(4);
    db.close();
  });

  it('changing a file content (size/mtime) clears its hash for re-hashing', () => {
    const db = freshDb();
    const files = seed(db);
    const id = files.getByRelPath('a.stl')!.id;
    files.setContentSha256Many([{ id, sha256: 'OLD' }]);
    expect(files.getById(id)!.contentSha256).toBe('OLD');
    // Re-upsert with a changed mtime → upsert clears the stale hash.
    files.upsert({
      relPath: 'a.stl',
      parentDir: '',
      filename: 'a.stl',
      ext: 'stl',
      sizeBytes: 1,
      mtimeMs: 999
    });
    expect(files.getById(id)!.contentSha256).toBeNull();
    db.close();
  });
});
