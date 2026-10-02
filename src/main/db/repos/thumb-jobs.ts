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
  /** Enqueue or raise priority, preserving existing claims and retry history. */
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
  /**
   * Release claims older than maxAgeMs regardless of owner. Age-based only:
   * another live process's fresh claims (shared NAS library) are left alone,
   * and a crashed process's claims age out on their own.
   */
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

  const existingStmt = db.prepare<[number]>(`SELECT id FROM thumb_jobs WHERE file_id = ? LIMIT 1`);

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

  // Reap strictly by age. Reaping "any other process's claims" immediately
  // would make two app instances sharing a NAS library steal each other's
  // in-flight work on every reconcile; a crashed process's claims age past
  // the cutoff on their own.
  const reapStmt = db.prepare<[number]>(`
    UPDATE thumb_jobs
    SET claimed_at = NULL, claimed_by = NULL
    WHERE claimed_at IS NOT NULL
      AND claimed_at < ?
  `);

  const clearPendingStmt = db.prepare(`DELETE FROM thumb_jobs WHERE claimed_at IS NULL`);

  const pendingStmt = db.prepare(`SELECT COUNT(*) AS c FROM thumb_jobs WHERE claimed_at IS NULL`);
  const inFlightStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM thumb_jobs WHERE claimed_at IS NOT NULL`
  );

  const enqueueBatch = db.transaction((items: Array<{ fileId: number; priority: number }>) => {
    let added = 0;
    const now = Date.now();
    for (const item of items) {
      if (existingStmt.get(item.fileId)) {
        bumpStmt.run(item.priority, item.fileId, item.priority);
      } else {
        enqueueStmt.run(item.fileId, item.priority, now);
        added++;
      }
    }
    return added;
  });

  return {
    enqueue(fileId, priority) {
      enqueueBatch.immediate([{ fileId, priority }]);
    },
    enqueueMany(items) {
      return enqueueBatch.immediate(items);
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
    reapStale(_thisProcess, maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      return reapStmt.run(cutoff).changes;
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
