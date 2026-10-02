import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canRun, freshDb } from '../db/test-utils';
import { createLibraryHarness, type LibraryHarness } from './integration/harness';
import { PathResolver } from '../../shared/paths';
import { buildFolderTree } from '../../shared/folder-tree';
import { walkLibrary } from './walker';
import { createFilesRepo, type UpsertInput } from '../db/repos/files';

describe.runIf(canRun)('backend end-to-end against generated files', () => {
  let fixture: LibraryHarness;
  let TESTFILES: string;
  beforeEach(() => {
    fixture = createLibraryHarness();
    TESTFILES = fixture.root;
    fixture.write3mf('sample.3mf');
    for (let i = 0; i < 5; i++) fixture.writeStl(`Sample Collection/files/part-${i}.stl`);
  });
  afterEach(() => fixture.dispose());

  it('walks → upserts → produces the expected folder tree', async () => {
    const db = freshDb();
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

    const manticoreDir = tree.children.find((c) => c.name.startsWith('Sample'));
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
    expect(rootFiles[0].filename).toBe('sample.3mf');

    const stls = files.listInFolder('Sample Collection/files');
    expect(stls).toHaveLength(5);
    for (const f of stls) {
      expect(f.ext).toBe('stl');
      expect(f.filename.startsWith('part-')).toBe(true);
    }

    db.close();
  });

  it('detects deletes via the seen-paths diff', async () => {
    const db = freshDb();
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
