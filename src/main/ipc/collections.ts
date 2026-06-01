import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type {
  CollectionRecord,
  CollectionWithCount
} from '@shared/types';
import { getOpenLibrary } from '@main/libraries/manager';
import { isSmartQuery } from '@shared/smart-query';
import { broadcastLibraryEvent as broadcast } from '@main/events';

export function registerCollectionsIpc(): void {
  ipcMain.handle(
    IPC.listCollections,
    async (_e, libraryId: string): Promise<CollectionWithCount[]> => {
      const lib = getOpenLibrary(libraryId);
      return lib ? lib.collections.listWithCounts() : [];
    }
  );

  ipcMain.handle(
    IPC.createCollection,
    async (_e, libraryId: string, name: string): Promise<CollectionRecord> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) throw new Error(`Library ${libraryId} not open`);
      const created = lib.collections.create(name);
      broadcast({ kind: 'collections-changed', libraryId, collectionId: created.id });
      return created;
    }
  );

  ipcMain.handle(
    IPC.renameCollection,
    async (_e, libraryId: string, id: number, name: string): Promise<CollectionRecord | null> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return null;
      const renamed = lib.collections.rename(id, name);
      if (renamed) broadcast({ kind: 'collections-changed', libraryId, collectionId: id });
      return renamed;
    }
  );

  ipcMain.handle(
    IPC.deleteCollection,
    async (_e, libraryId: string, id: number): Promise<void> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return;
      lib.collections.delete(id);
      broadcast({ kind: 'collections-changed', libraryId, collectionId: id });
    }
  );

  ipcMain.handle(
    IPC.addFilesToCollection,
    async (_e, libraryId: string, collectionId: number, fileIds: number[]): Promise<void> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return;
      lib.collections.addFiles(collectionId, fileIds);
      broadcast({ kind: 'collections-changed', libraryId, collectionId });
    }
  );

  ipcMain.handle(
    IPC.removeFilesFromCollection,
    async (_e, libraryId: string, collectionId: number, fileIds: number[]): Promise<void> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return;
      lib.collections.removeFiles(collectionId, fileIds);
      broadcast({ kind: 'collections-changed', libraryId, collectionId });
    }
  );

  ipcMain.handle(
    IPC.createSmartCollection,
    async (_e, libraryId: string, name: string, query: unknown): Promise<CollectionRecord> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) throw new Error(`Library ${libraryId} not open`);
      const validated = isSmartQuery(query) ? query : {};
      const created = lib.collections.createSmart(name, validated);
      broadcast({ kind: 'collections-changed', libraryId, collectionId: created.id });
      return created;
    }
  );

  ipcMain.handle(
    IPC.updateSmartQuery,
    async (_e, libraryId: string, id: number, query: unknown): Promise<CollectionRecord | null> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return null;
      const validated = isSmartQuery(query) ? query : {};
      const updated = lib.collections.updateSmartQuery(id, validated);
      if (updated) broadcast({ kind: 'collections-changed', libraryId, collectionId: id });
      return updated;
    }
  );
}
