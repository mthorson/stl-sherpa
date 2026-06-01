import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import migration001 from '../migrations/001_init.sql?raw';
import { createThumbJobsRepo, PRIORITY_BACKGROUND } from './thumb-jobs';

const localRequire = createRequire(import.meta.url);
let DatabaseCtor: typeof import('better-sqlite3') | null = null;
try {
  DatabaseCtor = localRequire('better-sqlite3');
} catch {
  DatabaseCtor = null;
}
const canRun = DatabaseCtor !== null;

function freshDb() {
  const db = new DatabaseCtor!(':memory:');
  db.exec(migration001);
  // thumb_jobs.file_id has a FK to files — seed a few rows so enqueue is valid.
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO files (id, rel_path, parent_dir, filename, ext, size_bytes, mtime_ms, created_at, updated_at)
     VALUES (?, ?, '', ?, 'stl', 1, ?, ?, ?)`
  );
  for (const id of [1, 2, 3]) insert.run(id, `f${id}.stl`, `f${id}.stl`, now, now, now);
  return db;
}

describe.runIf(canRun)('thumb-jobs clearPending (cache-rebuild cancel)', () => {
  it('drops unclaimed jobs but leaves claimed (in-flight) ones', () => {
    const db = freshDb();
    const jobs = createThumbJobsRepo(db);

    jobs.enqueueMany([
      { fileId: 1, priority: PRIORITY_BACKGROUND },
      { fileId: 2, priority: PRIORITY_BACKGROUND },
      { fileId: 3, priority: PRIORITY_BACKGROUND }
    ]);
    expect(jobs.pendingCount()).toBe(3);

    // Simulate one render in flight by claiming a job.
    const claimed = jobs.claimNext('worker-1');
    expect(claimed).not.toBeNull();
    expect(jobs.inFlightCount()).toBe(1);
    expect(jobs.pendingCount()).toBe(2);

    // Cancel: only the two unclaimed jobs should be removed.
    const cleared = jobs.clearPending();
    expect(cleared).toBe(2);
    expect(jobs.pendingCount()).toBe(0);
    // The in-flight job survives so the running worker can finish it cleanly.
    expect(jobs.inFlightCount()).toBe(1);

    db.close();
  });

  it('returns 0 when there is nothing pending', () => {
    const db = freshDb();
    const jobs = createThumbJobsRepo(db);
    expect(jobs.clearPending()).toBe(0);
    db.close();
  });
});
