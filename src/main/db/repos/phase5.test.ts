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
import {
  RENDERER_VERSION,
  createThumbnailsRepo,
  type ThumbnailRow
} from './thumbnails';
import { createThumbErrorsRepo } from './thumb-errors';
import { createThumbJobsRepo, PRIORITY_BACKGROUND } from './thumb-jobs';
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

function freshThumb(fileId: number, mtime: number, version = RENDERER_VERSION): ThumbnailRow {
  return {
    fileId,
    thumbRelPath: `.meshFlask/thumbs/00/${fileId}.png`,
    renderedAt: 1000,
    sourceMtimeMs: mtime,
    sourceSha256: null,
    rendererVersion: version
  };
}

describe.runIf(canRun)('Phase 5: scanner rename detection (applyRenames)', () => {
  it('preserves id and thumbnail when renaming', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'test-library');
    const thumbs = createThumbnailsRepo(db);
    files.upsert({
      relPath: 'old/hero.glb',
      parentDir: 'old',
      filename: 'hero.glb',
      ext: 'glb',
      sizeBytes: 100,
      mtimeMs: 50
    });
    const oldId = files.getByRelPath('old/hero.glb')!.id;
    thumbs.upsert(freshThumb(oldId, 50));

    files.applyRenames([
      { id: oldId, toRelPath: 'new/hero.glb', toParentDir: 'new', toFilename: 'hero.glb' }
    ]);

    const renamed = files.getByRelPath('new/hero.glb');
    expect(renamed).toBeTruthy();
    expect(renamed!.id).toBe(oldId);
    expect(renamed!.parentDir).toBe('new');
    // Thumbnail row still associated with the same id.
    const thumb = thumbs.getByFileId(oldId);
    expect(thumb).toBeTruthy();
    expect(thumb!.fileId).toBe(oldId);
    db.close();
  });

  it('preserves tags through rename (foreign key on file_id, not rel_path)', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'test-library');
    const tags = createTagsRepo(db);
    files.upsert({
      relPath: 'a.stl',
      parentDir: '',
      filename: 'a.stl',
      ext: 'stl',
      sizeBytes: 1,
      mtimeMs: 1
    });
    const id = files.getByRelPath('a.stl')!.id;
    const tag = tags.ensureByName('hero');
    tags.addToFile(id, tag.id);

    files.applyRenames([
      { id, toRelPath: 'sub/b.stl', toParentDir: 'sub', toFilename: 'b.stl' }
    ]);

    const stillTagged = tags.listForFile(id);
    expect(stillTagged.map((t) => t.name)).toEqual(['hero']);
    db.close();
  });
});

describe.runIf(canRun)('Phase 5: thumbnails.findFilesNeedingThumbs honors thumb_errors', () => {
  it('skips files with a current failure, retries when source mtime changes', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'test-library');
    const thumbs = createThumbnailsRepo(db);
    const errors = createThumbErrorsRepo(db);

    files.upsert({
      relPath: 'broken.obj',
      parentDir: '',
      filename: 'broken.obj',
      ext: 'obj',
      sizeBytes: 100,
      mtimeMs: 50
    });
    const id = files.getByRelPath('broken.obj')!.id;

    // Initially needs a thumb.
    expect(thumbs.findFilesNeedingThumbs(10).map((f) => f.fileId)).toEqual([id]);

    // Record a failure at the current mtime/version.
    errors.upsert({
      fileId: id,
      error: 'parse failed',
      failedAt: Date.now(),
      attempts: 3,
      sourceMtimeMs: 50,
      rendererVersion: RENDERER_VERSION
    });

    // Reconciler should now SKIP it.
    expect(thumbs.findFilesNeedingThumbs(10)).toEqual([]);

    // Edit the file (new mtime) → eligible again.
    files.upsert({
      relPath: 'broken.obj',
      parentDir: '',
      filename: 'broken.obj',
      ext: 'obj',
      sizeBytes: 200,
      mtimeMs: 999
    });
    expect(thumbs.findFilesNeedingThumbs(10).map((f) => f.fileId)).toEqual([id]);

    db.close();
  });

  it('clearing the error makes the file eligible again immediately', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'test-library');
    const thumbs = createThumbnailsRepo(db);
    const errors = createThumbErrorsRepo(db);

    files.upsert({
      relPath: 'x.glb',
      parentDir: '',
      filename: 'x.glb',
      ext: 'glb',
      sizeBytes: 1,
      mtimeMs: 1
    });
    const id = files.getByRelPath('x.glb')!.id;
    errors.upsert({
      fileId: id,
      error: 'oops',
      failedAt: Date.now(),
      attempts: 3,
      sourceMtimeMs: 1,
      rendererVersion: RENDERER_VERSION
    });
    expect(thumbs.findFilesNeedingThumbs(10)).toEqual([]);

    errors.clear(id);
    expect(thumbs.findFilesNeedingThumbs(10).map((f) => f.fileId)).toEqual([id]);
    db.close();
  });
});

