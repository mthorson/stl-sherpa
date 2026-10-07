import { beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('chokidar', () => ({
  default: { watch: vi.fn(() => fakeWatcher) }
}));

vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(async () => ({ isSymbolicLink: () => false })),
  stat: statMock
}));

import { startWatcher } from './watcher';

describe('LibraryWatcher.close', () => {
  beforeEach(() => {
    fakeWatcher.handlers.clear();
    fakeWatcher.close.mockClear();
    statMock.mockReset();
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
