import type Database from 'better-sqlite3';

export const PRIORITY_BACKGROUND = 0;
export const PRIORITY_VISIBLE = 50;
export const PRIORITY_USER = 100;

export interface ThumbJob {
  id: number;
  fileId: number;
  priority: number;
  attempts: number;
  lastError: string | null;
  enqueuedAt: number;
  claimedAt: number | null;
  claimedBy: string | null;
}

interface RawRow {
  id: number;
  file_id: number;
  priority: number;
  attempts: number;
  last_error: string | null;
  enqueued_at: number;
  claimed_at: number | null;
  claimed_by: string | null;
}

function toJob(r: RawRow): ThumbJob {
  return {
    id: r.id,
    fileId: r.file_id,
    priority: r.priority,
    attempts: r.attempts,
    lastError: r.last_error,
    enqueuedAt: r.enqueued_at,
    claimedAt: r.claimed_at,
    claimedBy: r.claimed_by
  };
}

export interface ThumbJobsRepo {
  /** Enqueue a job for a file. Replaces any existing job for the same file. */
  enqueue(fileId: number, priority: number): void;
  enqueueMany(items: Array<{ fileId: number; priority: number }>): number;
  /**
   * Atomically claim the next available job. Returns null if none.
   * Implements priority order; ties broken by enqueued_at.
   */
  claimNext(claimedBy: string): ThumbJob | null;
  /** Bump priority on an already-queued job (e.g. when it scrolls into view). */
  bumpPriority(fileId: number, minPriority: number): void;
  /** Mark a claimed job complete and remove it. */
  finish(jobId: number): void;
  /** Mark a claimed job failed; leaves it in the table with attempts++. */
  fail(jobId: number, error: string): void;
  /** Release a claim without finishing — used on worker recycle/timeout. */
  release(jobId: number): void;
  /**
   * Like release(), but also rolls back the attempt counter so a transient
   * abandonment (e.g. app shutdown mid-render) doesn't burn the retry budget.
   */
  releaseForRetry(jobId: number): void;
  /** Reap stale claims (claimed_by another process or > maxAgeMs ago). */
  reapStale(thisProcess: string, maxAgeMs: number): number;
  /**
   * Drop every unclaimed job, returning how many were removed. In-flight
   * (claimed) jobs are left alone — they finish on their own. Used to cancel a
   * cache rebuild without yanking work out from under a running worker.
   */
  clearPending(): number;
  pendingCount(): number;
  inFlightCount(): number;
}

export function createThumbJobsRepo(db: Database.Database): ThumbJobsRepo {
  const enqueueStmt = db.prepare(`
    INSERT INTO thumb_jobs (file_id, priority, enqueued_at)
    VALUES (?, ?, ?)
  `);

  // Drop any existing job for this file before inserting a new one. We never
  // want duplicate jobs racing each other for the same file.
  const deleteByFileStmt = db.prepare<[number]>(`DELETE FROM thumb_jobs WHERE file_id = ?`);

  const claimSelectStmt = db.prepare(`
    SELECT * FROM thumb_jobs
    WHERE claimed_at IS NULL
    ORDER BY priority DESC, enqueued_at ASC, id ASC
    LIMIT 1
  `);
  const claimUpdateStmt = db.prepare<[number, string, number]>(`
    UPDATE thumb_jobs
    SET claimed_at = ?, claimed_by = ?, attempts = attempts + 1
    WHERE id = ? AND claimed_at IS NULL
  `);

  const bumpStmt = db.prepare<[number, number, number]>(`
    UPDATE thumb_jobs
    SET priority = ?
    WHERE file_id = ? AND priority < ?
  `);

  const finishStmt = db.prepare<[number]>(`DELETE FROM thumb_jobs WHERE id = ?`);

  const failStmt = db.prepare<[string, number]>(`
    UPDATE thumb_jobs
    SET claimed_at = NULL, claimed_by = NULL, last_error = ?
    WHERE id = ?
  `);

  const releaseStmt = db.prepare<[number]>(`
    UPDATE thumb_jobs
    SET claimed_at = NULL, claimed_by = NULL
    WHERE id = ?
  `);
  const releaseForRetryStmt = db.prepare<[number]>(`
    UPDATE thumb_jobs
    SET claimed_at = NULL,
        claimed_by = NULL,
        attempts = MAX(0, attempts - 1),
        last_error = NULL
    WHERE id = ?
  `);

  const reapStmt = db.prepare<[string, number]>(`
    UPDATE thumb_jobs
    SET claimed_at = NULL, claimed_by = NULL
    WHERE claimed_at IS NOT NULL
      AND (claimed_by != ? OR claimed_at < ?)
  `);

  const clearPendingStmt = db.prepare(`DELETE FROM thumb_jobs WHERE claimed_at IS NULL`);

  const pendingStmt = db.prepare(`SELECT COUNT(*) AS c FROM thumb_jobs WHERE claimed_at IS NULL`);
  const inFlightStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM thumb_jobs WHERE claimed_at IS NOT NULL`
  );

  return {
    enqueue(fileId, priority) {
      const tx = db.transaction(() => {
        deleteByFileStmt.run(fileId);
        enqueueStmt.run(fileId, priority, Date.now());
      });
      tx();
    },
    enqueueMany(items) {
      let added = 0;
      const now = Date.now();
      const tx = db.transaction(() => {
        for (const it of items) {
          deleteByFileStmt.run(it.fileId);
          enqueueStmt.run(it.fileId, it.priority, now);
          added++;
        }
      });
      tx();
      return added;
    },
    claimNext(claimedBy) {
      // Two-statement claim wrapped in a transaction so two workers can't take
      // the same job. better-sqlite3 transactions are deferred-by-default, so
      // we use exclusive to prevent the read-then-write race across workers.
      let claimed: ThumbJob | null = null;
      const now = Date.now();
      const tx = db.transaction(() => {
        const row = claimSelectStmt.get() as RawRow | undefined;
        if (!row) return;
        const result = claimUpdateStmt.run(now, claimedBy, row.id);
        if (result.changes === 1) {
          // Reflect the post-claim state: attempts++ and the new claim fields.
          claimed = toJob({
            ...row,
            attempts: row.attempts + 1,
            claimed_at: now,
            claimed_by: claimedBy
          });
        }
      });
      tx.exclusive();
      return claimed;
    },
    bumpPriority(fileId, minPriority) {
      bumpStmt.run(minPriority, fileId, minPriority);
    },
    finish(jobId) {
      finishStmt.run(jobId);
    },
    fail(jobId, error) {
      failStmt.run(error, jobId);
    },
    release(jobId) {
      releaseStmt.run(jobId);
    },
    releaseForRetry(jobId) {
      releaseForRetryStmt.run(jobId);
    },
    reapStale(thisProcess, maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      return reapStmt.run(thisProcess, cutoff).changes;
    },
    clearPending() {
      return clearPendingStmt.run().changes;
    },
    pendingCount() {
      return (pendingStmt.get() as { c: number }).c;
    },
    inFlightCount() {
      return (inFlightStmt.get() as { c: number }).c;
    }
  };
}