describe.runIf(canRun)('Phase 5: transient errors are not persisted', () => {
  it('thumb-errors clearWithMessages scrubs known shutdown messages', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'test-library');
    const errors = createThumbErrorsRepo(db);

    files.upsert({
      relPath: 'a.glb',
      parentDir: '',
      filename: 'a.glb',
      ext: 'glb',
      sizeBytes: 1,
      mtimeMs: 1
    });
    files.upsert({
      relPath: 'b.glb',
      parentDir: '',
      filename: 'b.glb',
      ext: 'glb',
      sizeBytes: 2,
      mtimeMs: 2
    });
    const aId = files.getByRelPath('a.glb')!.id;
    const bId = files.getByRelPath('b.glb')!.id;

    errors.upsert({
      fileId: aId,
      error: 'ThumbPool is shutting down',
      failedAt: 1,
      attempts: 3,
      sourceMtimeMs: 1,
      rendererVersion: RENDERER_VERSION
    });
    errors.upsert({
      fileId: bId,
      error: 'malformed PLY header',
      failedAt: 1,
      attempts: 3,
      sourceMtimeMs: 2,
      rendererVersion: RENDERER_VERSION
    });

    const cleared = errors.clearWithMessages([
      'ThumbPool is shutting down',
      'shutdown'
    ]);
    expect(cleared).toBe(1);
    expect(errors.getByFileId(aId)).toBeNull(); // spurious entry gone
    expect(errors.getByFileId(bId)?.error).toBe('malformed PLY header'); // real failure stays
    db.close();
  });

  it('thumb-jobs releaseForRetry rolls back the attempt counter', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'test-library');
    const jobs = createThumbJobsRepo(db);
    files.upsert({
      relPath: 'a.glb',
      parentDir: '',
      filename: 'a.glb',
      ext: 'glb',
      sizeBytes: 1,
      mtimeMs: 1
    });
    const id = files.getByRelPath('a.glb')!.id;

    jobs.enqueue(id, PRIORITY_BACKGROUND);
    const claim = jobs.claimNext('worker-1')!;
    expect(claim.attempts).toBe(1);

    jobs.releaseForRetry(claim.id);
    const reclaim = jobs.claimNext('worker-1')!;
    // attempts had become 1, releaseForRetry rolled back to 0, then reclaim
    // bumped to 1 again — so the file gets a clean retry budget.
    expect(reclaim.attempts).toBe(1);
    db.close();
  });
});

describe.runIf(canRun)('Phase 5: file query exposes thumb_error', () => {
  it('thumbError comes through on listInFolder', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'test-library');
    const errors = createThumbErrorsRepo(db);

    files.upsert({
      relPath: 'bad.ply',
      parentDir: '',
      filename: 'bad.ply',
      ext: 'ply',
      sizeBytes: 1,
      mtimeMs: 1
    });
    const id = files.getByRelPath('bad.ply')!.id;
    errors.upsert({
      fileId: id,
      error: 'malformed PLY header',
      failedAt: Date.now(),
      attempts: 3,
      sourceMtimeMs: 1,
      rendererVersion: RENDERER_VERSION
    });

    const list = files.listInFolder('');
    expect(list).toHaveLength(1);
    expect(list[0].thumbError).toBe('malformed PLY header');
    db.close();
  });
});
