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
import { createTagsRepo } from './tags';

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

function seed(db: ReturnType<typeof freshDb>) {
  const files = createFilesRepo(db, 'test-library');
  files.upsertMany([
    {
      relPath: 'characters/hero.glb',
      parentDir: 'characters',
      filename: 'hero.glb',
      ext: 'glb',
      sizeBytes: 1024,
      mtimeMs: 1
    },
    {
      relPath: 'characters/villain.glb',
      parentDir: 'characters',
      filename: 'villain.glb',
      ext: 'glb',
      sizeBytes: 2048,
      mtimeMs: 2
    },
    {
      relPath: 'props/sword.stl',
      parentDir: 'props',
      filename: 'sword.stl',
      ext: 'stl',
      sizeBytes: 4096,
      mtimeMs: 3
    },
    {
      relPath: 'props/shield.obj',
      parentDir: 'props',
      filename: 'shield.obj',
      ext: 'obj',
      sizeBytes: 8192,
      mtimeMs: 4
    }
  ]);
  return files;
}

describe.runIf(canRun)('Phase 4: tags, FTS, query', () => {
  it('tags repo: ensure-by-name is case-insensitive get-or-create', () => {
    const db = freshDb();
    const tags = createTagsRepo(db);
    const a = tags.ensureByName('Hero');
    const b = tags.ensureByName('hero');
    expect(b.id).toBe(a.id);
    expect(tags.list()).toHaveLength(1);
    db.close();
  });

  it('FTS5 trigger picks up new files automatically', () => {
    const db = freshDb();
    const files = seed(db);
    const ftsRows = db
      .prepare(`SELECT rowid FROM files_fts WHERE files_fts MATCH 'hero*'`)
      .all() as { rowid: number }[];
    expect(ftsRows).toHaveLength(1);
    const heroId = files.getByRelPath('characters/hero.glb')!.id;
    expect(ftsRows[0].rowid).toBe(heroId);
    db.close();
  });

  it('FTS5 trigger reflects tag attachments', () => {
    const db = freshDb();
    const files = seed(db);
    const tags = createTagsRepo(db);
    const heroId = files.getByRelPath('characters/hero.glb')!.id;
    const tag = tags.ensureByName('protagonist');
    tags.addToFile(heroId, tag.id);

    const result = db
      .prepare(`SELECT rowid FROM files_fts WHERE files_fts MATCH 'protagonist*'`)
      .all() as { rowid: number }[];
    expect(result.map((r) => r.rowid)).toEqual([heroId]);

    tags.removeFromFile(heroId, tag.id);
    const after = db
      .prepare(`SELECT rowid FROM files_fts WHERE files_fts MATCH 'protagonist*'`)
      .all();
    expect(after).toEqual([]);
    db.close();
  });

  it('files.query applies extension filter', () => {
    const db = freshDb();
    const files = seed(db);
    const result = files.query({ extensions: ['glb'] });
    expect(result.map((f) => f.filename).sort()).toEqual(['hero.glb', 'villain.glb']);
    db.close();
  });

  it('files.query AND-combines tag filters', () => {
    const db = freshDb();
    const files = seed(db);
    const tags = createTagsRepo(db);
    const heroId = files.getByRelPath('characters/hero.glb')!.id;
    const villainId = files.getByRelPath('characters/villain.glb')!.id;
    const charTag = tags.ensureByName('character');
    const heroTag = tags.ensureByName('hero');
    tags.addToFile(heroId, charTag.id);
    tags.addToFile(heroId, heroTag.id);
    tags.addToFile(villainId, charTag.id);

    // Both tags required → only hero matches.
    const both = files.query({ tagIds: [charTag.id, heroTag.id] });
    expect(both.map((f) => f.filename)).toEqual(['hero.glb']);

    // Single tag → both match.
    const charOnly = files.query({ tagIds: [charTag.id] });
    expect(charOnly.map((f) => f.filename).sort()).toEqual(['hero.glb', 'villain.glb']);
    db.close();
  });

  it('files.query FTS search matches filenames and tags together', () => {
    const db = freshDb();
    const files = seed(db);
    const tags = createTagsRepo(db);
    const swordId = files.getByRelPath('props/sword.stl')!.id;
    const shieldId = files.getByRelPath('props/shield.obj')!.id;
    tags.addToFile(swordId, tags.ensureByName('legendary').id);
    tags.addToFile(shieldId, tags.ensureByName('legendary').id);

    const matches = files.query({ query: 'legend' });
    expect(matches.map((f) => f.filename).sort()).toEqual(['shield.obj', 'sword.stl']);

    // Combine search with extension filter.
    const stlOnly = files.query({ query: 'legend', extensions: ['stl'] });
    expect(stlOnly.map((f) => f.filename)).toEqual(['sword.stl']);
    db.close();
  });

  it('files.query parentDir + recursive scopes the search to a subtree', () => {
    const db = freshDb();
    const files = seed(db);
    // Add a deeper file.
    files.upsert({
      relPath: 'props/swords/longsword.stl',
      parentDir: 'props/swords',
      filename: 'longsword.stl',
      ext: 'stl',
      sizeBytes: 1234,
      mtimeMs: 5
    });

    const immediate = files.query({ parentDir: 'props', recursive: false });
    expect(immediate.map((f) => f.filename).sort()).toEqual(['shield.obj', 'sword.stl']);

    const recursive = files.query({ parentDir: 'props', recursive: true });
    expect(recursive.map((f) => f.filename).sort()).toEqual([
      'longsword.stl',
      'shield.obj',
      'sword.stl'
    ]);
    db.close();
  });

  it('files.setMetadata fires the FTS update trigger', () => {
    const db = freshDb();
    const files = seed(db);
    const heroId = files.getByRelPath('characters/hero.glb')!.id;
    files.setMetadata(
      heroId,
      JSON.stringify({ materialNames: ['SkinShader', 'EyeMaterial'] })
    );
    const matches = db
      .prepare(`SELECT rowid FROM files_fts WHERE files_fts MATCH 'SkinShader*'`)
      .all() as { rowid: number }[];
    expect(matches.map((r) => r.rowid)).toEqual([heroId]);
    db.close();
  });
});
