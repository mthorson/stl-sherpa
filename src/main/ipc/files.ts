import { ipcMain, shell } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { IPC } from '@shared/ipc-channels';
import { broadcastLibraryEvent } from '@main/events';
import type {
  BatchRenameItem,
  BatchRenameResult,
  DeleteFileResult,
  DuplicateFileResult,
  FileQueryRequest,
  FileRecord,
  FolderTreeNode,
  GetFileRequest,
  ListFilesRequest,
  ListFoldersRequest,
  MoveFileResult,
  ScanProgress
} from '@shared/types';
import { buildFolderTree } from '@shared/folder-tree';
import { isLightingStyle } from '@shared/lighting-types';
import { isDefaultOrientation, isFileOrientation } from '@shared/orientation';
import { isColorLabel, isValidRating } from '@shared/ratings';
import { isCameraState } from '@shared/types';
import { getOpenLibrary } from '@main/libraries/manager';
import { scanner } from '@main/scanner/service';
import { queueRunner } from '@main/thumb-pool/queue-runner';
import { undoQueue } from '@main/undo/queue';
import { moveOnDisk, renameEntryFor } from '@main/files/move-service';

const broadcast = broadcastLibraryEvent;

/**
 * Reverse a single move/rename: rename the file back to `fromRelPath` on
 * disk, then update the DB to match. Returns ok/error rather than throwing
 * so the undo runner can surface the failure to the user without crashing.
 */
