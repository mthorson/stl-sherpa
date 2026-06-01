import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, utimesSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { PathResolver } from '@shared/paths';
import { createFilesRepo, type FilesRepo, type UpsertInput, type RenameEntry } from '@main/db/repos/files';
import { freshDb } from '@main/db/test-utils';
import { walkLibrary } from '../walker';
import { runIntegration } from './gate';
import { createLibraryHarness, type LibraryHarness } from './harness';

/**
 * End-to-end scan behavior against a real temp library: the two-pass diff that
 * service.ts performs (walk → classify into matched/new/stale → rename-detect →
 * apply) is exercised here against actual files on disk. We re-run the same
 * classification the service uses rather than the ScannerService singleton so
 * the assertions stay deterministic (no auto-started watcher / timers).
 */
interface ScanResult {
  inserted: number;
  updated: number;
  renamed: number;
  removed: number;
  filesSeen: number;
}

async function runScan(resolver: PathResolver, files: FilesRepo): Promise<ScanResult> {
  const seen: UpsertInput[] = [];
  await walkLibrary(resolver, {
    batchSize: 500,
    onBatch: (batch) => {
      seen.push(...batch);
    }
  });

  const known = files.listAllForDiff();
  const knownByPath = new Map(known.map((k) => [k.relPath, k] as const));

  const matched: UpsertInput[] = [];
  const newPaths: UpsertInput[] = [];
  for (const s of seen) {
    const k = knownByPath.get(s.relPath);
    if (k) {
      matched.push(s);
      knownByPath.delete(s.relPath);
    } else {
      newPaths.push(s);
    }
  }
  const stale = [...knownByPath.values()];

  const staleBySig = new Map<string, typeof stale>();
  for (const s of stale) {
    const key = `${s.sizeBytes}:${s.mtimeMs}`;
    const list = staleBySig.get(key);
    if (list) list.push(s);
    else staleBySig.set(key, [s]);
  }

  const renames: RenameEntry[] = [];
  const trueInserts: UpsertInput[] = [];
  for (const np of newPaths) {
    const key = `${np.sizeBytes}:${np.mtimeMs}`;
    const candidates = staleBySig.get(key);
    if (candidates && candidates.length === 1) {
      renames.push({
        id: candidates[0].id,
        toRelPath: np.relPath,
        toParentDir: np.parentDir,
        toFilename: np.filename
      });
      staleBySig.delete(key);
    } else {
      trueInserts.push(np);
    }
  }
  const toDelete = [...staleBySig.values()].flat().map((s) => s.relPath);

  const renamed = files.applyRenames(renames);
  const upsert = files.upsertMany([...matched, ...trueInserts]);
  const removed = files.deleteByRelPaths(toDelete);

  return {
    inserted: upsert.inserted,
    updated: upsert.updated,
    renamed,
    removed,
    filesSeen: seen.length
  };
}

