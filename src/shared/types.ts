/**
 * Cross-process types shared between main, preload, and renderer.
 * The preload bridge re-exports a typed `IpcApi` that the renderer consumes.
 */

export interface LibrarySummary {
  id: string;
  name: string;
  mountPath: string;
  online: boolean;
  lastSeen: number;
}

export interface AddLibraryRequest {
  mountPath: string;
  name?: string;
}

export type AddLibraryResult =
  | { ok: true; library: LibrarySummary }
  | { ok: false; error: string };

export interface RemoveLibraryRequest {
  id: string;
  /** When true, also delete the .meshFlask.db and sidecar caches on disk. */
  deleteCache?: boolean;
}

export type RemoveLibraryResult =
  | { ok: true }
  | { ok: false; error: string };

export interface RenameLibraryRequest {
  id: string;
  name: string;
}

export type RenameLibraryResult =
  | { ok: true; library: LibrarySummary }
  | { ok: false; error: string };

export type RevealLibraryResult =
  | { ok: true }
  | { ok: false; error: string };

export interface PickFolderResult {
  canceled: boolean;
  path?: string;
}

import type { LightingStyle } from './lighting-types';
import type { FileOrientation } from './orientation';
import type { ColorLabel } from './ratings';
import type { SortSpec } from './sort';
export type { FileOrientation } from './orientation';
export type { ColorLabel } from './ratings';

export interface FileRecord {
  id: number;
  /** Library that owns this file. Stamped at the IPC boundary; the per-library
   *  SQLite DB doesn't store it because each DB is already scoped to one
   *  library. Knowing this per-file is what makes "All Libraries" mode possible
   *  — every renderer code path that builds a wh3d-thumb:// / wh3d-file:// URL
   *  or invokes a per-file IPC dispatches by `file.libraryId` rather than a
   *  global "active library" id. */
  libraryId: string;
  relPath: string;
  parentDir: string;
  filename: string;
  ext: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string | null;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
  /**
   * True when this file has a non-stale thumbnail row in the DB. The renderer
   * uses this to choose between the rendered <img src="wh3d-thumb://..."> and
   * the placeholder colored tile.
   */
  hasThumb: boolean;
  /**
   * Last error message from a persistent render failure (after exhausting
   * MAX_ATTEMPTS). Null when the file has not failed past the retry cap.
   * Cleared on a successful render or a forced rerender.
   */
  thumbError: string | null;
  /**
   * Effective orientation for this file (user override if set, otherwise the
   * format default). Used by the viewer and worker when loading the model
   * so the "up" axis matches Three.js's world +Y.
   */
  orientation: FileOrientation;
  /** True iff the user has set an explicit orientation override for this file. */
  orientationCustomized: boolean;
  /** Star rating 0..5. 0 = unrated. */
  rating: number;
  /** Color label, or null when unset. */
  colorLabel: ColorLabel | null;
  /** Free-text notes for the file. Empty string when unset. */
  notes: string;
  /** User-saved camera state — captured when the user grabs a custom thumbnail
   *  so reopening the file restarts the preview at the same angle. Null means
   *  "use the default frame-fit camera". */
  camera: CameraState | null;
}

/**
 * OrbitControls camera snapshot: world-space camera position, where it's
 * looking, and the orthographic-ish zoom factor. Plain arrays so it's
 * trivially JSON-serializable for IPC and DB storage.
 */
export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
}

function isVec3(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

export function isCameraState(value: unknown): value is CameraState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { position?: unknown; target?: unknown; zoom?: unknown };
  return (
    isVec3(v.position) &&
    isVec3(v.target) &&
    typeof v.zoom === 'number' &&
    Number.isFinite(v.zoom)
  );
}

/** A directory that contains at least one indexed file (immediate children only). */
export interface FolderRecord {
  parentDir: string;
  fileCount: number;
}

/**
 * One node in the folder tree as the renderer wants it. Includes inferred
 * intermediate directories that contain no files directly (parents of leaves
 * with files). `recursiveFileCount` totals files in this folder and below.
 */
export interface FolderTreeNode {
  /** POSIX path relative to library root; "" is the library root itself. */
  path: string;
  /** Display name — last segment of `path`, or library name for root. */
  name: string;
  immediateFileCount: number;
  recursiveFileCount: number;
  children: FolderTreeNode[];
}

