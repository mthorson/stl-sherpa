import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { BatchRenameItem } from '@shared/types';
import type { PathResolver } from '@shared/paths';
import type { FilesRepo } from '@main/db/repos/files';
import { moveOnDisk, renameEntryFor } from './move-service';
import { scopedLogger } from '@main/logger';

const log = scopedLogger('batch-rename');

/** Caller pauses the watcher so intermediate disk paths never become catalog rows. */
export async function applyBatchRename(
  resolver: PathResolver,
  files: FilesRepo,
  plan: BatchRenameItem[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  const root = resolver.getMountPath();
  log.debug('batch started', { root, count: plan.length });
  const staged: Array<{ from: string; temp: string; to: string }> = [];
  const finalized: typeof staged = [];
  try {
    // Recheck after acquiring the mutation slot (also protects Undo).
    const sources = new Set(plan.map((item) => item.fromRelPath));
    for (const item of plan) {
      if (files.getById(item.fileId)?.relPath !== item.fromRelPath) {
        throw new Error(`File no longer at ${item.fromRelPath}`);
      }
      if (!sources.has(item.toRelPath) && existsSync(resolver.toAbsolute(item.toRelPath))) {
        throw new Error(`Destination already exists: ${item.toRelPath}`);
      }
    }
    for (const item of plan) {
      const from = resolver.toAbsolute(item.fromRelPath);
      const to = resolver.toAbsolute(item.toRelPath);
      const temp = `${from}.mf-rename-${randomUUID()}`;
      const moved = await moveOnDisk(root, from, temp);
      if (!moved.ok) throw new Error(moved.error);
      staged.push({ from, temp, to });
    }
    for (const item of staged) {
      if (existsSync(item.to)) throw new Error(`Destination already exists: ${item.to}`);
      const moved = await moveOnDisk(root, item.temp, item.to);
      if (!moved.ok) throw new Error(moved.error);
      finalized.push(item);
    }
    // applyRenames uses a transaction and temporary DB paths for cycles.
    // A failed commit must unwind the disk changes too.
    files.applyRenames(plan.map((item) => renameEntryFor(item.fileId, item.toRelPath)));
    log.debug('batch committed', { root, count: plan.length });
    return { ok: true };
  } catch (err) {
    const failures: string[] = [];
    const restore = async (from: string, to: string) => {
      if (existsSync(to)) {
        failures.push(`Cannot restore ${to}: destination occupied`);
        return;
      }
      const moved = await moveOnDisk(root, from, to);
      if (!moved.ok) failures.push(`${from}: ${moved.error}`);
    };
    for (const item of [...finalized].reverse()) await restore(item.to, item.temp);
    for (const item of [...staged].reverse()) await restore(item.temp, item.from);
    const error = (err as Error).message;
    log.error('batch rolled back', { root, error, rollbackFailures: failures });
    return {
      ok: false,
      error: failures.length ? `${error}. Rollback incomplete: ${failures.join('; ')}` : error
    };
  }
}
