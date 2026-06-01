import type Database from 'better-sqlite3';
import type { CameraState, FileRecord, FolderRecord, FileQueryRequest } from '@shared/types';
import { isCameraState } from '@shared/types';
import {
  getDefaultOrientation,
  isFileOrientation,
  type FileOrientation
} from '@shared/orientation';
import { clampRating, isColorLabel, type ColorLabel } from '@shared/ratings';
import type { SortSpec } from '@shared/sort';

interface FileRow {
  id: number;
  rel_path: string;
  parent_dir: string;
  filename: string;
  ext: string;
  size_bytes: number;
  mtime_ms: number;
  sha256: string | null;
  content_sha256: string | null;
  metadata_json: string | null;
  orientation_json: string | null;
  camera_json: string | null;
  rating: number;
  color_label: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
  /** Present on rows joined with thumbnails. 0/1. */
  has_thumb?: number;
  /** Present on rows joined with thumb_errors. */
  thumb_error?: string | null;
}

function parseOrientation(json: string | null): FileOrientation | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return isFileOrientation(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseCamera(json: string | null): CameraState | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return isCameraState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rowToRecord(libraryId: string, row: FileRow): FileRecord {
  const userOrientation = parseOrientation(row.orientation_json);
  const orientation = userOrientation ?? getDefaultOrientation(row.ext);
  return {
    id: row.id,
    libraryId,
    relPath: row.rel_path,
    parentDir: row.parent_dir,
    filename: row.filename,
    ext: row.ext,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    sha256: row.sha256,
    contentSha256: row.content_sha256,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasThumb: row.has_thumb === 1,
    thumbError: row.thumb_error ?? null,
    orientation,
    orientationCustomized: userOrientation !== null,
    rating: row.rating ?? 0,
    colorLabel: isColorLabel(row.color_label) ? row.color_label : null,
    notes: row.notes ?? '',
    camera: parseCamera(row.camera_json)
  };
}

export interface UpsertInput {
  relPath: string;
  parentDir: string;
  filename: string;
  ext: string;
  sizeBytes: number;
  mtimeMs: number;
}

export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged';

export interface DiffEntry {
  id: number;
  relPath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface RenameEntry {
  id: number;
  toRelPath: string;
  toParentDir: string;
  toFilename: string;
}

export interface FilesRepo {
  upsert(input: UpsertInput): UpsertOutcome;
  upsertMany(inputs: UpsertInput[]): { inserted: number; updated: number; unchanged: number };
  deleteByRelPath(relPath: string): boolean;
  deleteByRelPaths(relPaths: string[]): number;
  getByRelPath(relPath: string): FileRecord | null;
  getById(id: number): FileRecord | null;
  listInFolder(parentDir: string): FileRecord[];
  listAllRelPaths(): string[];
  /** Lightweight projection used by the scanner for rename detection. */
  listAllForDiff(): DiffEntry[];
  /** Apply a batch of detected renames in a single transaction. */
  applyRenames(renames: RenameEntry[]): number;
  /**
   * Unified query: optional FTS search, optional folder scope (immediate or
   * recursive subtree), optional extension filter, optional tag filter
   * (must have ALL listed tags). Always returns hasThumb-joined rows.
   */
  query(req: Omit<FileQueryRequest, 'libraryId'>): FileRecord[];
  /** Update extracted metadata for a file. Triggers FTS row rebuild. */
  setMetadata(fileId: number, metadataJson: string): void;
  /** Set sha256 (computed lazily during thumbnail render). */
  setSha256(fileId: number, sha256: string): void;
  /**
   * Persist content-hash digests for many files in one transaction. Used by
   * the scanner after hashing new/changed files for exact-dup detection.
   */
  setContentSha256Many(entries: Array<{ id: number; sha256: string }>): void;
  /**
   * Files whose `content_sha256` is still NULL — new rows the scanner just
   * inserted, plus any pre-migration rows that predate the column. Returns a
   * lightweight {id, relPath} projection the scanner uses to hash them.
   */
  listMissingContentHash(): Array<{ id: number; relPath: string }>;
  /**
   * Persist or clear a per-file orientation override. `null` clears the
   * override so the file falls back to its format default.
   */
  setOrientation(fileId: number, orientation: FileOrientation | null): void;
  /** Persist or clear a per-file saved camera state. `null` clears it. */
  setCamera(fileId: number, camera: CameraState | null): void;
  /** Set the same rating on many files in one transaction. */
  setRatings(fileIds: number[], rating: number): number;
  /** Set or clear the same color label on many files in one transaction. */
  setColorLabels(fileIds: number[], label: ColorLabel | null): number;
  /** Set free-text notes; empty string clears (stored as NULL). */
  setNotes(fileId: number, notes: string): void;
  /**
   * Distinct parent_dir values in the library, with immediate file counts.
   * The folder tree is reconstructed from these in the renderer; ancestor
   * directories that contain no files directly are inferred there.
   */
  listFoldersWithCounts(): FolderRecord[];
  count(): number;
}

export function createFilesRepo(db: Database.Database, libraryId: string): FilesRepo {
  const upsertStmt = db.prepare(`
    INSERT INTO files (rel_path, parent_dir, filename, ext, size_bytes, mtime_ms, created_at, updated_at)
    VALUES (@relPath, @parentDir, @filename, @ext, @sizeBytes, @mtimeMs, @now, @now)
    ON CONFLICT(rel_path) DO UPDATE SET
      size_bytes = excluded.size_bytes,
      mtime_ms = excluded.mtime_ms,
      updated_at = excluded.updated_at,
      -- Content changed (size/mtime differ), so the stored hash is stale.
      -- Clear it; the scanner re-hashes rows whose content_sha256 is NULL.
      content_sha256 = NULL
    WHERE files.size_bytes != excluded.size_bytes
       OR files.mtime_ms != excluded.mtime_ms
  `);

  const touchUpdatedStmt = db.prepare(`
    UPDATE files SET updated_at = @now WHERE rel_path = @relPath
  `);

  const getByRelPathStmt = db.prepare<[string]>(`SELECT * FROM files WHERE rel_path = ?`);
  // The UI read paths join in thumbnail + error so the renderer can decide
  // between rendered tile / placeholder / error badge without extra round
  // trips per file.
  const getByIdStmt = db.prepare<[number]>(`
    SELECT files.*,
      (CASE WHEN thumbnails.file_id IS NULL THEN 0 ELSE 1 END) AS has_thumb,
      thumb_errors.error AS thumb_error
    FROM files
    LEFT JOIN thumbnails ON thumbnails.file_id = files.id
    LEFT JOIN thumb_errors ON thumb_errors.file_id = files.id
    WHERE files.id = ?
  `);
  const deleteStmt = db.prepare<[string]>(`DELETE FROM files WHERE rel_path = ?`);
  const listInFolderStmt = db.prepare<[string]>(`
    SELECT files.*,
      (CASE WHEN thumbnails.file_id IS NULL THEN 0 ELSE 1 END) AS has_thumb,
      thumb_errors.error AS thumb_error
    FROM files
    LEFT JOIN thumbnails ON thumbnails.file_id = files.id
    LEFT JOIN thumb_errors ON thumb_errors.file_id = files.id
    WHERE files.parent_dir = ?
    ORDER BY files.filename COLLATE NOCASE
  `);
  const listAllRelPathsStmt = db.prepare(`SELECT rel_path FROM files`);
  const listFoldersStmt = db.prepare(
    `SELECT parent_dir AS parentDir, COUNT(*) AS fileCount
     FROM files
     GROUP BY parent_dir
     ORDER BY parent_dir COLLATE NOCASE`
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS c FROM files`);

  const setMetadataStmt = db.prepare<[string, number]>(
    `UPDATE files SET metadata_json = ? WHERE id = ?`
  );
  const setSha256Stmt = db.prepare<[string, number]>(
    `UPDATE files SET sha256 = ? WHERE id = ?`
  );
  const setContentSha256Stmt = db.prepare<[string, number]>(
    `UPDATE files SET content_sha256 = ? WHERE id = ?`
  );
  const listMissingContentHashStmt = db.prepare(
    `SELECT id, rel_path AS relPath FROM files WHERE content_sha256 IS NULL`
  );
  const setOrientationStmt = db.prepare<[string | null, number]>(
    `UPDATE files SET orientation_json = ? WHERE id = ?`
  );
  const setCameraStmt = db.prepare<[string | null, number]>(
    `UPDATE files SET camera_json = ? WHERE id = ?`
  );
  const setRatingStmt = db.prepare<[number, number]>(
    `UPDATE files SET rating = ? WHERE id = ?`
  );
  const setColorLabelStmt = db.prepare<[string | null, number]>(
    `UPDATE files SET color_label = ? WHERE id = ?`
  );
  const setNotesStmt = db.prepare<[string | null, number]>(
    `UPDATE files SET notes = ? WHERE id = ?`
  );

  const listAllForDiffStmt = db.prepare(
    `SELECT id, rel_path AS relPath, size_bytes AS sizeBytes, mtime_ms AS mtimeMs FROM files`
  );
  const renameStmt = db.prepare<[string, string, string, number, number]>(`
    UPDATE files
    SET rel_path = ?, parent_dir = ?, filename = ?, updated_at = ?
    WHERE id = ?
  `);

  return {
    upsert(input) {
      const now = Date.now();
      const before = getByRelPathStmt.get(input.relPath) as FileRow | undefined;
      const result = upsertStmt.run({ ...input, now });
      if (!before) return 'inserted';
      // The conditional UPDATE only fires when size/mtime change, so
      // changes === 0 means the file was already up to date.
      if (result.changes === 0) {
        // Touch updated_at so scan-end stale-cleanup keeps unchanged files.
        touchUpdatedStmt.run({ relPath: input.relPath, now });
        return 'unchanged';
      }
      return 'updated';
    },

    upsertMany(inputs) {
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      const tx = db.transaction((rows: UpsertInput[]) => {
        const now = Date.now();
        for (const r of rows) {
          const before = getByRelPathStmt.get(r.relPath) as FileRow | undefined;
          const result = upsertStmt.run({ ...r, now });
          if (!before) inserted++;
          else if (result.changes === 0) {
            touchUpdatedStmt.run({ relPath: r.relPath, now });
            unchanged++;
          } else updated++;
        }
      });
      tx(inputs);
      return { inserted, updated, unchanged };
    },

    deleteByRelPath(relPath) {
      return deleteStmt.run(relPath).changes > 0;
    },

    deleteByRelPaths(relPaths) {
      if (relPaths.length === 0) return 0;
      let total = 0;
      const tx = db.transaction((paths: string[]) => {
        for (const p of paths) total += deleteStmt.run(p).changes;
      });
      tx(relPaths);
      return total;
    },

    getByRelPath(relPath) {
      const row = getByRelPathStmt.get(relPath) as FileRow | undefined;
      return row ? rowToRecord(libraryId, row) : null;
    },

    getById(id) {
      const row = getByIdStmt.get(id) as FileRow | undefined;
      return row ? rowToRecord(libraryId, row) : null;
    },

    listInFolder(parentDir) {
      const rows = listInFolderStmt.all(parentDir) as FileRow[];
      return rows.map((r) => rowToRecord(libraryId, r));
    },

    listAllRelPaths() {
      const rows = listAllRelPathsStmt.all() as { rel_path: string }[];
      return rows.map((r) => r.rel_path);
    },

    listAllForDiff() {
      return listAllForDiffStmt.all() as DiffEntry[];
    },

    applyRenames(renames) {
      if (renames.length === 0) return 0;
      let total = 0;
      const tx = db.transaction((items: RenameEntry[]) => {
        const now = Date.now();
        for (const r of items) {
          total += renameStmt.run(r.toRelPath, r.toParentDir, r.toFilename, now, r.id).changes;
        }
      });
      tx(renames);
      return total;
    },

    listFoldersWithCounts() {
      return listFoldersStmt.all() as FolderRecord[];
    },

    query(req) {
      const where: string[] = [];
      const params: unknown[] = [];
      const limit = req.limit ?? 1000;

      // FTS clause sits in its own join when present so an empty/no query
      // doesn't pay for the virtual table lookup.
      const fts = req.query?.trim() ?? '';
      const ftsExpr = buildFtsExpression(fts);
      let ftsJoin = '';
      if (ftsExpr) {
        ftsJoin = ` JOIN files_fts ON files_fts.rowid = files.id AND files_fts MATCH ?`;
        params.push(ftsExpr);
      }

      // Collection scope. The join (vs IN subquery) lets us order by
      // `cf.position` below; when no collection is selected the join is omitted.
      let collectionJoin = '';
      if (req.collectionId != null) {
        collectionJoin = ` JOIN collection_files cf ON cf.file_id = files.id AND cf.collection_id = ?`;
        params.push(req.collectionId);
      }

      if (req.parentDir != null) {
        if (req.recursive) {
          where.push(`(files.parent_dir = ? OR files.parent_dir LIKE ?)`);
          params.push(req.parentDir, req.parentDir === '' ? '%' : `${req.parentDir}/%`);
        } else {
          where.push(`files.parent_dir = ?`);
          params.push(req.parentDir);
        }
      }

      if (req.extensions && req.extensions.length > 0) {
        const placeholders = req.extensions.map(() => '?').join(',');
        where.push(`files.ext IN (${placeholders})`);
        params.push(...req.extensions);
      }

      if (req.tagIds && req.tagIds.length > 0) {
        // Hierarchical match: a file qualifies for a parent tag if it carries
        // EITHER the parent itself OR any descendant. We require all root-level
        // filters to hit, so for each requested tag we build an EXISTS clause
        // that joins via a per-tag descendants CTE.
        for (const tagId of req.tagIds) {
          where.push(`EXISTS (
            WITH RECURSIVE d(id) AS (
              SELECT ? UNION SELECT t.id FROM tags t JOIN d ON t.parent_id = d.id
            )
            SELECT 1 FROM file_tags ft
            WHERE ft.file_id = files.id AND ft.tag_id IN (SELECT id FROM d)
          )`);
          params.push(tagId);
        }
      }

      if (typeof req.minRating === 'number' && req.minRating > 0) {
        where.push(`files.rating >= ?`);
        params.push(Math.max(0, Math.min(5, Math.floor(req.minRating))));
      }

      if (req.colorLabels && req.colorLabels.length > 0) {
        const validLabels = req.colorLabels.filter(isColorLabel);
        if (validLabels.length > 0) {
          const placeholders = validLabels.map(() => '?').join(',');
          where.push(`files.color_label IN (${placeholders})`);
          params.push(...validLabels);
        }
      }

      if (req.duplicatesOnly) {
        // Exact-content duplicates: the file's hash must be shared by at least
        // one other file. The subquery is computed over the whole library (not
        // the filtered set) so a file still counts as a duplicate even when its
        // twin lives in another folder/scope.
        where.push(`files.content_sha256 IN (
          SELECT content_sha256 FROM files
          WHERE content_sha256 IS NOT NULL
          GROUP BY content_sha256
          HAVING COUNT(*) > 1
        )`);
      }

      const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
      // Order priority:
      //   1. explicit user sort if provided (overrides everything)
      //   2. duplicate view → group adjacent by hash so dup sets read together
      //   3. manual collection position
      //   4. FTS rank if a query is set
      //   5. filename fallback
      const orderSql = req.sort
        ? buildOrderClause(req.sort)
        : req.duplicatesOnly
          ? ' ORDER BY files.content_sha256, files.filename COLLATE NOCASE'
          : req.collectionId != null
            ? ' ORDER BY cf.position, files.filename COLLATE NOCASE'
            : ftsExpr
              ? ' ORDER BY bm25(files_fts), files.filename COLLATE NOCASE'
              : ' ORDER BY files.filename COLLATE NOCASE';

      const sql = `
        SELECT files.*,
          (CASE WHEN thumbnails.file_id IS NULL THEN 0 ELSE 1 END) AS has_thumb,
          thumb_errors.error AS thumb_error
        FROM files${ftsJoin}${collectionJoin}
        LEFT JOIN thumbnails ON thumbnails.file_id = files.id
        LEFT JOIN thumb_errors ON thumb_errors.file_id = files.id
        ${whereSql}${orderSql}
        LIMIT ${limit}
      `;
      const rows = db.prepare(sql).all(...params) as FileRow[];
      return rows.map((r) => rowToRecord(libraryId, r));
    },

    setMetadata(fileId, metadataJson) {
      setMetadataStmt.run(metadataJson, fileId);
    },

    setSha256(fileId, sha256) {
      setSha256Stmt.run(sha256, fileId);
    },

    setContentSha256Many(entries) {
      if (entries.length === 0) return;
      const tx = db.transaction((rows: Array<{ id: number; sha256: string }>) => {
        for (const r of rows) setContentSha256Stmt.run(r.sha256, r.id);
      });
      tx(entries);
    },

    listMissingContentHash() {
      return listMissingContentHashStmt.all() as Array<{ id: number; relPath: string }>;
    },

    setOrientation(fileId, orientation) {
      setOrientationStmt.run(orientation ? JSON.stringify(orientation) : null, fileId);
    },

    setCamera(fileId, camera) {
      setCameraStmt.run(camera ? JSON.stringify(camera) : null, fileId);
    },

    setRatings(fileIds, rating) {
      if (fileIds.length === 0) return 0;
      const clamped = clampRating(rating);
      let total = 0;
      const tx = db.transaction((ids: number[]) => {
        for (const id of ids) total += setRatingStmt.run(clamped, id).changes;
      });
      tx(fileIds);
      return total;
    },

    setColorLabels(fileIds, label) {
      if (fileIds.length === 0) return 0;
      const value = label === null ? null : isColorLabel(label) ? label : null;
      let total = 0;
      const tx = db.transaction((ids: number[]) => {
        for (const id of ids) total += setColorLabelStmt.run(value, id).changes;
      });
      tx(fileIds);
      return total;
    },

    setNotes(fileId, notes) {
      const trimmed = notes.trim();
      setNotesStmt.run(trimmed === '' ? null : notes, fileId);
    },

    count() {
      return (countStmt.get() as { c: number }).c;
    }
  };
}

/**
 * Build the ORDER BY clause for an explicit user sort. Metadata-derived
 * fields read out of `metadata_json` via JSON_EXTRACT — fine at our row
 * counts (2k LIMIT), no need to denormalize. NULLS LAST keeps unrated /
 * unrendered files at the bottom regardless of direction. A secondary
 * filename sort tiebreaks for stable ordering.
 */
function buildOrderClause(sort: SortSpec): string {
  const dir = sort.direction === 'desc' ? 'DESC' : 'ASC';
  // SQLite handles NULLS LAST/FIRST natively only as `NULLS LAST` syntax.
  const nulls = sort.direction === 'desc' ? 'NULLS LAST' : 'NULLS LAST';
  const tiebreak = ` , files.filename COLLATE NOCASE`;
  switch (sort.field) {
    case 'filename':
      return ` ORDER BY files.filename COLLATE NOCASE ${dir}`;
    case 'mtime':
      return ` ORDER BY files.mtime_ms ${dir}${tiebreak}`;
    case 'size':
      return ` ORDER BY files.size_bytes ${dir}${tiebreak}`;
    case 'ext':
      return ` ORDER BY files.ext ${dir}${tiebreak}`;
    case 'rating':
      return ` ORDER BY files.rating ${dir}${tiebreak}`;
    case 'vertices':
      return ` ORDER BY JSON_EXTRACT(files.metadata_json, '$.vertexCount') ${dir} ${nulls}${tiebreak}`;
    case 'triangles':
      return ` ORDER BY JSON_EXTRACT(files.metadata_json, '$.triangleCount') ${dir} ${nulls}${tiebreak}`;
    case 'bboxVolume':
      // size = [x, y, z]; volume = product. SQLite JSON_EXTRACT returns the JSON
      // array elements as numbers when addressed individually.
      return (
        ` ORDER BY (` +
        `COALESCE(JSON_EXTRACT(files.metadata_json, '$.boundingBox.size[0]'), 0) * ` +
        `COALESCE(JSON_EXTRACT(files.metadata_json, '$.boundingBox.size[1]'), 0) * ` +
        `COALESCE(JSON_EXTRACT(files.metadata_json, '$.boundingBox.size[2]'), 0)` +
        `) ${dir} ${nulls}${tiebreak}`
      );
  }
}

/**
 * Convert a free-text user query into an FTS5 expression. Each whitespace-
 * separated term is quoted and prefix-matched, then ANDed together. Special
 * FTS characters in the input are stripped so the query never throws.
 */
function buildFtsExpression(input: string): string {
  if (!input) return '';
  const terms = input
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["()*:^]/g, ''))
    .filter((t) => t.length > 0);
  if (terms.length === 0) return '';
  return terms.map((t) => `"${t}"*`).join(' AND ');
}