export interface ScanProgress {
  libraryId: string;
  state: 'idle' | 'scanning' | 'watching' | 'error';
  filesSeen: number;
  inserted: number;
  updated: number;
  /** Files matched by (size, mtime) to a missing path → preserved id and thumb. */
  renamed: number;
  removed: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export type LibraryFilesEvent =
  | { kind: 'scan-progress'; libraryId: string; progress: ScanProgress }
  | { kind: 'scan-complete'; libraryId: string; progress: ScanProgress }
  | { kind: 'files-changed'; libraryId: string }
  | { kind: 'thumb-rendered'; libraryId: string; fileId: number }
  | { kind: 'thumb-failed'; libraryId: string; fileId: number; error: string }
  | { kind: 'tags-changed'; libraryId: string; fileId?: number }
  | { kind: 'collections-changed'; libraryId: string; collectionId?: number }
  | { kind: 'integrity-failed'; libraryId: string; libraryName: string; error: string }
  | { kind: 'file-trashed'; libraryId: string; relPath: string }
  | { kind: 'undo-completed'; libraryId: string; label: string }
  | { kind: 'undo-failed'; libraryId: string; label: string; error: string };

export interface ListFilesRequest {
  libraryId: string;
  parentDir: string;
}

export interface ListFoldersRequest {
  libraryId: string;
}

export interface GetFileRequest {
  libraryId: string;
  fileId: number;
}

export interface FileQueryRequest {
  libraryId: string;
  /** Free-text FTS query; empty/undefined = browse without search. */
  query?: string;
  /** Folder scope; undefined = whole library. */
  parentDir?: string;
  /** When parentDir is set, true searches the subtree, false the immediate folder. */
  recursive?: boolean;
  /** Restrict to these extensions (lowercase). Empty/undefined = all. */
  extensions?: string[];
  /** Files must have ALL of these tag ids. Empty/undefined = no tag filter. */
  tagIds?: number[];
  /**
   * Restrict to files in this collection. Mutually exclusive with parentDir
   * in the UI; if both are supplied the collection wins.
   */
  collectionId?: number;
  /** Restrict to files with at least this rating. 0 = no rating filter. */
  minRating?: number;
  /** Restrict to files carrying one of these labels. Empty/undefined = no filter. */
  colorLabels?: ColorLabel[];
  /**
   * Explicit ordering. When omitted, results are ordered by FTS rank (if a
   * query is set) else filename. Collection scope without a sort still uses
   * the manual `position` column.
   */
  sort?: SortSpec;
  limit?: number;
}

export type MoveFileResult =
  | { ok: true; toRelPath: string }
  | { ok: false; error: string };

export type DuplicateFileResult =
  | { ok: true; toRelPath: string }
  | { ok: false; error: string };

export type DeleteFileResult = { ok: true } | { ok: false; error: string };

export type ExportResult =
  | { ok: true; canceled: false; path: string; fileCount: number }
  | { ok: true; canceled: true }
  | { ok: false; error: string };

export interface BatchRenameItem {
  fileId: number;
  fromRelPath: string;
  toRelPath: string;
}

export type BatchRenameResult =
  | { ok: true; renamed: number }
  | {
    ok: false;
    /** Collisions detected before any FS work happened. */
    collisions?: string[];
    /** Free-form error when an FS move failed; previously-renamed items were rolled back. */
    error?: string;
  };

export interface TagRecord {
  id: number;
  name: string;
  parentId: number | null;
}

export interface TagWithCount extends TagRecord {
  fileCount: number;
}

/** Tree node returned by `tags.listTree()`. */
export interface TagTreeNode extends TagWithCount {
  children: TagTreeNode[];
}

export interface CollectionRecord {
  id: number;
  name: string;
  createdAt: number;
  updatedAt: number;
  /**
   * When non-null, the collection is "smart" — its membership is derived
   * from this saved query rather than the manual collection_files list.
   */
  smartQuery: import('./smart-query').SmartQuery | null;
}

export interface CollectionWithCount extends CollectionRecord {
  fileCount: number;
}

/**
 * Structured metadata extracted by the thumbnail worker after model load.
 * Stored in `files.metadata_json`. The renderer displays a subset of these
 * fields and the keys are also indexed via FTS5 so users can search by
 * material name etc.
 */
export interface MeshValidation {
  /**
   * True iff every edge in the mesh is shared by exactly two triangles.
   * Null when the check was skipped (e.g. mesh too large or non-indexed
   * with too many vertices). Indeterminate / non-watertight meshes get a
   * warning badge in the UI.
   */
  isWatertight: boolean | null;
  /** Number of degenerate (zero-area) triangles. */
  degenerateTriangles: number;
  /** Whether the check was skipped — and if so, why. */
  skipped?: 'too-large' | 'non-indexed' | 'no-position';
}

export interface TextureInfo {
  /** PBR slot the texture is bound to, e.g. "map", "normalMap". */
  role: string;
  /** Display name. From `texture.name` if set, else the image src filename. */
  name: string;
}

export interface ExtractedMetadata {
  vertexCount: number;
  triangleCount: number;
  meshCount: number;
  materialCount: number;
  hasTextures: boolean;
  boundingBox: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
  /** Source of the rendered thumbnail. */
  thumbSource: 'gl' | '3mf-embedded';
  /** Distinct material names encountered (max 32). */
  materialNames: string[];
  /** Set when mesh validation ran during render. Absent on older rows. */
  validation?: MeshValidation;
  /** Set when material textures were inspected during render. */
  textures?: TextureInfo[];
  /** Signed-tetrahedron mesh volume in mm³. Absent on older rows or when
   *  the mesh was too large to compute. Used by the print-cost estimator. */
  meshVolumeMm3?: number;
}

export interface IpcApi {
  pickFolder(): Promise<PickFolderResult>;
  listLibraries(): Promise<LibrarySummary[]>;
  addLibrary(req: AddLibraryRequest): Promise<AddLibraryResult>;
  removeLibrary(req: RemoveLibraryRequest): Promise<RemoveLibraryResult>;
  renameLibrary(req: RenameLibraryRequest): Promise<RenameLibraryResult>;
  revealLibrary(id: string): Promise<RevealLibraryResult>;