describe.runIf(runIntegration)('scanner integration: real temp library', () => {
  let harness: LibraryHarness;
  let db: Database.Database;
  let files: FilesRepo;
  let resolver: PathResolver;

  beforeEach(() => {
    harness = createLibraryHarness('meshflask-scan-it-');
    db = freshDb();
    files = createFilesRepo(db, 'integration-library');
    resolver = new PathResolver(harness.root);
  });

  afterEach(() => {
    db.close();
    harness.dispose();
  });

  it('inserts real files on first scan, no-ops on a clean rescan', async () => {
    harness.writeStl('a.stl', { triangles: 4, seed: 1 });
    harness.writeStl('parts/b.stl', { triangles: 8, seed: 2 });
    harness.write3mf('models/c.3mf', { title: 'C' });

    const first = await runScan(resolver, files);
    expect(first.inserted).toBe(3);
    expect(first.renamed).toBe(0);
    expect(first.removed).toBe(0);
    expect(files.count()).toBe(3);

    const second = await runScan(resolver, files);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.renamed).toBe(0);
    expect(second.removed).toBe(0);
    expect(files.count()).toBe(3);
  });

  it('detects a rename within a directory, preserving the file id', async () => {
    harness.writeStl('hero.stl', { triangles: 16, seed: 7 });
    await runScan(resolver, files);
    const before = files.getByRelPath('hero.stl');
    expect(before).not.toBeNull();

    harness.move('hero.stl', 'champion.stl');
    const result = await runScan(resolver, files);

    expect(result.renamed).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.removed).toBe(0);
    expect(files.getByRelPath('hero.stl')).toBeNull();
    const after = files.getByRelPath('champion.stl');
    expect(after).not.toBeNull();
    // Same row (id/thumb/tags) carried across the rename.
    expect(after!.id).toBe(before!.id);
  });

  it('detects a move across directories', async () => {
    harness.writeStl('inbox/widget.stl', { triangles: 12, seed: 3 });
    await runScan(resolver, files);
    const before = files.getByRelPath('inbox/widget.stl')!;

    harness.move('inbox/widget.stl', 'sorted/gadgets/widget.stl');
    const result = await runScan(resolver, files);

    expect(result.renamed).toBe(1);
    expect(result.removed).toBe(0);
    const after = files.getByRelPath('sorted/gadgets/widget.stl');
    expect(after).not.toBeNull();
    expect(after!.id).toBe(before.id);
    expect(after!.parentDir).toBe('sorted/gadgets');
  });

  it('treats ambiguous identical-signature files as insert+delete, not a rename', async () => {
    // Two byte-identical files share a (size, mtime) signature, so the rename
    // detector cannot uniquely pair them and must fall back to insert/delete.
    harness.writeStl('dup-a.stl', { triangles: 6, seed: 9 });
    harness.writeRaw('dup-b.stl', readBack(harness, 'dup-a.stl'));
    // Force identical mtimes so the signatures collide.
    sameMtime(harness, ['dup-a.stl', 'dup-b.stl']);
    await runScan(resolver, files);
    expect(files.count()).toBe(2);

    harness.remove('dup-a.stl');
    harness.move('dup-b.stl', 'dup-c.stl');
    const result = await runScan(resolver, files);

    // dup-c collides in signature with the now-stale dup-a AND dup-b, so it is
    // ambiguous → not a rename. End state: only dup-c remains.
    expect(result.renamed).toBe(0);
    expect(files.getByRelPath('dup-c.stl')).not.toBeNull();
    expect(files.count()).toBe(1);
  });

  it('handles duplicate content at distinct paths as two independent rows', async () => {
    harness.writeStl('left/model.stl', { triangles: 10, seed: 4 });
    harness.writeRaw('right/model.stl', readBack(harness, 'left/model.stl'));
    const result = await runScan(resolver, files);
    expect(result.inserted).toBe(2);
    expect(files.getByRelPath('left/model.stl')).not.toBeNull();
    expect(files.getByRelPath('right/model.stl')).not.toBeNull();
  });

  it('resumes correctly after an interrupted (partial) first scan', async () => {
    harness.writeStl('one.stl', { triangles: 4, seed: 11 });
    harness.writeStl('two.stl', { triangles: 5, seed: 12 });
    harness.writeStl('three.stl', { triangles: 6, seed: 13 });

    // Simulate a scan that crashed mid-flush: only the first batch made it into
    // the DB. We persist a partial set, then a clean rescan must reconcile.
    const partial: UpsertInput[] = [];
    await walkLibrary(resolver, {
      batchSize: 1,
      onBatch: (batch) => {
        if (partial.length < 1) {
          files.upsertMany(batch);
          partial.push(...batch);
        }
      }
    });
    expect(files.count()).toBe(1);

    // Resume: a full scan picks up the rest without duplicating the persisted row.
    const result = await runScan(resolver, files);
    expect(files.count()).toBe(3);
    // The one already-persisted file is unchanged; the other two are inserted.
    expect(result.inserted).toBe(2);
    expect(result.removed).toBe(0);
    expect(result.renamed).toBe(0);
  });

  it('detects deletes when files disappear between scans', async () => {
    harness.writeStl('keep.stl', { triangles: 4, seed: 21 });
    harness.writeStl('gone.stl', { triangles: 9, seed: 22 });
    await runScan(resolver, files);
    expect(files.count()).toBe(2);

    harness.remove('gone.stl');
    const result = await runScan(resolver, files);
    expect(result.removed).toBe(1);
    expect(files.getByRelPath('gone.stl')).toBeNull();
    expect(files.getByRelPath('keep.stl')).not.toBeNull();
  });
});

// --- small disk helpers used only by the dup tests above ---

function readBack(harness: LibraryHarness, relPath: string): Buffer {
  return readFileSync(harness.abs(relPath));
}

function sameMtime(harness: LibraryHarness, relPaths: string[]): void {
  const when = new Date(Date.now() - 60_000);
  for (const rel of relPaths) utimesSync(harness.abs(rel), when, when);
}
