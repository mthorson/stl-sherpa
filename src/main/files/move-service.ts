import { mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { scopedLogger } from '@main/logger';

const log = scopedLogger('file-move');
import type { RenameEntry } from '@main/db/repos/files';
import {
  assertDestinationInsideLibrary,
  assertExistingPathInsideLibrary
} from '@main/files/path-safety';

/**
 * Reusable mechanics for moving/renaming a file on disk and reflecting the
 * change in the DB. These functions own the "how" only — no library lookup,
 * collision policy, undo registration, or event broadcasting. Callers (the
 * IPC actions) keep those domain decisions.
 */

/** Split a forward-slash rel path into its parent dir and basename. */
export function splitRelPath(relPath: string): { parentDir: string; filename: string } {
  const slash = relPath.lastIndexOf('/');
  return slash < 0
    ? { parentDir: '', filename: relPath }
    : { parentDir: relPath.slice(0, slash), filename: relPath.slice(slash + 1) };
}

/** Build the `RenameEntry` shape `FilesRepo.applyRenames` expects from a rel path. */
export function renameEntryFor(fileId: number, toRelPath: string): RenameEntry {
  const { parentDir, filename } = splitRelPath(toRelPath);
  return { id: fileId, toRelPath, toParentDir: parentDir, toFilename: filename };
}

/**
 * Move a file on disk: ensure the destination directory exists, then rename.
 * Returns a structured result instead of throwing so callers can classify the
 * failure (user-facing error vs rollback trigger) themselves.
 */
export async function moveOnDisk(
  libraryRoot: string,
  absFrom: string,
  absTo: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await assertExistingPathInsideLibrary(libraryRoot, absFrom);
    await assertDestinationInsideLibrary(libraryRoot, absTo);
    await mkdir(dirname(absTo), { recursive: true });
    await rename(absFrom, absTo);
    log.debug('moved', { from: absFrom, to: absTo });
    return { ok: true };
  } catch (err) {
    log.warn('move failed', { from: absFrom, to: absTo, error: (err as Error).message });
    return { ok: false, error: (err as Error).message };
  }
}
