import type Database from 'better-sqlite3';

/**
 * Bumped whenever the worker's rendering code changes in a way that should
 * invalidate previously-rendered thumbnails. Stored alongside each thumbnail
 * row so the reconciler can re-enqueue stale ones.
 *
 * Version history:
 *   1 — initial Phase 3 worker.
 *   2 — orientation correction (STL/3MF render +Z up instead of treating
 *       them as Y-up) + per-file orientation override. Existing thumbnails
 *       are re-rendered on first launch after this bump.
 */
export const RENDERER_VERSION = 2;

export interface ThumbnailRow {
  fileId: number;
  thumbRelPath: string;
  renderedAt: number;
  sourceMtimeMs: number;
  sourceSha256: string | null;
  rendererVersion: number;
}

export interface ThumbnailsRepo {
  upsert(row: ThumbnailRow): void;
  getByFileId(fileId: number): ThumbnailRow | null;
  deleteByFileId(fileId: number): boolean;
  /** Wipe every row in the `thumbnails` table. Used by Rebuild cache. */
  deleteAll(): number;
  /** Return all currently-tracked file_ids for orphan-sidecar reconciliation. */
  listAllFileIds(): number[];
  /**
   * Find files whose thumbnails are missing or stale (mtime/source mismatch
   * or older renderer version). Used by the reconciler after a scan.
   */
  findFilesNeedingThumbs(limit: number): Array<{ fileId: number; mtimeMs: number }>;
}

interface RawRow {
  file_id: number;
  thumb_rel_path: string;
  rendered_at: number;
  source_mtime_ms: number;
  source_sha256: string | null;
  renderer_version: number;
}

function toRow(r: RawRow): ThumbnailRow {
  return {
    fileId: r.file_id,
    thumbRelPath: r.thumb_rel_path,
    renderedAt: r.rendered_at,
    sourceMtimeMs: r.source_mtime_ms,
    sourceSha256: r.source_sha256,
    rendererVersion: r.renderer_version
  };
}

export function createThumbnailsRepo(db: Database.Database): ThumbnailsRepo {
  const upsertStmt = db.prepare(`
    INSERT INTO thumbnails (file_id, thumb_rel_path, rendered_at, source_mtime_ms, source_sha256, renderer_version)
    VALUES (@fileId, @thumbRelPath, @renderedAt, @sourceMtimeMs, @sourceSha256, @rendererVersion)
    ON CONFLICT(file_id) DO UPDATE SET
      thumb_rel_path = excluded.thumb_rel_path,
      rendered_at = excluded.rendered_at,
      source_mtime_ms = excluded.source_mtime_ms,
      source_sha256 = excluded.source_sha256,
      renderer_version = excluded.renderer_version
  `);

  const getStmt = db.prepare<[number]>(`SELECT * FROM thumbnails WHERE file_id = ?`);
  const deleteStmt = db.prepare<[number]>(`DELETE FROM thumbnails WHERE file_id = ?`);

  // Queue only missing/stale thumbnails without an existing job. A current
  // terminal error suppresses retries even if an older thumbnail remains;
  // changing the file or renderer version makes it eligible again.
  const findNeedingStmt = db.prepare<[number, number, number]>(`
    SELECT f.id AS fileId, f.mtime_ms AS mtimeMs
    FROM files f
    LEFT JOIN thumbnails t ON t.file_id = f.id
    LEFT JOIN thumb_errors e ON e.file_id = f.id
    WHERE NOT EXISTS (SELECT 1 FROM thumb_jobs j WHERE j.file_id = f.id)
    AND (e.file_id IS NULL OR e.source_mtime_ms != f.mtime_ms OR e.renderer_version < ?)
    AND (t.file_id IS NULL OR t.source_mtime_ms != f.mtime_ms OR t.renderer_version < ?)
    ORDER BY f.id
    LIMIT ?
  `);

  return {
    upsert(row) {
      upsertStmt.run(row);
    },
    getByFileId(fileId) {
      const r = getStmt.get(fileId) as RawRow | undefined;
      return r ? toRow(r) : null;
    },
    deleteByFileId(fileId) {
      return deleteStmt.run(fileId).changes > 0;
    },
    deleteAll() {
      return db.prepare(`DELETE FROM thumbnails`).run().changes;
    },
    listAllFileIds() {
      const rows = db.prepare(`SELECT file_id FROM thumbnails`).all() as {
        file_id: number;
      }[];
      return rows.map((r) => r.file_id);
    },
    findFilesNeedingThumbs(limit) {
      return findNeedingStmt.all(RENDERER_VERSION, RENDERER_VERSION, limit) as Array<{
        fileId: number;
        mtimeMs: number;
      }>;
    }
  };
}
