import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PathResolver } from '@shared/paths';
import type { FilesRepo } from '@main/db/repos/files';

const fakeWatcher = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    handlers,
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    close: vi.fn(async () => undefined)
  };
});

const statMock = vi.hoisted(() => vi.fn());
const lstatMock = vi.hoisted(() => vi.fn());

vi.mock('chokidar', () => ({
  default: { watch: vi.fn(() => fakeWatcher) }
}));

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  stat: statMock
}));

import { startWatcher } from './watcher';

describe('LibraryWatcher.close', () => {
  beforeEach(() => {
    fakeWatcher.handlers.clear();
    fakeWatcher.close.mockClear();
    statMock.mockReset();
    lstatMock.mockReset().mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true });
  });
  afterEach(() => vi.useRealTimers());

  it.each(['add', 'change', 'delayed-add'])('preserves a recreated pathname for %s notifications', async (event) => {
    vi.useFakeTimers();
    const row = { id: 7, relPath: 'model.stl', filename: 'model.stl', ext: 'stl', sizeBytes: 100, mtimeMs: 200, contentSha256: null };
    const files = { getByRelPath: vi.fn(() => row), deleteByRelPath: vi.fn(), upsert: vi.fn(), applyRenames: vi.fn() } as unknown as FilesRepo;
    statMock.mockResolvedValue({ size: 300, mtimeMs: 400 });
    const watcher = startWatcher(new PathResolver('/library'), files, { onChange: vi.fn() });
    fakeWatcher.emit('unlink', '/library/model.stl');
    if (event !== 'delayed-add') fakeWatcher.emit(event, '/library/model.stl');
    await vi.advanceTimersByTimeAsync(1600);
    expect(files.deleteByRelPath).not.toHaveBeenCalled();
    expect(files.upsert).toHaveBeenCalledWith(expect.objectContaining({ relPath: 'model.stl', sizeBytes: 300 }));
    await watcher.close();
  });

  it('retains the row and reports errors when deletion cannot be confirmed', async () => {
    vi.useFakeTimers();
    const files = { getByRelPath: vi.fn(() => ({ id: 7, relPath: 'model.stl', ext: 'stl', sizeBytes: 1, mtimeMs: 1 })), deleteByRelPath: vi.fn() } as unknown as FilesRepo;
    lstatMock.mockRejectedValue(Object.assign(new Error('NAS unavailable'), { code: 'EIO' }));
    const onError = vi.fn();
    const watcher = startWatcher(new PathResolver('/library'), files, { onChange: vi.fn(), onError });
    fakeWatcher.emit('unlink', '/library/model.stl');
    await vi.advanceTimersByTimeAsync(1600);
    expect(files.deleteByRelPath).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'EIO' }));
    await watcher.close();
  });

  it('waits for an in-flight add before resolving', async () => {
    let resolveStat!: (value: { size: number; mtimeMs: number }) => void;
    statMock.mockReturnValue(
      new Promise((resolve) => {
        resolveStat = resolve;
      })
    );

    const upsert = vi.fn();
    const files = {
      upsert,
      applyRenames: vi.fn(),
      getByRelPath: vi.fn(),
      deleteByRelPath: vi.fn()
    } as unknown as FilesRepo;
    const watcher = startWatcher(new PathResolver('/library'), files, { onChange: vi.fn() });

    fakeWatcher.emit('add', '/library/model.stl');
    let closed = false;
    const closePromise = watcher.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(closed).toBe(false);
    resolveStat({ size: 100, mtimeMs: 200 });
    await closePromise;

    expect(upsert).toHaveBeenCalledOnce();
  });
});