  listFolders(req: ListFoldersRequest): Promise<FolderTreeNode | null>;
  listFiles(req: ListFilesRequest): Promise<FileRecord[]>;
  getFile(req: GetFileRequest): Promise<FileRecord | null>;
  rescan(libraryId: string): Promise<{ ok: boolean; error?: string }>;
  getScanStatus(libraryId: string): Promise<ScanProgress | null>;

  bumpVisibleThumbs(libraryId: string, fileIds: number[]): Promise<void>;
  rerenderThumb(libraryId: string, fileId: number): Promise<void>;
  /**
   * Replace a file's thumbnail with the supplied PNG bytes — used by the
   * metadata panel to capture whatever the in-UI viewer is currently showing,
   * so the user's chosen rotation becomes the new thumbnail.
   */
  saveCustomThumbnail(
    libraryId: string,
    fileId: number,
    png: Uint8Array,
    camera?: CameraState | null
  ): Promise<void>;
  /**
   * Tell the main-process queue runner which lighting preset future
   * worker-rendered thumbnails should use. The in-UI viewer applies the
   * change immediately; this keeps background-queue thumbnails consistent.
   */
  setLightingStyle(style: LightingStyle): Promise<void>;
  /**
   * Save a per-file orientation override (or pass null to clear and fall
   * back to the format default). Triggers a high-priority re-render so the
   * grid thumbnail catches up.
   */
  setFileOrientation(
    libraryId: string,
    fileId: number,
    orientation: FileOrientation | null
  ): Promise<void>;

  queryFiles(req: FileQueryRequest): Promise<FileRecord[]>;

  listTags(libraryId: string): Promise<TagWithCount[]>;
  listTagsForFile(libraryId: string, fileId: number): Promise<TagRecord[]>;
  addTagToFile(libraryId: string, fileId: number, tagName: string): Promise<TagRecord>;
  removeTagFromFile(libraryId: string, fileId: number, tagId: number): Promise<void>;
  deleteTag(libraryId: string, tagId: number): Promise<void>;
  /** Add a single tag (created if missing) to every supplied file in one transaction. */
  addTagToFiles(libraryId: string, fileIds: number[], tagName: string): Promise<TagRecord>;
  /** Remove a tag from every supplied file in one transaction. */
  removeTagFromFiles(libraryId: string, fileIds: number[], tagId: number): Promise<void>;
  /** Apply one orientation override (or null to clear) to many files. */
  setFileOrientations(
    libraryId: string,
    fileIds: number[],
    orientation: FileOrientation | null
  ): Promise<void>;
  /** Queue a forced re-render for many files at user-visible priority. */
  rerenderThumbs(libraryId: string, fileIds: number[]): Promise<void>;
  /** Set the same rating (0..5) on many files in one transaction. */
  setFileRatings(libraryId: string, fileIds: number[], rating: number): Promise<void>;
  /** Set (or clear with null) the same color label on many files in one transaction. */
  setFileColorLabels(
    libraryId: string,
    fileIds: number[],
    label: ColorLabel | null
  ): Promise<void>;

