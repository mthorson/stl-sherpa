import type Database from 'better-sqlite3';
import type { TagRecord, TagTreeNode, TagWithCount } from '@shared/types';

export interface TagsRepo {
  /**
   * Get-or-create a tag at the given parent (null = root). Tag names are
   * unique per parent, case-insensitive. Same name under different parents
   * is allowed (e.g. "Stage 1" under both ProjectA and ProjectB).
   */
  ensureByName(name: string, parentId?: number | null): TagRecord;
  list(): TagRecord[];
  listWithCounts(): TagWithCount[];
  /** Whole tag hierarchy as a tree, sorted by name at each level. */
  listTree(): TagTreeNode[];
  listForFile(fileId: number): TagRecord[];
  /**
   * Tags carried by ANY of the given files; `fileCount` is how many of those
   * files carry the tag. One query (chunked under SQLite's parameter limit)
   * instead of one listForFile round trip per file.
   */
  listForFiles(fileIds: number[]): TagWithCount[];
  addToFile(fileId: number, tagId: number): void;
  removeFromFile(fileId: number, tagId: number): void;
  /** Delete a tag everywhere it's used. Children survive (FK SET NULL). */
  delete(tagId: number): void;
  rename(tagId: number, newName: string): TagRecord | null;
  /** Reparent a tag. `null` parent = move to root. */
  setParent(tagId: number, parentId: number | null): void;
  /**
   * Expand a list of tag ids to include all descendants via the recursive CTE.
   * Used by `files.query()` so filtering by a parent tag matches files tagged
   * with any descendant.
   */
  expandToDescendants(tagIds: number[]): number[];
}

interface RawTagRow {
  id: number;
  name: string;
  parent_id: number | null;
}

interface RawTagWithCountRow extends RawTagRow {
  file_count: number;
}

function toRecord(r: RawTagRow): TagRecord {
  return { id: r.id, name: r.name, parentId: r.parent_id };
}

