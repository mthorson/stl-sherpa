import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canRun, freshDb } from '@main/db/test-utils';
import { createFilesRepo } from '@main/db/repos/files';
import { createTagsRepo } from '@main/db/repos/tags';
import { PathResolver } from '@shared/paths';
import { applyBatchRename } from './batch-rename';

describe.runIf(canRun)('batch rename disk/database consistency', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'meshflask-batch-'));
    const db = freshDb();
    cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
    const files = createFilesRepo(db, 'lib');
    const tags = createTagsRepo(db);
    for (const name of ['a.stl', 'b.stl', 'c.stl']) {
      writeFileSync(join(root, name), name);
      files.upsert({ relPath: name, parentDir: '', filename: name, ext: 'stl', sizeBytes: 5, mtimeMs: 1 });
    }
    const records = files.query({});
    files.setNotes(records[0].id, 'keep my notes');
    tags.addToFile(records[0].id, tags.ensureByName('keep').id);
    const plan = records.map((file, i) => ({ fileId: file.id, fromRelPath: file.relPath, toRelPath: records[(i + 1) % 3].relPath }));
    return { root, db, files, tags, plan, resolver: new PathResolver(root) };
  }

  it('cycles three filenames and undoes the cycle without moving annotations between models', async () => {
    const { root, files, tags, plan, resolver } = setup();
    expect(await applyBatchRename(resolver, files, plan)).toEqual({ ok: true });
    for (const item of plan) {
      expect(readFileSync(join(root, item.toRelPath), 'utf8')).toBe(item.fromRelPath);
      expect(files.getById(item.fileId)?.relPath).toBe(item.toRelPath);
    }
    expect(files.getById(plan[0].fileId)?.notes).toBe('keep my notes');
    expect(tags.listForFile(plan[0].fileId).map((tag) => tag.name)).toEqual(['keep']);
    const inverse = plan.map((item) => ({ fileId: item.fileId, fromRelPath: item.toRelPath, toRelPath: item.fromRelPath }));
    expect(await applyBatchRename(resolver, files, inverse)).toEqual({ ok: true });
    expect(readFileSync(join(root, 'a.stl'), 'utf8')).toBe('a.stl');
  });

  it('restores every disk path when SQLite rejects a final rename', async () => {
    const { root, db, files, plan, resolver } = setup();
    db.exec("CREATE TRIGGER reject_rename BEFORE UPDATE OF filename ON files BEGIN SELECT RAISE(ABORT, 'simulated database failure'); END");
    expect(await applyBatchRename(resolver, files, plan)).toMatchObject({ ok: false, error: 'simulated database failure' });
    for (const item of plan) {
      expect(readFileSync(join(root, item.fromRelPath), 'utf8')).toBe(item.fromRelPath);
      expect(files.getById(item.fileId)?.relPath).toBe(item.fromRelPath);
    }
    expect(readdirSync(root).sort()).toEqual(['a.stl', 'b.stl', 'c.stl']);
  });

  it('rejects a destination occupied after the preview was built', async () => {
    const { root, files, plan, resolver } = setup();
    writeFileSync(join(root, 'new.stl'), 'unrelated file');
    expect(await applyBatchRename(resolver, files, [{ ...plan[0], toRelPath: 'new.stl' }])).toMatchObject({ ok: false });
    expect(readFileSync(join(root, 'new.stl'), 'utf8')).toBe('unrelated file');
    expect(readFileSync(join(root, 'a.stl'), 'utf8')).toBe('a.stl');
  });
});
