import { describe, expect, it, vi } from 'vitest';
import { time } from './logger';

function fakeLogger() {
  return { debug: vi.fn(), warn: vi.fn() };
}

describe('time()', () => {
  it('returns the sync result and logs at debug', () => {
    const log = fakeLogger();
    const out = time(log, 'sync-op', () => 42);
    expect(out).toBe(42);
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    const [name, fields] = log.debug.mock.calls[0];
    expect(name).toBe('sync-op');
    expect(typeof (fields as { ms: number }).ms).toBe('number');
    expect((fields as { ms: number }).ms).toBeGreaterThanOrEqual(0);
  });

  it('awaits and returns the async result', async () => {
    const log = fakeLogger();
    const out = await time(log, 'async-op', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'done';
    });
    expect(out).toBe('done');
    expect(log.debug).toHaveBeenCalledTimes(1);
    const [, fields] = log.debug.mock.calls[0];
    expect((fields as { ms: number }).ms).toBeGreaterThan(0);
  });

  it('logs at debug only once for async (not before resolution)', async () => {
    const log = fakeLogger();
    const promise = time(log, 'pending', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 1;
    });
    // Not logged yet — the promise has not resolved.
    expect(log.debug).not.toHaveBeenCalled();
    await promise;
    expect(log.debug).toHaveBeenCalledTimes(1);
  });

  it('rethrows sync errors and logs them as failed', () => {
    const log = fakeLogger();
    expect(() => time(log, 'boom', () => {
      throw new Error('kaboom');
    })).toThrow('kaboom');
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [, fields] = log.warn.mock.calls[0];
    expect((fields as { failed: boolean }).failed).toBe(true);
  });

  it('rethrows async rejections and logs them as failed', async () => {
    const log = fakeLogger();
    await expect(
      time(log, 'reject', async () => {
        throw new Error('nope');
      })
    ).rejects.toThrow('nope');
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [, fields] = log.warn.mock.calls[0];
    expect((fields as { failed: boolean }).failed).toBe(true);
  });

  it('warns when duration is at or above warnAboveMs', async () => {
    const log = fakeLogger();
    await time(
      log,
      'slow',
      async () => {
        await new Promise((r) => setTimeout(r, 20));
      },
      { warnAboveMs: 1 }
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('stays at debug when below warnAboveMs', () => {
    const log = fakeLogger();
    time(log, 'fast', () => 0, { warnAboveMs: 100_000 });
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('merges custom meta fields into the log line', () => {
    const log = fakeLogger();
    time(log, 'with-meta', () => 0, { meta: { libraryId: 'lib-1', count: 3 } });
    const [, fields] = log.debug.mock.calls[0];
    expect(fields).toMatchObject({ libraryId: 'lib-1', count: 3 });
  });
});
