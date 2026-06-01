export const IPC = {
  pickFolder: 'dialog:pickFolder',
  listLibraries: 'library:list',
  addLibrary: 'library:add',
  removeLibrary: 'library:remove',
  renameLibrary: 'library:rename',
  revealLibrary: 'library:reveal',
  listFolders: 'files:listFolders',
  listFiles: 'files:listFiles',
  getFile: 'files:get',
  rescan: 'library:rescan',
  getScanStatus: 'library:getScanStatus',
  bumpVisibleThumbs: 'thumbs:bumpVisible',
  rerenderThumb: 'thumbs:rerender',
  saveCustomThumbnail: 'thumbs:saveCustom',
  setLightingStyle: 'thumbs:setLightingStyle',
  setFileOrientation: 'files:setOrientation',
  queryFiles: 'files:query',
  listTags: 'tags:list',
  listTagsForFile: 'tags:listForFile',
  addTagToFile: 'tags:addToFile',
  removeTagFromFile: 'tags:removeFromFile',
  deleteTag: 'tags:delete',
  addTagToFiles: 'tags:addToFiles',
  removeTagFromFiles: 'tags:removeFromFiles',
  setFileOrientations: 'files:setOrientations',
  setFileRatings: 'files:setRatings',
  setFileColorLabels: 'files:setColorLabels',
  rerenderThumbs: 'thumbs:rerenderMany',
  listCollections: 'collections:list',
  createCollection: 'collections:create',
  renameCollection: 'collections:rename',
  deleteCollection: 'collections:delete',
  addFilesToCollection: 'collections:addFiles',
  removeFilesFromCollection: 'collections:removeFiles',
  createSmartCollection: 'collections:createSmart',
  updateSmartQuery: 'collections:updateSmartQuery',
  listExternalApps: 'prefs:listExternalApps',
  addExternalApp: 'prefs:addExternalApp',
  removeExternalApp: 'prefs:removeExternalApp',
  setDefaultExternalApp: 'prefs:setDefaultExternalApp',
  openWithExternalApp: 'files:openWithExternalApp',
  revealFile: 'files:reveal',
  batchRename: 'files:batchRename',
  setFileNotes: 'files:setNotes',
  rebuildThumbCache: 'cache:rebuild',
  purgeOrphanThumbs: 'cache:purge',
  getPreferences: 'prefs:get',
  setPreferences: 'prefs:set',
  listTagTree: 'tags:listTree',
  setTagParent: 'tags:setParent',
  createTagUnderParent: 'tags:createUnderParent',
  moveFile: 'files:move',
  duplicateFile: 'files:duplicate',
  deleteFile: 'files:delete',
  exportCollectionZip: 'export:collectionZip',
  exportContactSheet: 'export:contactSheet',
  openLogsFolder: 'logs:openFolder',
  /**
   * Renderer-triggered Undo. The main side pops the top entry from the
   * in-memory undo queue and runs its inverse. Returns whether anything
   * was popped, the entry's label for toast feedback, and (when the inverse
   * itself failed) an error message.
   */
  undo: 'undo:run',
  /** Open the OS Trash / Recycle Bin (best-effort, platform-specific). */
  openTrash: 'shell:openTrash'
} as const;

/** One-way main → renderer events (sent via webContents.send). */
export const IPC_EVENT = {
  libraryEvent: 'library:event'
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