  listCollections(libraryId: string): Promise<CollectionWithCount[]>;
  createCollection(libraryId: string, name: string): Promise<CollectionRecord>;
  renameCollection(libraryId: string, id: number, name: string): Promise<CollectionRecord | null>;
  deleteCollection(libraryId: string, id: number): Promise<void>;
  addFilesToCollection(libraryId: string, collectionId: number, fileIds: number[]): Promise<void>;
  removeFilesFromCollection(libraryId: string, collectionId: number, fileIds: number[]): Promise<void>;
  createSmartCollection(
    libraryId: string,
    name: string,
    query: import('./smart-query').SmartQuery
  ): Promise<CollectionRecord>;
  updateSmartQuery(
    libraryId: string,
    id: number,
    query: import('./smart-query').SmartQuery
  ): Promise<CollectionRecord | null>;

  /**
   * Rename many files on disk + in the DB atomically (per-file rollback on
   * partial failure). The plan is computed in the renderer from the template
   * preview so the user sees exactly what will happen before they commit.
   */
  batchRename(
    libraryId: string,
    plan: BatchRenameItem[]
  ): Promise<BatchRenameResult>;
  setFileNotes(libraryId: string, fileId: number, notes: string): Promise<void>;
  rebuildThumbCache(libraryId: string): Promise<void>;
  purgeOrphanThumbs(libraryId: string): Promise<{ removed: number }>;
  getPreferences(): Promise<import('./preferences').PreferencesFile>;
  setPreferences(prefs: import('./preferences').PreferencesFile): Promise<void>;

  listTagTree(libraryId: string): Promise<TagTreeNode[]>;
  setTagParent(libraryId: string, tagId: number, parentId: number | null): Promise<void>;
  /** Create a tag under the given parent (root if null), returns the new record. */
  createTagUnderParent(libraryId: string, name: string, parentId: number | null): Promise<TagRecord>;

  moveFile(libraryId: string, fileId: number, toParentDir: string): Promise<MoveFileResult>;
  duplicateFile(libraryId: string, fileId: number): Promise<DuplicateFileResult>;
  deleteFile(libraryId: string, fileId: number): Promise<DeleteFileResult>;

  /** Pop a Save dialog, then stream a ZIP of every file in the collection. */
  exportCollectionZip(libraryId: string, collectionId: number): Promise<ExportResult>;
  /** Pop a Save dialog, then render an HTML contact sheet of the supplied files as PDF. */
  exportContactSheet(libraryId: string, fileIds: number[]): Promise<ExportResult>;

  /** Open the per-machine logs directory in the OS file manager. */
  openLogsFolder(): Promise<void>;

  /** Open the OS Trash / Recycle Bin so the user can restore a just-deleted file. */
  openTrash(): Promise<void>;

  /**
   * Pop and execute the most recent undo entry. Returns whether anything was
   * undone — the renderer doesn't need detailed status because failures are
   * already broadcast as library events.
   */
  undo(): Promise<
    | { ok: false; reason: 'empty' }
    | { ok: true; label: string }
    | { ok: false; reason: 'failed'; label: string; error: string }
  >;

  listExternalApps(): Promise<import('./preferences').ExternalAppRegistration[]>;
  /**
   * Pop the OS file-picker so the user chooses an app bundle/executable;
   * returns the registration (or null if canceled). `extensions` is the
   * lowercase list of file extensions this app should handle in the
   * Open-with menu.
   */
  addExternalApp(
    extensions: string[]
  ): Promise<import('./preferences').ExternalAppRegistration | null>;
  removeExternalApp(id: string): Promise<void>;
  setDefaultExternalApp(id: string, ext: string): Promise<void>;
  /**
   * Launch the given file in an external app. `appId === null` means "use the
   * OS default" (Electron `shell.openPath`).
   */
  openWithExternalApp(
    libraryId: string,
    fileId: number,
    appId: string | null,
    profileId?: string | null
  ): Promise<void>;
  /** Show this file in Finder/Explorer (per-file equivalent of revealLibrary). */
  revealFile(libraryId: string, fileId: number): Promise<void>;

  /**
   * Subscribe to per-library file events (scan progress + watcher updates).
   * Returns an unsubscribe function.
   */
  onLibraryEvent(handler: (event: LibraryFilesEvent) => void): () => void;
}