export function createTagsRepo(db: Database.Database): TagsRepo {
  const insertStmt = db.prepare<[string, number | null]>(
    `INSERT INTO tags (name, parent_id) VALUES (?, ?)`
  );
  // Tag names are globally unique (existing UNIQUE COLLATE NOCASE constraint
  // from migration 001 carries forward through 009). We look up by name only.
  const findByNameStmt = db.prepare<[string]>(
    `SELECT id, name, parent_id FROM tags
     WHERE name = ? COLLATE NOCASE LIMIT 1`
  );
  const listStmt = db.prepare(
    `SELECT id, name, parent_id FROM tags ORDER BY name COLLATE NOCASE`
  );
  const listWithCountsStmt = db.prepare(`
    SELECT t.id, t.name, t.parent_id, COUNT(ft.file_id) AS file_count
    FROM tags t LEFT JOIN file_tags ft ON ft.tag_id = t.id
    GROUP BY t.id
    ORDER BY t.name COLLATE NOCASE
  `);
  const listForFileStmt = db.prepare<[number]>(`
    SELECT t.id, t.name, t.parent_id
    FROM tags t JOIN file_tags ft ON ft.tag_id = t.id
    WHERE ft.file_id = ?
    ORDER BY t.name COLLATE NOCASE
  `);
  const addToFileStmt = db.prepare<[number, number]>(
    `INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)`
  );
  const removeFromFileStmt = db.prepare<[number, number]>(
    `DELETE FROM file_tags WHERE file_id = ? AND tag_id = ?`
  );
  const deleteStmt = db.prepare<[number]>(`DELETE FROM tags WHERE id = ?`);
  const renameStmt = db.prepare<[string, number]>(`UPDATE tags SET name = ? WHERE id = ?`);
  const setParentStmt = db.prepare<[number | null, number]>(
    `UPDATE tags SET parent_id = ? WHERE id = ?`
  );
  const getByIdStmt = db.prepare<[number]>(
    `SELECT id, name, parent_id FROM tags WHERE id = ?`
  );
  return {
    ensureByName(name, parentId = null) {
      const trimmed = name.trim();
      if (trimmed === '') throw new Error('Tag name cannot be empty');
      // Names are globally unique; an existing tag is returned as-is even if
      // its parent differs from the caller's hint (the parent argument only
      // applies when CREATING a new tag).
      const existing = findByNameStmt.get(trimmed) as RawTagRow | undefined;
      if (existing) return toRecord(existing);
      const result = insertStmt.run(trimmed, parentId);
      return { id: Number(result.lastInsertRowid), name: trimmed, parentId };
    },
    list() {
      return (listStmt.all() as RawTagRow[]).map(toRecord);
    },
    listWithCounts() {
      const rows = listWithCountsStmt.all() as RawTagWithCountRow[];
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        parentId: r.parent_id,
        fileCount: r.file_count
      }));
    },
    listTree() {
      const flat = this.listWithCounts();
      const byParent = new Map<number | null, TagTreeNode[]>();
      for (const t of flat) {
        const node: TagTreeNode = { ...t, children: [] };
        const list = byParent.get(t.parentId) ?? [];
        list.push(node);
        byParent.set(t.parentId, list);
      }
      const attach = (parentId: number | null): TagTreeNode[] => {
        const kids = byParent.get(parentId) ?? [];
        for (const k of kids) {
          k.children = attach(k.id);
        }
        return kids;
      };
      return attach(null);
    },
    listForFile(fileId) {
      return (listForFileStmt.all(fileId) as RawTagRow[]).map(toRecord);
    },
    listForFiles(fileIds) {
      if (fileIds.length === 0) return [];
      const byId = new Map<number, TagWithCount>();
      const CHUNK = 500;
      for (let i = 0; i < fileIds.length; i += CHUNK) {
        const chunk = fileIds.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = db
          .prepare(
            `SELECT t.id, t.name, t.parent_id, COUNT(ft.file_id) AS file_count
             FROM tags t JOIN file_tags ft ON ft.tag_id = t.id
             WHERE ft.file_id IN (${placeholders})
             GROUP BY t.id`
          )
          .all(...chunk) as RawTagWithCountRow[];
        for (const r of rows) {
          const prev = byId.get(r.id);
          if (prev) prev.fileCount += r.file_count;
          else byId.set(r.id, { id: r.id, name: r.name, parentId: r.parent_id, fileCount: r.file_count });
        }
      }
      return [...byId.values()].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );
    },
    addToFile(fileId, tagId) {
      addToFileStmt.run(fileId, tagId);
    },
    removeFromFile(fileId, tagId) {
      removeFromFileStmt.run(fileId, tagId);
    },
    delete(tagId) {
      deleteStmt.run(tagId);
    },
    rename(tagId, newName) {
      const trimmed = newName.trim();
      if (trimmed === '') throw new Error('Tag name cannot be empty');
      renameStmt.run(trimmed, tagId);
      const row = getByIdStmt.get(tagId) as RawTagRow | undefined;
      return row ? toRecord(row) : null;
    },
    setParent(tagId, parentId) {
      // Prevent cycles: parent must not be a descendant of tagId.
      if (parentId != null) {
        const descendants = this.expandToDescendants([tagId]);
        if (descendants.includes(parentId)) {
          throw new Error('Cannot move a tag under its own descendant');
        }
      }
      setParentStmt.run(parentId, tagId);
    },
    expandToDescendants(tagIds) {
      if (tagIds.length === 0) return [];
      const placeholders = tagIds.map(() => '?').join(',');
      const sql = `
        WITH RECURSIVE descendants(id) AS (
          SELECT id FROM tags WHERE id IN (${placeholders})
          UNION
          SELECT t.id FROM tags t
            JOIN descendants d ON t.parent_id = d.id
        )
        SELECT id FROM descendants
      `;
      const rows = db.prepare(sql).all(...tagIds) as { id: number }[];
      return rows.map((r) => r.id);
    }
  };
}
