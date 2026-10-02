import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type {
  TagRecord,
  TagTreeNode,
  TagWithCount
} from '@shared/types';
import { getOpenLibrary } from '@main/libraries/manager';
import { broadcastLibraryEvent as broadcast } from '@main/events';

export function registerTagsIpc(): void {
  ipcMain.handle(IPC.listTags, async (_e, libraryId: string): Promise<TagWithCount[]> => {
    const lib = getOpenLibrary(libraryId);
    return lib ? lib.tags.listWithCounts() : [];
  });

  ipcMain.handle(
    IPC.listTagsForFile,
    async (_e, libraryId: string, fileId: number): Promise<TagRecord[]> => {
      const lib = getOpenLibrary(libraryId);
      return lib ? lib.tags.listForFile(fileId) : [];
    }
  );

  ipcMain.handle(
    IPC.listTagsForFiles,
    async (_e, libraryId: string, fileIds: number[]): Promise<TagWithCount[]> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib || !Array.isArray(fileIds)) return [];
      return lib.tags.listForFiles(fileIds.filter(Number.isInteger));
    }
  );

  ipcMain.handle(
    IPC.addTagToFile,
    async (_e, libraryId: string, fileId: number, tagName: string): Promise<TagRecord> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) throw new Error(`Library ${libraryId} not open`);
      const tag = lib.tags.ensureByName(tagName);
      lib.tags.addToFile(fileId, tag.id);
      broadcast({ kind: 'tags-changed', libraryId, fileId });
      return tag;
    }
  );

  ipcMain.handle(
    IPC.removeTagFromFile,
    async (_e, libraryId: string, fileId: number, tagId: number): Promise<void> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return;
      lib.tags.removeFromFile(fileId, tagId);
      broadcast({ kind: 'tags-changed', libraryId, fileId });
    }
  );

  ipcMain.handle(
    IPC.deleteTag,
    async (_e, libraryId: string, tagId: number): Promise<void> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return;
      lib.tags.delete(tagId);
      broadcast({ kind: 'tags-changed', libraryId });
    }
  );

  // Bulk variants: one transaction + one broadcast for many files, so the
  // renderer doesn't fire N grid refreshes when the user tags a 30-item batch.
  ipcMain.handle(
    IPC.addTagToFiles,
    async (_e, libraryId: string, fileIds: number[], tagName: string): Promise<TagRecord> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) throw new Error(`Library ${libraryId} not open`);
      const tag = lib.tags.ensureByName(tagName);
      if (fileIds.length > 0) {
        const tx = lib.db.transaction((ids: number[]) => {
          for (const fid of ids) lib.tags.addToFile(fid, tag.id);
        });
        tx(fileIds);
        broadcast({ kind: 'tags-changed', libraryId });
      }
      return tag;
    }
  );

  ipcMain.handle(
    IPC.removeTagFromFiles,
    async (_e, libraryId: string, fileIds: number[], tagId: number): Promise<void> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib || fileIds.length === 0) return;
      const tx = lib.db.transaction((ids: number[]) => {
        for (const fid of ids) lib.tags.removeFromFile(fid, tagId);
      });
      tx(fileIds);
      broadcast({ kind: 'tags-changed', libraryId });
    }
  );

  ipcMain.handle(
    IPC.listTagTree,
    async (_e, libraryId: string): Promise<TagTreeNode[]> => {
      const lib = getOpenLibrary(libraryId);
      return lib ? lib.tags.listTree() : [];
    }
  );

  ipcMain.handle(
    IPC.setTagParent,
    async (_e, libraryId: string, tagId: number, parentId: number | null): Promise<void> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return;
      try {
        lib.tags.setParent(tagId, parentId);
        broadcast({ kind: 'tags-changed', libraryId });
      } catch {
        // ignore cycle errors silently — UI can guard
      }
    }
  );

  ipcMain.handle(
    IPC.createTagUnderParent,
    async (
      _e,
      libraryId: string,
      name: string,
      parentId: number | null
    ): Promise<TagRecord> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) throw new Error(`Library ${libraryId} not open`);
      const created = lib.tags.ensureByName(name, parentId);
      broadcast({ kind: 'tags-changed', libraryId });
      return created;
    }
  );
}
