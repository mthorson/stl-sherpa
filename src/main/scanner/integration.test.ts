import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
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
import migration011 from '../db/migrations/011_content_sha256.sql?raw';
import { PathResolver } from '../../shared/paths';
import { buildFolderTree } from '../../shared/folder-tree';
import { walkLibrary } from './walker';
import { createFilesRepo, type UpsertInput } from '../db/repos/files';

const TESTFILES = resolve(__dirname, '../../../testfiles');

// better-sqlite3 ships as a native module that is rebuilt against Electron's
// Node ABI by postinstall. When vitest runs under system Node the .node file
// won't load — try a require here and skip the suite cleanly when it doesn't,
// rather than failing every `npm test` for everyone who hasn't run
// `npm rebuild better-sqlite3` first. To enable this suite locally:
//   npm rebuild better-sqlite3 && npm test && npm run postinstall
const localRequire = createRequire(import.meta.url);
let DatabaseCtor: typeof import('better-sqlite3') | null = null;
try {
  DatabaseCtor = localRequire('better-sqlite3');
} catch {
  DatabaseCtor = null;
}

const canRun = existsSync(TESTFILES) && DatabaseCtor !== null;

describe.runIf(canRun)('Phase 2 backend end-to-end against testfiles/', () => {
  const Database = DatabaseCtor!;

  it('walks → upserts → produces the expected folder tree', async () => {
    const db = new Database(':memory:');
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
    db.exec(migration011);
    const files = createFilesRepo(db, 'test-library');
    const resolver = new PathResolver(TESTFILES);

    let inserted = 0;
    let updated = 0;
    await walkLibrary(resolver, {
      onBatch: (batch: UpsertInput[]) => {
        const r = files.upsertMany(batch);
        inserted += r.inserted;
        updated += r.updated;
      }
    });

    expect(inserted).toBe(6);
    expect(updated).toBe(0);
    expect(files.count()).toBe(6);

    // A second walk on unchanged files should be all 'unchanged'.
    let inserted2 = 0;
    let updated2 = 0;
    let unchanged2 = 0;
    await walkLibrary(resolver, {
      onBatch: (batch) => {
        const r = files.upsertMany(batch);
        inserted2 += r.inserted;
        updated2 += r.updated;
        unchanged2 += r.unchanged;
      }
    });
    expect(inserted2).toBe(0);
    expect(updated2).toBe(0);
    expect(unchanged2).toBe(6);

    // Folder tree: root has 1 file (.3mf), nested 'files' dir has 5 stls.
    const tree = buildFolderTree(files.listFoldersWithCounts(), 'testfiles');
    expect(tree.recursiveFileCount).toBe(6);
    expect(tree.immediateFileCount).toBe(1);

    const manticoreDir = tree.children.find((c) => c.name.startsWith('Manticore'));
    expect(manticoreDir).toBeDefined();
    expect(manticoreDir!.recursiveFileCount).toBe(5);
    expect(manticoreDir!.immediateFileCount).toBe(0);

    const filesDir = manticoreDir!.children.find((c) => c.name === 'files');
    expect(filesDir).toBeDefined();
    expect(filesDir!.immediateFileCount).toBe(5);
    expect(filesDir!.recursiveFileCount).toBe(5);

    // Files repo lists the right contents per folder.
    const rootFiles = files.listInFolder('');
    expect(rootFiles).toHaveLength(1);
    expect(rootFiles[0].filename).toBe('manticore.3mf');

    const stls = files.listInFolder('Manticore - Tabletop Miniature - 4441441/files');
    expect(stls).toHaveLength(5);
    for (const f of stls) {
      expect(f.ext).toBe('stl');
      expect(f.filename.startsWith('Manticore_01')).toBe(true);
    }

    db.close();
  });

  it('detects deletes via the seen-paths diff', async () => {
    const db = new Database(':memory:');
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
    db.exec(migration011);
    const files = createFilesRepo(db, 'test-library');
    const resolver = new PathResolver(TESTFILES);

    await walkLibrary(resolver, {
      onBatch: (batch) => {
        files.upsertMany(batch);
      }
    });
    expect(files.count()).toBe(6);

    files.upsert({
      relPath: 'gone.glb',
      parentDir: '',
      filename: 'gone.glb',
      ext: 'glb',
      sizeBytes: 100,
      mtimeMs: Date.now()
    });
    expect(files.count()).toBe(7);

    const { seenRelPaths } = await walkLibrary(resolver);
    const stale = files.listAllRelPaths().filter((p) => !seenRelPaths.has(p));
    expect(stale).toEqual(['gone.glb']);
    const removed = files.deleteByRelPaths(stale);
    expect(removed).toBe(1);
    expect(files.count()).toBe(6);

    db.close();
  });
});