async function reverseRename(
  libraryId: string,
  fileId: number,
  fromRelPath: string,
  toRelPath: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const lib = getOpenLibrary(libraryId);
  if (!lib) return { ok: false, error: 'Library no longer open' };
  const absCurrent = lib.resolver.toAbsolute(toRelPath);
  const absOriginal = lib.resolver.toAbsolute(fromRelPath);
  try {
    if (!existsSync(absCurrent)) {
      return { ok: false, error: `File no longer at ${toRelPath}` };
    }
    if (existsSync(absOriginal)) {
      return { ok: false, error: `Original path is occupied: ${fromRelPath}` };
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const moved = await moveOnDisk(absCurrent, absOriginal);
  if (!moved.ok) return moved;
  lib.files.applyRenames([renameEntryFor(fileId, fromRelPath)]);
  broadcast({ kind: 'files-changed', libraryId });
  return { ok: true };
}

export function registerFilesIpc(): void {
  ipcMain.handle(
    IPC.listFolders,
    async (_e, req: ListFoldersRequest): Promise<FolderTreeNode | null> => {
      const lib = getOpenLibrary(req.libraryId);
      if (!lib) return null;
      const records = lib.files.listFoldersWithCounts();
      return buildFolderTree(records, lib.entry.label);
    }
  );

  ipcMain.handle(
    IPC.listFiles,
    async (_e, req: ListFilesRequest): Promise<FileRecord[]> => {
      const lib = getOpenLibrary(req.libraryId);
      if (!lib) return [];
      return lib.files.listInFolder(req.parentDir);
    }
  );

  ipcMain.handle(IPC.getFile, async (_e, req: GetFileRequest): Promise<FileRecord | null> => {
    const lib = getOpenLibrary(req.libraryId);
    if (!lib) return null;
    return lib.files.getById(req.fileId);
  });

  ipcMain.handle(IPC.rescan, async (_e, libraryId: string) => {
    return scanner.rescan(libraryId);
  });

  ipcMain.handle(IPC.getScanStatus, async (_e, libraryId: string): Promise<ScanProgress | null> => {
    return scanner.getProgress(libraryId);
  });

  ipcMain.handle(IPC.cancelScan, async (_e, libraryId: string) => {
    scanner.cancelScan(libraryId);
  });

  ipcMain.handle(IPC.bumpVisibleThumbs, async (_e, libraryId: string, fileIds: number[]) => {
    const lib = getOpenLibrary(libraryId);
    if (lib) queueRunner.bumpVisible(lib, fileIds);
  });

  ipcMain.handle(IPC.rerenderThumb, async (_e, libraryId: string, fileId: number) => {
    const lib = getOpenLibrary(libraryId);
    if (lib) queueRunner.forceRerender(lib, fileId);
  });

  ipcMain.handle(
    IPC.saveCustomThumbnail,
    async (
      _e,
      libraryId: string,
      fileId: number,
      png: Uint8Array,
      camera: unknown
    ) => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return;
      await queueRunner.saveCustomThumbnail(lib, fileId, png);
      // Persist the camera state alongside the thumb so reopening the file
      // restarts the preview at the same angle the user composed. Caller may
      // omit it (legacy code path); we then leave any existing saved camera
      // untouched.
      if (camera !== undefined) {
        lib.files.setCamera(fileId, isCameraState(camera) ? camera : null);
        broadcast({ kind: 'files-changed', libraryId });
      }
    }
  );

  ipcMain.handle(IPC.setLightingStyle, async (_e, style: string) => {
    if (isLightingStyle(style)) queueRunner.setLightingStyle(style);
  });

  ipcMain.handle(
    IPC.setFileOrientation,
    async (_e, libraryId: string, fileId: number, orientation: unknown) => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return;
      const file = lib.files.getById(fileId);
      if (!file) return;
      // Normalize: if the caller submits the format default (e.g. they
      // rotated back), clear the override so orientationCustomized goes
      // false. Otherwise store the explicit override.
      let value: import('@shared/orientation').FileOrientation | null;
      if (orientation === null) value = null;
      else if (!isFileOrientation(orientation)) value = null;
      else if (isDefaultOrientation(orientation, file.ext)) value = null;
      else value = orientation;
      lib.files.setOrientation(fileId, value);
      // Broadcast so any open grid refreshes its cached FileRecord, then
      // re-render the thumbnail at high priority so the new orientation
      // shows up in the grid without the user picking the file again.
      broadcast({ kind: 'files-changed', libraryId });
      queueRunner.forceRerender(lib, fileId);
    }
  );

  ipcMain.handle(
    IPC.setFileOrientations,
    async (_e, libraryId: string, fileIds: number[], orientation: unknown) => {
      const lib = getOpenLibrary(libraryId);
      if (!lib || fileIds.length === 0) return;
      // Validate orientation once; allow null to clear. Invalid input is a noop.
      let value: import('@shared/orientation').FileOrientation | null;
      if (orientation === null) value = null;
      else if (!isFileOrientation(orientation)) return;
      else value = orientation;

      const tx = lib.db.transaction((ids: number[]) => {
        for (const fid of ids) {
          const file = lib.files.getById(fid);
          if (!file) continue;
          // Same normalize-to-default rule as the single-file IPC.
          const normalized =
            value === null
              ? null
              : isDefaultOrientation(value, file.ext)
                ? null
                : value;
          lib.files.setOrientation(fid, normalized);
        }
      });
      tx(fileIds);
      broadcast({ kind: 'files-changed', libraryId });
      for (const fid of fileIds) queueRunner.forceRerender(lib, fid);
    }
  );

  ipcMain.handle(IPC.rerenderThumbs, async (_e, libraryId: string, fileIds: number[]) => {
    const lib = getOpenLibrary(libraryId);
    if (!lib) return;
    for (const fid of fileIds) queueRunner.forceRerender(lib, fid);
  });

  ipcMain.handle(
    IPC.setFileRatings,
    async (_e, libraryId: string, fileIds: number[], rating: unknown) => {
      const lib = getOpenLibrary(libraryId);
      if (!lib || fileIds.length === 0) return;
      if (!isValidRating(rating)) return;
      const changed = lib.files.setRatings(fileIds, rating);
      if (changed > 0) broadcast({ kind: 'files-changed', libraryId });
    }
  );

  ipcMain.handle(
    IPC.setFileNotes,
    async (_e, libraryId: string, fileId: number, notes: string) => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return;
      if (typeof notes !== 'string') return;
      lib.files.setNotes(fileId, notes);
      broadcast({ kind: 'files-changed', libraryId });
    }
  );

  ipcMain.handle(
    IPC.setFileColorLabels,
    async (_e, libraryId: string, fileIds: number[], label: unknown) => {
      const lib = getOpenLibrary(libraryId);
      if (!lib || fileIds.length === 0) return;
      let value: import('@shared/ratings').ColorLabel | null;
      if (label === null) value = null;
      else if (!isColorLabel(label)) return;
      else value = label;
      const changed = lib.files.setColorLabels(fileIds, value);
      if (changed > 0) broadcast({ kind: 'files-changed', libraryId });
    }
  );

  ipcMain.handle(
    IPC.batchRename,
    async (_e, libraryId: string, plan: BatchRenameItem[]): Promise<BatchRenameResult> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return { ok: false, error: `Library ${libraryId} not open` };
      if (plan.length === 0) return { ok: true, renamed: 0 };

      // Pre-flight collision detection. A new path collides if:
      //   - It exists in the plan more than once, OR
      //   - It already exists in the DB on a file NOT in the plan, OR
      //   - It already exists on disk in a location not covered by the plan.
      const inPlan = new Set(plan.map((p) => p.fileId));
      const toPathCounts = new Map<string, number>();
      for (const p of plan) toPathCounts.set(p.toRelPath, (toPathCounts.get(p.toRelPath) ?? 0) + 1);
      const collisions: string[] = [];
      for (const [path, count] of toPathCounts) {
        if (count > 1) collisions.push(path);
      }
      for (const p of plan) {
        const existing = lib.files.getByRelPath(p.toRelPath);
        if (existing && !inPlan.has(existing.id)) collisions.push(p.toRelPath);
      }
      // Same source path twice in the plan is suspicious — guard.
      const seenFrom = new Set<string>();
      for (const p of plan) {
        if (seenFrom.has(p.fromRelPath)) collisions.push(p.fromRelPath);
        seenFrom.add(p.fromRelPath);
      }
      if (collisions.length > 0) {
        return { ok: false, collisions: [...new Set(collisions)] };
      }

      // Execute FS renames sequentially. On failure, rolling back what's
      // already happened keeps DB and disk in sync.
      const done: Array<{ absFrom: string; absTo: string }> = [];
      try {
        for (const item of plan) {
          const absFrom = lib.resolver.toAbsolute(item.fromRelPath);
          const absTo = lib.resolver.toAbsolute(item.toRelPath);
          // Bail if the source doesn't exist on disk anymore — the watcher
          // may have already moved it.
          if (!existsSync(absFrom)) {
            throw new Error(`Source file missing: ${item.fromRelPath}`);
          }
          // moveOnDisk ensures the destination directory exists (a noop when
          // the template only changes the basename). Throw on failure to
          // trigger the rollback below.
          const moved = await moveOnDisk(absFrom, absTo);
          if (!moved.ok) throw new Error(moved.error);
          done.push({ absFrom, absTo });
        }
      } catch (err) {
        // Roll back each completed move in reverse order. Best-effort: if a
        // rollback fails the remaining ones still try.
        for (let i = done.length - 1; i >= 0; i--) {
          await moveOnDisk(done[i].absTo, done[i].absFrom);
        }
        return { ok: false, error: (err as Error).message };
      }

      // Apply the rename to the DB. The scanner's `applyRenames` does the
      // right thing (UPDATE rel_path/parent_dir/filename, updated_at).
      lib.files.applyRenames(plan.map((p) => renameEntryFor(p.fileId, p.toRelPath)));
      broadcast({ kind: 'files-changed', libraryId });

      // Capture the plan for undo. Reverse order so each individual rename
      // back doesn't collide with a not-yet-undone successor.
      const snapshotPlan = plan.map((p) => ({ ...p }));
      undoQueue.push({
        libraryId,
        label:
          snapshotPlan.length === 1
            ? `Rename ${snapshotPlan[0].fromRelPath.split('/').pop()}`
            : `Rename ${snapshotPlan.length} files`,
        undo: async () => {
          const errors: string[] = [];
          for (let i = snapshotPlan.length - 1; i >= 0; i--) {
            const item = snapshotPlan[i];
            const r = await reverseRename(libraryId, item.fileId, item.fromRelPath, item.toRelPath);
            if (!r.ok) errors.push(`${item.toRelPath}: ${r.error}`);
          }
          if (errors.length > 0) {
            return { ok: false, error: errors.join('; ') };
          }
          return { ok: true };
        }
      });

      return { ok: true, renamed: plan.length };
    }
  );

  ipcMain.handle(
    IPC.moveFile,
    async (_e, libraryId: string, fileId: number, toParentDir: string): Promise<MoveFileResult> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return { ok: false, error: `Library ${libraryId} not open` };
      const file = lib.files.getById(fileId);
      if (!file) return { ok: false, error: 'File not found' };
      const cleanedParent = toParentDir.replace(/^\/+|\/+$/g, '');
      const toRelPath = cleanedParent ? `${cleanedParent}/${file.filename}` : file.filename;
      if (toRelPath === file.relPath) return { ok: true, toRelPath };

      const existing = lib.files.getByRelPath(toRelPath);
      if (existing) return { ok: false, error: `A file already exists at ${toRelPath}` };

      const absFrom = lib.resolver.toAbsolute(file.relPath);
      const absTo = lib.resolver.toAbsolute(toRelPath);
      const moved = await moveOnDisk(absFrom, absTo);
      if (!moved.ok) return moved;
      lib.files.applyRenames([renameEntryFor(fileId, toRelPath)]);
      broadcast({ kind: 'files-changed', libraryId });

      const fromRel = file.relPath;
      undoQueue.push({
        libraryId,
        label: `Move ${file.filename}`,
        undo: () => reverseRename(libraryId, fileId, fromRel, toRelPath)
      });

      return { ok: true, toRelPath };
    }
  );

  ipcMain.handle(
    IPC.duplicateFile,
    async (_e, libraryId: string, fileId: number): Promise<DuplicateFileResult> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return { ok: false, error: `Library ${libraryId} not open` };
      const file = lib.files.getById(fileId);
      if (!file) return { ok: false, error: 'File not found' };

      // Generate "<name> copy[.N].<ext>" — increments N until free on disk + DB.
      const dot = file.filename.lastIndexOf('.');
      const base = dot < 0 ? file.filename : file.filename.slice(0, dot);
      const ext = dot < 0 ? '' : file.filename.slice(dot);
      let candidate = `${base} copy${ext}`;
      let n = 2;
      const parent = file.parentDir;
      const toRel = (name: string) => (parent ? `${parent}/${name}` : name);
      while (
        lib.files.getByRelPath(toRel(candidate)) != null ||
        existsSync(lib.resolver.toAbsolute(toRel(candidate)))
      ) {
        candidate = `${base} copy ${n}${ext}`;
        n++;
        if (n > 1000) return { ok: false, error: 'Could not find an available name' };
      }
      const toRelPath = toRel(candidate);
      const absFrom = lib.resolver.toAbsolute(file.relPath);
      const absTo = lib.resolver.toAbsolute(toRelPath);
      try {
        await copyFile(absFrom, absTo);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
      // The watcher will eventually pick up the new file, but proactively
      // upsert + broadcast for snappier UI.
      try {
        const stat = statSync(absTo);
        lib.files.upsert({
          relPath: toRelPath,
          parentDir: parent,
          filename: candidate,
          ext: file.ext,
          sizeBytes: stat.size,
          mtimeMs: Math.floor(stat.mtimeMs)
        });
      } catch {
        // best-effort; watcher will catch it shortly
      }
      broadcast({ kind: 'files-changed', libraryId });
      return { ok: true, toRelPath };
    }
  );

  ipcMain.handle(
    IPC.deleteFile,
    async (_e, libraryId: string, fileId: number): Promise<DeleteFileResult> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return { ok: false, error: `Library ${libraryId} not open` };
      const file = lib.files.getById(fileId);
      if (!file) return { ok: true }; // already gone
      const absPath = lib.resolver.toAbsolute(file.relPath);
      try {
        if (existsSync(absPath)) {
          await shell.trashItem(absPath);
        }
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
      lib.files.deleteByRelPath(file.relPath);
      broadcast({ kind: 'files-changed', libraryId });
      // Surface the trashing so the renderer can offer "Show in Trash" —
      // shell.trashItem has no programmatic restore counterpart, so this is
      // the closest thing we can give the user to an Undo for delete.
      broadcast({ kind: 'file-trashed', libraryId, relPath: file.relPath });
      return { ok: true };
    }
  );

  ipcMain.handle(IPC.queryFiles, async (_e, req: FileQueryRequest): Promise<FileRecord[]> => {
    const lib = getOpenLibrary(req.libraryId);
    if (!lib) return [];
    const { libraryId: _, ...rest } = req;
    return lib.files.query(rest);
  });

  // Forward scanner events to every renderer window. Renderers filter by libraryId.
  scanner.on('scan-progress', (libraryId: string, progress: ScanProgress) => {
    broadcast({ kind: 'scan-progress', libraryId, progress });
  });
  scanner.on('scan-complete', (libraryId: string, progress: ScanProgress) => {
    broadcast({ kind: 'scan-complete', libraryId, progress });
    const lib = getOpenLibrary(libraryId);
    if (lib) queueRunner.reconcile(lib);
  });
  scanner.on('scan-cancelled', (libraryId: string, progress: ScanProgress) => {
    broadcast({ kind: 'scan-cancelled', libraryId, progress });
  });
  scanner.on('files-changed', (libraryId: string) => {
    broadcast({ kind: 'files-changed', libraryId });
    const lib = getOpenLibrary(libraryId);
    if (lib) queueRunner.reconcile(lib);
  });

  queueRunner.on('thumb-rendered', (libraryId: string, fileId: number) => {
    broadcast({ kind: 'thumb-rendered', libraryId, fileId });
  });
  queueRunner.on('thumb-failed', (libraryId: string, fileId: number, error: string) => {
    broadcast({ kind: 'thumb-failed', libraryId, fileId, error });
  });
}
