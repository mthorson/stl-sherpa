import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { PathResolver } from '@shared/paths';
import { createFilesRepo, type FilesRepo } from '@main/db/repos/files';
import { freshDb } from '@main/db/test-utils';
import { startWatcher, type LibraryWatcher } from '../watcher';
import { runIntegration } from './gate';
import { createLibraryHarness, type LibraryHarness } from './harness';

/**
 * Real chokidar watcher driven against a temp library. These assert eventual
 * convergence rather than exact event timing — chokidar batches and debounces
 * (the watcher also applies awaitWriteFinish with a 750ms stability window), so
 * we poll the DB until it reaches the expected state or a generous timeout.
 *
 * startWatcher doesn't expose chokidar's `ready` event, so each test first
 * writes a sentinel file and waits for the watcher to ingest it — once that
 * lands we know the watcher is live and won't miss subsequent events.
 */
const TEST_TIMEOUT_MS = 40_000;

async function waitFor(predicate: () => boolean, timeoutMs = 12_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

describe.runIf(runIntegration)('watcher integration: live filesystem events', () => {
  let harness: LibraryHarness;
  let db: Database.Database;
  let files: FilesRepo;
  let watcher: LibraryWatcher | undefined;
  let changes: number;

  beforeEach(() => {
    harness = createLibraryHarness('meshflask-watch-it-');
    db = freshDb();
    files = createFilesRepo(db, 'integration-library');
    changes = 0;
  });

  afterEach(async () => {
    await watcher?.close();
    watcher = undefined;
    db.close();
    harness.dispose();
  });

  function start(): void {
    const resolver = new PathResolver(harness.root);
    watcher = startWatcher(resolver, files, {
      onChange: () => {
        changes++;
      }
    });
  }

  /**
   * Block until the watcher demonstrably reacts to a brand-new file. Under
   * parallel test load fsevents/inotify can take a while to arm, and an early
   * write may land before the watch is live, so we re-touch the probe a few
   * times until it is ingested rather than relying on a single write.
   */
  async function waitUntilLive(): Promise<void> {
    const probe = '__live_probe__/probe.stl';
    let live = false;
    for (let attempt = 0; attempt < 6 && !live; attempt++) {
      harness.writeStl(probe, { triangles: 2 + attempt, seed: attempt });
      live = await waitFor(() => files.getByRelPath(probe) !== null, 4000);
    }
    expect(live).toBe(true);
    // Remove the probe again and wait for the watcher to clear it so it doesn't
    // skew per-test counts.
    harness.remove(probe);
    await waitFor(() => files.getByRelPath(probe) === null);
    changes = 0;
  }

  it(
    'picks up a burst of newly added files',
    async () => {
      start();
      await waitUntilLive();

      const total = 25;
      for (let i = 0; i < total; i++) {
        harness.writeStl(`burst/file-${i}.stl`, { triangles: 4 + i, seed: i });
      }

      const ok = await waitFor(() => files.count() === total);
      expect(ok).toBe(true);
      expect(files.count()).toBe(total);
      expect(changes).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'treats a quick unlink+add of the same content as a rename (id preserved)',
    async () => {
      harness.writeStl('orig.stl', { triangles: 20, seed: 99 });
      files.upsert({
        relPath: 'orig.stl',
        parentDir: '',
        filename: 'orig.stl',
        ext: 'stl',
        sizeBytes: readSize(harness, 'orig.stl'),
        mtimeMs: readMtime(harness, 'orig.stl')
      });
      const before = files.getByRelPath('orig.stl')!;

      start();
      await waitUntilLive();

      harness.move('orig.stl', 'renamed.stl');

      const ok = await waitFor(() => files.getByRelPath('renamed.stl') !== null);
      expect(ok).toBe(true);
      const after = files.getByRelPath('renamed.stl');
      expect(after).not.toBeNull();
      // id preserved → the unlink/add pair was reconciled as a rename, keeping
      // the file's thumbnail and tags rather than orphaning them.
      expect(after!.id).toBe(before.id);
      // The old path must eventually disappear (rename, not duplicate).
      const goneOk = await waitFor(() => files.getByRelPath('orig.stl') === null);
      expect(goneOk).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'flushes pending unlinks as deletes on close',
    async () => {
      harness.writeStl('temp.stl', { triangles: 7, seed: 5 });
      files.upsert({
        relPath: 'temp.stl',
        parentDir: '',
        filename: 'temp.stl',
        ext: 'stl',
        sizeBytes: readSize(harness, 'temp.stl'),
        mtimeMs: readMtime(harness, 'temp.stl')
      });

      start();
      await waitUntilLive();

      harness.remove('temp.stl');
      // Wait for chokidar to register the unlink as a pending entry (the row is
      // still present at this point — the delete is held for the rename window).
      await waitFor(() => false, 600);
      await watcher!.close();
      watcher = undefined;

      expect(files.getByRelPath('temp.stl')).toBeNull();
    },
    TEST_TIMEOUT_MS
  );
});

function readSize(harness: LibraryHarness, relPath: string): number {
  return statSync(harness.abs(relPath)).size;
}
function readMtime(harness: LibraryHarness, relPath: string): number {
  return Math.floor(statSync(harness.abs(relPath)).mtimeMs);
}
