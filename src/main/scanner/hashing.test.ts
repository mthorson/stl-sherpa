import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canRun, freshDb } from '@main/db/test-utils';
import { createFilesRepo } from '@main/db/repos/files';
import type { WatcherCallbacks } from './watcher';

const mocks = vi.hoisted(() => ({ hash: vi.fn(), callbacks: null as WatcherCallbacks | null }));
vi.mock('@main/files/hash', () => ({ hashFileContent: mocks.hash }));
vi.mock('@main/preferences/store', () => ({ getAll: () => ({}) }));
vi.mock('./watcher', () => ({ startWatcher: (_resolver: unknown, _files: unknown, cb: WatcherCallbacks) => {
  mocks.callbacks = cb;
  return { close: async () => {} };
} }));
import { ScannerService } from './service';

describe.runIf(canRun)('incremental content hashing', () => {
  it('hashes watcher changes arriving during an existing pass, and rehashes later edits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'meshflask-hashes-'));
    const db = freshDb();
    const files = createFilesRepo(db, 'lib');
    const scanner = new ScannerService();
    let release!: (value: string) => void;
    const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    mocks.callbacks = null;
    mocks.hash.mockReset().mockImplementation(async (path: string) => digest(path));
    mocks.hash.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const index = (relPath: string) => {
      const stat = statSync(join(root, relPath));
      files.upsert({ relPath, parentDir: '', filename: relPath, ext: 'stl', sizeBytes: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
      mocks.callbacks!.onChange();
    };
    try {
      writeFileSync(join(root, 'a.stl'), 'same content');
      scanner.attach('lib', db, root);
      await vi.waitFor(() => { expect(mocks.callbacks).not.toBeNull(); expect(release).toBeTypeOf('function'); });
      writeFileSync(join(root, 'b.stl'), 'same content');
      index('b.stl');
      // The debounce must request another pass while the initial hash is held.
      await new Promise((resolve) => setTimeout(resolve, 350));
      release(digest(join(root, 'a.stl')));
      await vi.waitFor(() => expect(files.query({ duplicatesOnly: true })).toHaveLength(2));
      writeFileSync(join(root, 'b.stl'), 'different content now');
      index('b.stl');
      await vi.waitFor(() => expect(files.getByRelPath('b.stl')?.contentSha256).toBe(digest(join(root, 'b.stl'))));
      expect(files.query({ duplicatesOnly: true })).toHaveLength(0);
    } finally {
      release?.(digest(join(root, 'a.stl')));
      await scanner.detachAll();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
