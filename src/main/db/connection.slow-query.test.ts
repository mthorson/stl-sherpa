import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// Mock the scoped logger so we can assert on the 'slow query' warn line without
// going through electron-log.
const warn = vi.fn();
vi.mock('@main/logger', () => ({
  scopedLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

const localRequire = createRequire(import.meta.url);
let DatabaseCtor: typeof import('better-sqlite3') | null = null;
try {
  DatabaseCtor = localRequire('better-sqlite3');
} catch {
  DatabaseCtor = null;
}
const canRun = DatabaseCtor !== null;

// Import after the mock is registered.
const { __test } = await import('./connection');
const { instrumentSlowQueries } = __test;

describe.runIf(canRun)('slow query instrumentation', () => {
  let db: import('better-sqlite3').Database;

  beforeEach(() => {
    warn.mockClear();
    db = new DatabaseCtor!(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  });

  afterEach(() => {
    db.close();
  });

  it('does not log fast queries', () => {
    instrumentSlowQueries(db); // default 50ms threshold
    db.prepare('INSERT INTO t (v) VALUES (?)').run('a');
    expect(db.prepare('SELECT count(*) AS c FROM t').get()).toEqual({ c: 1 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a query that exceeds the threshold', () => {
    // A 0ms threshold makes every query "slow" deterministically — no sleeps,
    // no flakiness.
    instrumentSlowQueries(db, 0);
    db.prepare('INSERT INTO t (v) VALUES (?)').run('a');
    expect(warn).toHaveBeenCalled();
    const [msg, fields] = warn.mock.calls[0];
    expect(msg).toBe('slow query');
    expect((fields as { sql: string }).sql).toContain('INSERT INTO t');
    expect((fields as { method: string }).method).toBe('run');
    expect(typeof (fields as { ms: number }).ms).toBe('number');
  });

  it('preserves return values and parameter binding', () => {
    instrumentSlowQueries(db, 0);
    const info = db.prepare('INSERT INTO t (v) VALUES (?)').run('x');
    expect(info.changes).toBe(1);
    const rows = db.prepare('SELECT v FROM t WHERE v = ?').all('x');
    expect(rows).toEqual([{ v: 'x' }]);
  });
});
