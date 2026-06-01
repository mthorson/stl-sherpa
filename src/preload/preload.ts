import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, IPC_EVENT } from '@shared/ipc-channels';
import type {
  AddLibraryRequest,
  AddLibraryResult,
  BatchRenameItem,
  BatchRenameResult,
  CameraState,
  CollectionRecord,
  CollectionWithCount,
  DeleteFileResult,
  DuplicateFileResult,
  ExportResult,
  FileQueryRequest,
  FileRecord,
  FolderTreeNode,
  GetFileRequest,
  IpcApi,
  LibraryFilesEvent,
  LibrarySummary,
  ListFilesRequest,
  ListFoldersRequest,
  MoveFileResult,
  PickFolderResult,
  RemoveLibraryRequest,
  RemoveLibraryResult,
  RenameLibraryRequest,
  RenameLibraryResult,
  RevealLibraryResult,
  ScanProgress,
  TagRecord,
  TagTreeNode,
  TagWithCount
} from '@shared/types';
import type { LightingStyle } from '@shared/lighting-types';
import type { FileOrientation } from '@shared/orientation';
import type { ColorLabel } from '@shared/ratings';
import type { ExternalAppRegistration, PreferencesFile } from '@shared/preferences';
import type { SmartQuery } from '@shared/smart-query';

