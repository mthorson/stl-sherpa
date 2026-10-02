import { afterEach, describe, expect, it, vi } from 'vitest';
import { canRun, freshDb } from '@main/db/test-utils';
import { createFilesRepo } from '@main/db/repos/files';
import { createThumbnailsRepo, RENDERER_VERSION } from '@main/db/repos/thumbnails';
import { createThumbJobsRepo } from '@main/db/repos/thumb-jobs';
import { createThumbErrorsRepo } from '@main/db/repos/thumb-errors';
import type { OpenLibrary } from '@main/libraries/manager';
import { PathResolver } from '@shared/paths';

const mocks = vi.hoisted(() => ({ libraries: [] as unknown[], render: vi.fn() }));
vi.mock('@main/libraries/manager', () => ({ listOpenLibraries: () => mocks.libraries }));
vi.mock('./pool', () => ({ thumbPool: { render: mocks.render } }));
vi.mock('./storage', () => ({ thumbAbsPath: () => '/unused.png', thumbRelPath: () => 'unused.png', writeThumbnailFile: async () => {} }));
vi.mock('@main/files/path-safety', () => ({ assertExistingPathInsideLibrary: async () => {} }));
vi.mock('@main/logger', () => ({ scopedLogger: () => ({ debug() {}, warn() {}, error() {} }), time: (_log: unknown, _name: string, fn: () => unknown) => fn() }));
import { ThumbQueueRunner } from './queue-runner';

describe.runIf(canRun)('thumbnail queue reconciliation', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => { mocks.libraries = []; mocks.render.mockReset(); cleanup.splice(0).forEach((fn) => fn()); });
  function setup(count: number) {
    const db = freshDb();
    cleanup.push(() => db.close());
    const files = createFilesRepo(db, 'lib');
    files.upsertMany(Array.from({ length: count }, (_, i) => ({ relPath: `${i}.stl`, parentDir: '', filename: `${i}.stl`, ext: 'stl', sizeBytes: 1, mtimeMs: 2 })));
    const lib = { db, files, thumbnails: createThumbnailsRepo(db), thumbJobs: createThumbJobsRepo(db), thumbErrors: createThumbErrorsRepo(db), resolver: new PathResolver('/library'), entry: { id: 'lib', mountPath: '/library' } } as OpenLibrary;
    mocks.libraries = [lib];
    mocks.render.mockResolvedValue({ png: new Uint8Array([1]), metadata: {} });
    return { lib, runner: new ThumbQueueRunner(2) };
  }

  it('automatically refills beyond 1000 and renders each file exactly once', async () => {
    const { lib, runner } = setup(1007);
    let rendered = 0;
    runner.on('thumb-rendered', () => rendered++);
    runner.reconcile(lib);
    await vi.waitFor(() => expect(rendered).toBe(1007), { timeout: 10000 });
    expect(mocks.render).toHaveBeenCalledTimes(1007);
    expect(lib.thumbJobs.pendingCount()).toBe(0);
    expect(lib.thumbJobs.inFlightCount()).toBe(0);
    await runner.shutdown();
  });

  it('does not resurrect cancelled work when in-flight workers finish', async () => {
    const { lib, runner } = setup(1007);
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    mocks.render.mockReturnValue(pending);
    runner.reconcile(lib);
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(2));
    expect(runner.cancelPending(lib)).toBe(998);
    finish({ png: new Uint8Array([1]), metadata: {} });
    await vi.waitFor(() => expect(lib.thumbJobs.inFlightCount()).toBe(0));
    expect(mocks.render).toHaveBeenCalledTimes(2);
    expect(lib.thumbJobs.pendingCount()).toBe(0);
    await runner.shutdown();
  });

  it('stops retrying a failed replacement even when an old thumbnail remains', async () => {
    const { lib, runner } = setup(1);
    lib.thumbnails.upsert({ fileId: 1, thumbRelPath: 'old.png', renderedAt: 1, sourceMtimeMs: 1, sourceSha256: null, rendererVersion: RENDERER_VERSION });
    mocks.render.mockRejectedValue(new Error('Invalid mesh'));
    runner.reconcile(lib);
    await vi.waitFor(() => expect(lib.thumbErrors.getByFileId(1)?.attempts).toBe(3));
    runner.reconcile(lib);
    expect(mocks.render).toHaveBeenCalledTimes(3);
    expect(lib.thumbnails.findFilesNeedingThumbs(1000)).toEqual([]);
    await runner.shutdown();
  });
});