const api: IpcApi = {
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder) as Promise<PickFolderResult>,
  listLibraries: () => ipcRenderer.invoke(IPC.listLibraries) as Promise<LibrarySummary[]>,
  addLibrary: (req: AddLibraryRequest) =>
    ipcRenderer.invoke(IPC.addLibrary, req) as Promise<AddLibraryResult>,
  removeLibrary: (req: RemoveLibraryRequest) =>
    ipcRenderer.invoke(IPC.removeLibrary, req) as Promise<RemoveLibraryResult>,
  renameLibrary: (req: RenameLibraryRequest) =>
    ipcRenderer.invoke(IPC.renameLibrary, req) as Promise<RenameLibraryResult>,
  revealLibrary: (id: string) =>
    ipcRenderer.invoke(IPC.revealLibrary, id) as Promise<RevealLibraryResult>,

  listFolders: (req: ListFoldersRequest) =>
    ipcRenderer.invoke(IPC.listFolders, req) as Promise<FolderTreeNode | null>,
  listFiles: (req: ListFilesRequest) =>
    ipcRenderer.invoke(IPC.listFiles, req) as Promise<FileRecord[]>,
  getFile: (req: GetFileRequest) =>
    ipcRenderer.invoke(IPC.getFile, req) as Promise<FileRecord | null>,
  rescan: (libraryId: string) =>
    ipcRenderer.invoke(IPC.rescan, libraryId) as Promise<{ ok: boolean; error?: string }>,
  getScanStatus: (libraryId: string) =>
    ipcRenderer.invoke(IPC.getScanStatus, libraryId) as Promise<ScanProgress | null>,

  bumpVisibleThumbs: (libraryId: string, fileIds: number[]) =>
    ipcRenderer.invoke(IPC.bumpVisibleThumbs, libraryId, fileIds) as Promise<void>,
  rerenderThumb: (libraryId: string, fileId: number) =>
    ipcRenderer.invoke(IPC.rerenderThumb, libraryId, fileId) as Promise<void>,
  saveCustomThumbnail: (
    libraryId: string,
    fileId: number,
    png: Uint8Array,
    camera?: CameraState | null
  ) =>
    ipcRenderer.invoke(
      IPC.saveCustomThumbnail,
      libraryId,
      fileId,
      png,
      camera
    ) as Promise<void>,
  setLightingStyle: (style: LightingStyle) =>
    ipcRenderer.invoke(IPC.setLightingStyle, style) as Promise<void>,
  setFileOrientation: (libraryId: string, fileId: number, orientation: FileOrientation | null) =>
    ipcRenderer.invoke(IPC.setFileOrientation, libraryId, fileId, orientation) as Promise<void>,

  queryFiles: (req: FileQueryRequest) =>
    ipcRenderer.invoke(IPC.queryFiles, req) as Promise<FileRecord[]>,

  listTags: (libraryId: string) =>
    ipcRenderer.invoke(IPC.listTags, libraryId) as Promise<TagWithCount[]>,
  listTagsForFile: (libraryId: string, fileId: number) =>
    ipcRenderer.invoke(IPC.listTagsForFile, libraryId, fileId) as Promise<TagRecord[]>,
  addTagToFile: (libraryId: string, fileId: number, tagName: string) =>
    ipcRenderer.invoke(IPC.addTagToFile, libraryId, fileId, tagName) as Promise<TagRecord>,
  removeTagFromFile: (libraryId: string, fileId: number, tagId: number) =>
    ipcRenderer.invoke(IPC.removeTagFromFile, libraryId, fileId, tagId) as Promise<void>,
  deleteTag: (libraryId: string, tagId: number) =>
    ipcRenderer.invoke(IPC.deleteTag, libraryId, tagId) as Promise<void>,
  addTagToFiles: (libraryId: string, fileIds: number[], tagName: string) =>
    ipcRenderer.invoke(IPC.addTagToFiles, libraryId, fileIds, tagName) as Promise<TagRecord>,
  removeTagFromFiles: (libraryId: string, fileIds: number[], tagId: number) =>
    ipcRenderer.invoke(IPC.removeTagFromFiles, libraryId, fileIds, tagId) as Promise<void>,
  setFileOrientations: (libraryId: string, fileIds: number[], orientation: FileOrientation | null) =>
    ipcRenderer.invoke(IPC.setFileOrientations, libraryId, fileIds, orientation) as Promise<void>,
  rerenderThumbs: (libraryId: string, fileIds: number[]) =>
    ipcRenderer.invoke(IPC.rerenderThumbs, libraryId, fileIds) as Promise<void>,
  setFileRatings: (libraryId: string, fileIds: number[], rating: number) =>
    ipcRenderer.invoke(IPC.setFileRatings, libraryId, fileIds, rating) as Promise<void>,
  setFileColorLabels: (libraryId: string, fileIds: number[], label: ColorLabel | null) =>
    ipcRenderer.invoke(IPC.setFileColorLabels, libraryId, fileIds, label) as Promise<void>,

  listCollections: (libraryId: string) =>
    ipcRenderer.invoke(IPC.listCollections, libraryId) as Promise<CollectionWithCount[]>,
  createCollection: (libraryId: string, name: string) =>
    ipcRenderer.invoke(IPC.createCollection, libraryId, name) as Promise<CollectionRecord>,
  renameCollection: (libraryId: string, id: number, name: string) =>
    ipcRenderer.invoke(IPC.renameCollection, libraryId, id, name) as Promise<CollectionRecord | null>,
  deleteCollection: (libraryId: string, id: number) =>
    ipcRenderer.invoke(IPC.deleteCollection, libraryId, id) as Promise<void>,
  addFilesToCollection: (libraryId: string, collectionId: number, fileIds: number[]) =>
    ipcRenderer.invoke(IPC.addFilesToCollection, libraryId, collectionId, fileIds) as Promise<void>,
  removeFilesFromCollection: (libraryId: string, collectionId: number, fileIds: number[]) =>
    ipcRenderer.invoke(IPC.removeFilesFromCollection, libraryId, collectionId, fileIds) as Promise<void>,
  createSmartCollection: (libraryId: string, name: string, query: SmartQuery) =>
    ipcRenderer.invoke(IPC.createSmartCollection, libraryId, name, query) as Promise<CollectionRecord>,
  updateSmartQuery: (libraryId: string, id: number, query: SmartQuery) =>
    ipcRenderer.invoke(IPC.updateSmartQuery, libraryId, id, query) as Promise<CollectionRecord | null>,

  listExternalApps: () =>
    ipcRenderer.invoke(IPC.listExternalApps) as Promise<ExternalAppRegistration[]>,
  addExternalApp: (extensions: string[]) =>
    ipcRenderer.invoke(IPC.addExternalApp, extensions) as Promise<ExternalAppRegistration | null>,
  removeExternalApp: (id: string) =>
    ipcRenderer.invoke(IPC.removeExternalApp, id) as Promise<void>,
  setDefaultExternalApp: (id: string, ext: string) =>
    ipcRenderer.invoke(IPC.setDefaultExternalApp, id, ext) as Promise<void>,
  openWithExternalApp: (
    libraryId: string,
    fileId: number,
    appId: string | null,
    profileId: string | null = null
  ) =>
    ipcRenderer.invoke(
      IPC.openWithExternalApp,
      libraryId,
      fileId,
      appId,
      profileId
    ) as Promise<void>,
  revealFile: (libraryId: string, fileId: number) =>
    ipcRenderer.invoke(IPC.revealFile, libraryId, fileId) as Promise<void>,
  batchRename: (libraryId: string, plan: BatchRenameItem[]) =>
    ipcRenderer.invoke(IPC.batchRename, libraryId, plan) as Promise<BatchRenameResult>,
  setFileNotes: (libraryId: string, fileId: number, notes: string) =>
    ipcRenderer.invoke(IPC.setFileNotes, libraryId, fileId, notes) as Promise<void>,
  rebuildThumbCache: (libraryId: string) =>
    ipcRenderer.invoke(IPC.rebuildThumbCache, libraryId) as Promise<void>,
  purgeOrphanThumbs: (libraryId: string) =>
    ipcRenderer.invoke(IPC.purgeOrphanThumbs, libraryId) as Promise<{ removed: number }>,
  getPreferences: () => ipcRenderer.invoke(IPC.getPreferences) as Promise<PreferencesFile>,
  setPreferences: (prefs: PreferencesFile) =>
    ipcRenderer.invoke(IPC.setPreferences, prefs) as Promise<void>,

  listTagTree: (libraryId: string) =>
    ipcRenderer.invoke(IPC.listTagTree, libraryId) as Promise<TagTreeNode[]>,
  setTagParent: (libraryId: string, tagId: number, parentId: number | null) =>
    ipcRenderer.invoke(IPC.setTagParent, libraryId, tagId, parentId) as Promise<void>,
  createTagUnderParent: (libraryId: string, name: string, parentId: number | null) =>
    ipcRenderer.invoke(IPC.createTagUnderParent, libraryId, name, parentId) as Promise<TagRecord>,

  moveFile: (libraryId: string, fileId: number, toParentDir: string) =>
    ipcRenderer.invoke(IPC.moveFile, libraryId, fileId, toParentDir) as Promise<MoveFileResult>,
  duplicateFile: (libraryId: string, fileId: number) =>
    ipcRenderer.invoke(IPC.duplicateFile, libraryId, fileId) as Promise<DuplicateFileResult>,
  deleteFile: (libraryId: string, fileId: number) =>
    ipcRenderer.invoke(IPC.deleteFile, libraryId, fileId) as Promise<DeleteFileResult>,

  exportCollectionZip: (libraryId: string, collectionId: number) =>
    ipcRenderer.invoke(IPC.exportCollectionZip, libraryId, collectionId) as Promise<ExportResult>,
  exportContactSheet: (libraryId: string, fileIds: number[]) =>
    ipcRenderer.invoke(IPC.exportContactSheet, libraryId, fileIds) as Promise<ExportResult>,

  openLogsFolder: () => ipcRenderer.invoke(IPC.openLogsFolder) as Promise<void>,
  openTrash: () => ipcRenderer.invoke(IPC.openTrash) as Promise<void>,
  undo: () =>
    ipcRenderer.invoke(IPC.undo) as Promise<
      | { ok: false; reason: 'empty' }
      | { ok: true; label: string }
      | { ok: false; reason: 'failed'; label: string; error: string }
    >,

  onLibraryEvent: (handler: (event: LibraryFilesEvent) => void) => {
    const listener = (_e: IpcRendererEvent, event: LibraryFilesEvent) => handler(event);
    ipcRenderer.on(IPC_EVENT.libraryEvent, listener);
    return () => {
      ipcRenderer.off(IPC_EVENT.libraryEvent, listener);
    };
  }
};

contextBridge.exposeInMainWorld('meshFlask', api);
