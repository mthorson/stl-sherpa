import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  AppShell,
  Badge,
  Center,
  Divider,
  Group,
  Loader,
  ScrollArea,
  Select,
  Stack,
  Text,
  Tooltip
} from '@mantine/core';
import { IconCoffee, IconRefresh, IconSettings } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle
} from 'react-resizable-panels';
import type {
  CollectionWithCount,
  ColorLabel,
  FileQueryRequest,
  FileRecord,
  FolderTreeNode,
  LibrarySummary,
  ScanProgress,
  TagWithCount
} from '@shared/types';
import type { FileOrientation } from '@shared/orientation';
import type { SupportedExtension } from '@shared/formats';
import {
  DEFAULT_LIGHTING_STYLE,
  isLightingStyle,
  type LightingStyle
} from '@shared/lighting-types';
import { DEFAULT_SORT, isSortSpec, type SortSpec } from '@shared/sort';
import { COLOR_LABELS } from '@shared/ratings';
import { LibrarySidebar } from './components/LibrarySidebar';
import { Logo } from './components/Logo';
import { FolderTree } from './components/FolderTree';
import { TagsSidebar } from './components/TagsSidebar';
import { TriageFacets } from './components/TriageFacets';
import { CollectionsSidebar } from './components/CollectionsSidebar';
import { FolderRowList } from './components/FavoritesSidebar';
import { CollapsibleSection } from './components/CollapsibleSection';
import { PrintBedFacet } from './components/PrintBedFacet';
import { modelFitsSpecificBed } from '@shared/print-bed';
import type { ExtractedMetadata } from '@shared/types';
import { usePreferences } from './util/use-preferences';
import { ThumbGrid, type TileClickModifiers } from './components/ThumbGrid';
import { FileListView } from './components/FileListView';
import { ViewSortToolbar, type ViewMode } from './components/ViewSortToolbar';
import { MetadataPanel } from './components/MetadataPanel';
import { PreviewPane } from './components/PreviewPane';
import { SearchBar } from './components/SearchBar';
import { ThumbContextMenu } from './components/ThumbContextMenu';
import { PreferencesModal } from './components/PreferencesModal';
import { BatchRenameModal } from './components/BatchRenameModal';
import { SmartCollectionModal } from './components/SmartCollectionModal';
import { FullscreenPreviewModal } from './components/FullscreenPreviewModal';
import { DeleteConfirmModal } from './components/DeleteConfirmModal';
import { MoveConfirmModal } from './components/MoveConfirmModal';
import { CompareModal } from './components/CompareModal';
import { ipc } from './ipc-client';

const SEARCH_DEBOUNCE_MS = 200;
const LIGHTING_STORAGE_KEY = 'wh3d:lightingStyle';
const SORT_STORAGE_KEY = 'wh3d:sort';
const VIEW_STORAGE_KEY = 'wh3d:viewMode';
const WORKSPACE_STORAGE_KEY = 'wh3d:workspace';

const WORKSPACES = {
  triage: { label: 'Triage', outer: [18, 50, 32], inner: [40, 60] },
  preview: { label: 'Preview-heavy', outer: [18, 65, 17], inner: [75, 25] },
  grid: { label: 'Grid only', outer: [14, 80, 6], inner: [10, 90] }
} as const satisfies Record<
  string,
  { label: string; outer: [number, number, number]; inner: [number, number] }
>;

type Workspace = keyof typeof WORKSPACES;

function readStoredWorkspace(): Workspace | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    return raw && raw in WORKSPACES ? (raw as Workspace) : null;
  } catch {
    return null;
  }
}

function readStoredSort(): SortSpec {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return DEFAULT_SORT;
    const parsed = JSON.parse(raw);
    return isSortSpec(parsed) ? parsed : DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
  }
}

function parseMeta(json: string | null): ExtractedMetadata | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ExtractedMetadata;
  } catch {
    return null;
  }
}

function readStoredViewMode(): ViewMode {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    return raw === 'list' || raw === 'grid' ? raw : 'grid';
  } catch {
    return 'grid';
  }
}

const MAX_RECENT_FOLDERS = 10;

function favoritesKey(libraryId: string): string {
  return `wh3d:favorites:${libraryId}`;
}

function recentKey(libraryId: string): string {
  return `wh3d:recent:${libraryId}`;
}

function readStoredList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function writeStoredList(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // ignore
  }
}

function readStoredLightingStyle(): LightingStyle {
  try {
    const raw = localStorage.getItem(LIGHTING_STORAGE_KEY);
    return isLightingStyle(raw) ? raw : DEFAULT_LIGHTING_STYLE;
  } catch {
    return DEFAULT_LIGHTING_STYLE;
  }
}

export function App() {
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);
  const [folderTree, setFolderTree] = useState<FolderTreeNode | null>(null);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string>('');
  // Collection selection is mutually exclusive with folder selection. The
  // setters below enforce that mutex; never set them both.
  const [selectedCollectionId, setSelectedCollectionId] = useState<number | null>(null);
  const [collections, setCollections] = useState<CollectionWithCount[]>([]);
  const [files, setFiles] = useState<FileRecord[]>([]);
  // Multi-select: the full selection set + the "primary" (most-recently-clicked)
  // tile that drives PreviewPane + single-file MetadataPanel. The anchor for
  // shift-range lives in a ref so it doesn't trigger re-renders.
  const [selectedFileIds, setSelectedFileIds] = useState<Set<number>>(() => new Set());
  const [primaryFileId, setPrimaryFileId] = useState<number | null>(null);
  const selectionAnchorRef = useRef<number | null>(null);
  // Raised by nav changes (folder/collection/scope), consumed by the
  // files-loaded effect to auto-select the first file. Lives in a ref so IPC-
  // driven reloads (scan-complete, watcher) don't silently change the user's
  // current selection — only deliberate nav arms it.
  const autoSelectFirstRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<{ open: boolean; x: number; y: number }>(
    { open: false, x: 0, y: 0 }
  );
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [batchRenameOpen, setBatchRenameOpen] = useState(false);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; files: FileRecord[] }>({
    open: false,
    files: []
  });
  const [moveConfirm, setMoveConfirm] = useState<{
    open: boolean;
    files: FileRecord[];
    toParentDir: string;
  }>({ open: false, files: [], toParentDir: '' });
  const [smartCollectionEditor, setSmartCollectionEditor] = useState<{
    open: boolean;
    existing: CollectionWithCount | null;
  }>({ open: false, existing: null });
  const [scanStatus, setScanStatus] = useState<ScanProgress | null>(null);
  const [thumbVersions, setThumbVersions] = useState<Map<number, number>>(() => new Map());
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedExtensions, setSelectedExtensions] = useState<Set<SupportedExtension>>(
    () => new Set()
  );
  const [selectedTagIds, setSelectedTagIds] = useState<Set<number>>(() => new Set());
  const [minRating, setMinRating] = useState<number>(0);
  const [selectedColorLabels, setSelectedColorLabels] = useState<Set<ColorLabel>>(
    () => new Set()
  );
  const [selectedBedId, setSelectedBedId] = useState<string | null>(null);
  // viewScope sits alongside the folder/collection selection. 'normal' uses
  // the existing folder/collection state. 'tree' = entire current library
  // (recursive). Exposed via the "Show all models in current library" link
  // at the top of the Libraries section.
  const [viewScope, setViewScope] = useState<'normal' | 'tree'>('normal');

  const [allTags, setAllTags] = useState<TagWithCount[]>([]);
  const [tagRefreshKey, setTagRefreshKey] = useState(0);
  const [lightingStyle, setLightingStyleState] = useState<LightingStyle>(() =>
    readStoredLightingStyle()
  );
  const [sort, setSortState] = useState<SortSpec>(() => readStoredSort());
  const [viewMode, setViewModeState] = useState<ViewMode>(() => readStoredViewMode());
  const [workspace, setWorkspaceState] = useState<Workspace | null>(() => readStoredWorkspace());
  const outerPanelGroupRef = useRef<ImperativePanelGroupHandle>(null);
  const innerPanelGroupRef = useRef<ImperativePanelGroupHandle>(null);

  const applyWorkspace = useCallback((ws: Workspace | null) => {
    setWorkspaceState(ws);
    try {
      if (ws == null) localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      else localStorage.setItem(WORKSPACE_STORAGE_KEY, ws);
    } catch {
      // ignore
    }
    if (ws != null) {
      const preset = WORKSPACES[ws];
      outerPanelGroupRef.current?.setLayout([...preset.outer]);
      innerPanelGroupRef.current?.setLayout([...preset.inner]);
    }
  }, []);

  const setSort = useCallback((next: SortSpec) => {
    setSortState(next);
    try {
      localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }, []);

  const setViewMode = useCallback((next: ViewMode) => {
    setViewModeState(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  const [favoriteFolders, setFavoriteFoldersState] = useState<string[]>([]);
  const [recentFolders, setRecentFoldersState] = useState<string[]>([]);
  // Filter recent down to non-pinned, capped at MAX_VISIBLE so the section
  // stays compact when pinned to the bottom of the sidebar.
  const visibleRecentFolders = useMemo(
    () => recentFolders.filter((p) => !favoriteFolders.includes(p)).slice(0, 5),
    [recentFolders, favoriteFolders]
  );

  // Load favorites + recent whenever the library changes.
  useEffect(() => {
    if (!selectedLibraryId) {
      setFavoriteFoldersState([]);
      setRecentFoldersState([]);
      return;
    }
    setFavoriteFoldersState(readStoredList(favoritesKey(selectedLibraryId)));
    setRecentFoldersState(readStoredList(recentKey(selectedLibraryId)));
  }, [selectedLibraryId]);

  // Append the selected folder to the recent list, but leave it in place if
  // it's already present — re-selecting a folder shouldn't shuffle the list
  // order under the user's cursor.
  useEffect(() => {
    if (!selectedLibraryId || selectedCollectionId != null) return;
    setRecentFoldersState((prev) => {
      if (prev.includes(selectedFolderPath)) return prev;
      const next = [selectedFolderPath, ...prev].slice(0, MAX_RECENT_FOLDERS);
      writeStoredList(recentKey(selectedLibraryId), next);
      return next;
    });
  }, [selectedLibraryId, selectedFolderPath, selectedCollectionId]);

  const toggleFavoriteFolder = useCallback(
    (path: string) => {
      if (!selectedLibraryId) return;
      setFavoriteFoldersState((prev) => {
        const next = prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path];
        writeStoredList(favoritesKey(selectedLibraryId), next);
        return next;
      });
    },
    [selectedLibraryId]
  );

  const isFavoriteFolder = useCallback(
    (path: string) => favoriteFolders.includes(path),
    [favoriteFolders]
  );

  useEffect(() => {
    try {
      localStorage.setItem(LIGHTING_STORAGE_KEY, lightingStyle);
    } catch {
      // localStorage may be unavailable; non-fatal — main still gets the value.
    }
    void ipc.setLightingStyle(lightingStyle);
  }, [lightingStyle]);

  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  const filterActive =
    searchQuery.trim() !== '' ||
    selectedExtensions.size > 0 ||
    selectedTagIds.size > 0 ||
    minRating > 0 ||
    selectedColorLabels.size > 0;

  const refreshLibraries = useCallback(async () => {
    const list = await ipc.listLibraries();
    setLibraries(list);
    setSelectedLibraryId((prev) => {
      if (prev && list.some((l) => l.id === prev && l.online)) return prev;
      return list.find((l) => l.online)?.id ?? list[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void refreshLibraries();
  }, [refreshLibraries]);

  const refreshTree = useCallback(async (libraryId: string) => {
    const tree = await ipc.listFolders({ libraryId });
    setFolderTree(tree);
  }, []);

  const refreshTags = useCallback(async (libraryId: string) => {
    const tags = await ipc.listTags(libraryId);
    setAllTags(tags);
  }, []);

  const refreshCollections = useCallback(async (libraryId: string) => {
    const list = await ipc.listCollections(libraryId);
    setCollections(list);
  }, []);

  // Read collections via ref so refreshFiles isn't re-created on every list
  // refresh — that would re-trigger every effect that depends on it.
  const collectionsRef = useRef<CollectionWithCount[]>(collections);
  collectionsRef.current = collections;

  const refreshFiles = useCallback(
    async (
      libraryId: string,
      parentDir: string,
      collectionId: number | null,
      query: string,
      extensions: Set<SupportedExtension>,
      tagIds: Set<number>,
      minRatingFilter: number,
      colorLabels: Set<ColorLabel>,
      sortSpec: SortSpec,
      scope: 'normal' | 'tree' = 'normal'
    ) => {
      if (scope === 'tree') {
        const list = await ipc.queryFiles({
          libraryId,
          parentDir: '',
          recursive: true,
          query: query.trim() || undefined,
          extensions: extensions.size > 0 ? [...extensions] : undefined,
          tagIds: tagIds.size > 0 ? [...tagIds] : undefined,
          minRating: minRatingFilter > 0 ? minRatingFilter : undefined,
          colorLabels: colorLabels.size > 0 ? [...colorLabels] : undefined,
          sort: sortSpec,
          limit: 2000
        });
        setFiles(list);
        return;
      }
      // Smart-collection merge: if the active collection is smart, its saved
      // query rules merge with the ad-hoc filters (sidebar facets / search).
      // Ad-hoc filters WIN — the user is narrowing the smart result.
      const activeCol =
        collectionId != null
          ? collectionsRef.current.find((c) => c.id === collectionId) ?? null
          : null;
      const smartQuery = activeCol?.smartQuery ?? null;
      const isSmartView = smartQuery != null;

      const filtersOn =
        query.trim() !== '' ||
        extensions.size > 0 ||
        tagIds.size > 0 ||
        minRatingFilter > 0 ||
        colorLabels.size > 0;
      // Default-sort-by-filename in a manual collection means "use position".
      // For smart collections position doesn't apply, so fall through to the
      // normal sort path.
      const explicitSort =
        sortSpec.field !== DEFAULT_SORT.field || sortSpec.direction !== DEFAULT_SORT.direction
          ? sortSpec
          : collectionId != null && !isSmartView
            ? undefined
            : sortSpec;

      const mergedExtensions =
        extensions.size > 0
          ? [...extensions]
          : isSmartView && smartQuery.extensions && smartQuery.extensions.length > 0
            ? smartQuery.extensions
            : undefined;
      const mergedTagIds =
        tagIds.size > 0
          ? [...tagIds]
          : isSmartView && smartQuery.tagIds && smartQuery.tagIds.length > 0
            ? smartQuery.tagIds
            : undefined;
      const mergedMinRating =
        minRatingFilter > 0
          ? minRatingFilter
          : isSmartView && smartQuery.minRating && smartQuery.minRating > 0
            ? smartQuery.minRating
            : undefined;
      const mergedColorLabels =
        colorLabels.size > 0
          ? [...colorLabels]
          : isSmartView && smartQuery.colorLabels && smartQuery.colorLabels.length > 0
            ? smartQuery.colorLabels
            : undefined;
      const mergedSearch =
        query.trim() !== ''
          ? query.trim()
          : isSmartView && smartQuery.search && smartQuery.search.trim() !== ''
            ? smartQuery.search.trim()
            : undefined;

      const req: FileQueryRequest = {
        libraryId,
        // For smart collections we never pass collectionId to the query — its
        // saved rules become regular filters. Manual collections still scope
        // by collectionId so position-ordering and membership rules apply.
        ...(collectionId != null && !isSmartView
          ? { collectionId }
          : { parentDir, recursive: filtersOn || isSmartView }),
        query: mergedSearch,
        extensions: mergedExtensions,
        tagIds: mergedTagIds,
        minRating: mergedMinRating,
        colorLabels: mergedColorLabels,
        sort: explicitSort,
        limit: 2000
      };
      const list = await ipc.queryFiles(req);
      setFiles(list);
    },
    []
  );

  const refreshScanStatus = useCallback(async (libraryId: string) => {
    const status = await ipc.getScanStatus(libraryId);
    setScanStatus(status);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedFileIds(new Set());
    setPrimaryFileId(null);
    selectionAnchorRef.current = null;
  }, []);

  // Library changed → reset everything per-library.
  useEffect(() => {
    setFolderTree(null);
    setFiles([]);
    setSelectedFolderPath('');
    setSelectedCollectionId(null);
    setCollections([]);
    clearSelection();
    setScanStatus(null);
    setThumbVersions(new Map());
    setSearchInput('');
    setSearchQuery('');
    setSelectedExtensions(new Set());
    setSelectedTagIds(new Set());
    setMinRating(0);
    setSelectedColorLabels(new Set());
    setAllTags([]);
    if (!selectedLibraryId) return;
    void refreshTree(selectedLibraryId);
    void refreshTags(selectedLibraryId);
    void refreshCollections(selectedLibraryId);
    void refreshScanStatus(selectedLibraryId);
  }, [
    selectedLibraryId,
    refreshTree,
    refreshTags,
    refreshCollections,
    refreshScanStatus,
    clearSelection
  ]);

  // Any change in folder/collection/query/filter/sort/scope → reload the grid.
  useEffect(() => {
    if (!selectedLibraryId) return;
    void refreshFiles(
      selectedLibraryId,
      selectedFolderPath,
      selectedCollectionId,
      searchQuery,
      selectedExtensions,
      selectedTagIds,
      minRating,
      selectedColorLabels,
      sort,
      viewScope
    );
    clearSelection();
    autoSelectFirstRef.current = true;
  }, [
    selectedLibraryId,
    selectedFolderPath,
    selectedCollectionId,
    searchQuery,
    selectedExtensions,
    selectedTagIds,
    minRating,
    selectedColorLabels,
    sort,
    viewScope,
    refreshFiles,
    clearSelection
  ]);

  // When a nav-triggered file list arrives, auto-promote the first file to
  // primary so the preview pane updates without an explicit click. The flag
  // ensures this only happens once per navigation — subsequent IPC reloads
  // (scan, watcher) leave the selection alone.
  useEffect(() => {
    if (!autoSelectFirstRef.current) return;
    if (files.length === 0) return;
    autoSelectFirstRef.current = false;
    const first = files[0];
    setSelectedFileIds(new Set([first.id]));
    setPrimaryFileId(first.id);
    selectionAnchorRef.current = first.id;
  }, [files]);

  useEffect(() => {
    if (!selectedLibraryId || files.length === 0) return;
    void ipc.bumpVisibleThumbs(
      selectedLibraryId,
      files.slice(0, 100).map((f) => f.id)
    );
  }, [selectedLibraryId, files]);

  // Latest state visible to the IPC listener without re-binding on each keystroke.
  const stateRef = useRef({
    selectedLibraryId,
    selectedFolderPath,
    selectedCollectionId,
    primaryFileId,
    searchQuery,
    selectedExtensions,
    selectedTagIds,
    minRating,
    selectedColorLabels,
    sort,
    viewScope
  });
  stateRef.current = {
    selectedLibraryId,
    selectedFolderPath,
    selectedCollectionId,
    primaryFileId,
    searchQuery,
    selectedExtensions,
    selectedTagIds,
    minRating,
    selectedColorLabels,
    sort,
    viewScope
  };

  useEffect(() => {
    return ipc.onLibraryEvent((event) => {
      const s = stateRef.current;

      // Events that should show regardless of which library is selected.
      // Integrity warnings and trash/undo toasts are app-wide signals.
      if (event.kind === 'integrity-failed') {
        notifications.show({
          color: 'red',
          title: `Library "${event.libraryName}" failed integrity check`,
          message: `${event.error}. Recent backups are in .meshFlask/backups/. Reporting an issue? Attach a log from Help → Open Logs Folder.`,
          autoClose: false
        });
        return;
      }
      if (event.kind === 'file-trashed') {
        const name = event.relPath.split('/').pop() ?? event.relPath;
        const id = `file-trashed-${event.libraryId}-${event.relPath}`;
        notifications.show({
          id,
          color: 'yellow',
          title: `Moved to Trash`,
          message: `${name} — restore from Trash if you didn't mean to delete it.`,
          autoClose: 8000,
          onClick: () => {
            void ipc.openTrash();
            notifications.hide(id);
          }
        });
        return;
      }
      if (event.kind === 'undo-completed') {
        notifications.show({
          color: 'green',
          title: 'Undone',
          message: event.label,
          autoClose: 2500
        });
        return;
      }
      if (event.kind === 'undo-failed') {
        notifications.show({
          color: 'red',
          title: `Could not undo: ${event.label}`,
          message: event.error
        });
        return;
      }

      if (event.libraryId !== s.selectedLibraryId) return;

      const reloadFiles = () =>
        void refreshFiles(
          event.libraryId,
          s.selectedFolderPath,
          s.selectedCollectionId,
          s.searchQuery,
          s.selectedExtensions,
          s.selectedTagIds,
          s.minRating,
          s.selectedColorLabels,
          s.sort,
          s.viewScope
        );

      if (event.kind === 'scan-progress') {
        setScanStatus(event.progress);
        return;
      }
      if (event.kind === 'scan-complete') {
        setScanStatus(event.progress);
        void refreshTree(event.libraryId);
        reloadFiles();
        return;
      }
      if (event.kind === 'files-changed') {
        void refreshTree(event.libraryId);
        reloadFiles();
        return;
      }
      if (event.kind === 'thumb-rendered') {
        setThumbVersions((prev) => {
          const next = new Map(prev);
          next.set(event.fileId, (next.get(event.fileId) ?? 0) + 1);
          return next;
        });
        if (event.fileId === s.primaryFileId) reloadFiles();
        return;
      }
      if (event.kind === 'tags-changed') {
        void refreshTags(event.libraryId);
        if (event.fileId === undefined || event.fileId === s.primaryFileId) {
          setTagRefreshKey((n) => n + 1);
        }
        if (s.selectedTagIds.size > 0 || s.searchQuery.trim() !== '') reloadFiles();
        return;
      }
      if (event.kind === 'collections-changed') {
        void refreshCollections(event.libraryId);
        // If the active collection's contents may have changed, reload the grid.
        if (s.selectedCollectionId != null) reloadFiles();
        return;
      }
    });
  }, [refreshTree, refreshFiles, refreshTags, refreshCollections]);

  // Folder/collection/scope mutex helpers — exactly one selection mode is
  // active at a time. Picking a folder or collection drops out of tree/all-libs
  // mode; activating a scope link clears folder + collection.
  const selectFolder = useCallback((path: string) => {
    setSelectedFolderPath(path);
    setSelectedCollectionId(null);
    setViewScope('normal');
  }, []);

  const selectCollection = useCallback((id: number | null) => {
    setSelectedCollectionId(id);
    if (id != null) {
      setSelectedFolderPath('');
      setViewScope('normal');
    }
  }, []);

  const selectAllInCurrentLibrary = useCallback(() => {
    setViewScope('tree');
    setSelectedFolderPath('');
    setSelectedCollectionId(null);
  }, []);

  // Single source of truth for tile-click selection logic, shared by every
  // ThumbGrid interaction. Shift-range walks the visible `files` array between
  // the anchor and the click target (inclusive).
  const handleTileClick = useCallback(
    (fileId: number, mods: TileClickModifiers) => {
      const ordered = files;
      if (mods.shift) {
        const anchor =
          selectionAnchorRef.current != null && ordered.some((f) => f.id === selectionAnchorRef.current)
            ? selectionAnchorRef.current
            : primaryFileId ?? fileId;
        const ai = ordered.findIndex((f) => f.id === anchor);
        const bi = ordered.findIndex((f) => f.id === fileId);
        if (ai >= 0 && bi >= 0) {
          const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai];
          const next = new Set<number>();
          for (let i = lo; i <= hi; i++) next.add(ordered[i].id);
          setSelectedFileIds(next);
          setPrimaryFileId(fileId);
          // anchor unchanged on shift-click
          return;
        }
      }
      if (mods.meta || mods.ctrl) {
        setSelectedFileIds((prev) => {
          const next = new Set(prev);
          if (next.has(fileId)) {
            next.delete(fileId);
            // Picking the new primary: prefer the just-toggled id when still
            // selected, otherwise any remaining member, otherwise null.
            setPrimaryFileId(next.size > 0 ? [...next][next.size - 1] : null);
          } else {
            next.add(fileId);
            setPrimaryFileId(fileId);
          }
          return next;
        });
        selectionAnchorRef.current = fileId;
        return;
      }
      // Plain click → single selection.
      setSelectedFileIds(new Set([fileId]));
      setPrimaryFileId(fileId);
      selectionAnchorRef.current = fileId;
    },
    [files, primaryFileId]
  );

  // Right-click on a tile: open the bulk context menu. Per user preference,
  // keep the current selection unchanged — except when nothing is selected, in
  // which case we promote the right-clicked tile so the menu has something to
  // act on (otherwise right-click would silently do nothing).
  const handleTileContextMenu = useCallback(
    (fileId: number, x: number, y: number) => {
      if (selectedFileIds.size === 0) {
        setSelectedFileIds(new Set([fileId]));
        setPrimaryFileId(fileId);
        selectionAnchorRef.current = fileId;
      }
      setContextMenu({ open: true, x, y });
    },
    [selectedFileIds]
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, open: false }));
  }, []);

  const requestDelete = useCallback(() => {
    const ids = [...selectedFileIds];
    if (ids.length === 0) return;
    const items = files.filter((f) => selectedFileIds.has(f.id));
    if (items.length === 0) return;
    setDeleteConfirm({ open: true, files: items });
  }, [selectedFileIds, files]);

  const performDelete = useCallback(async () => {
    const toDelete = deleteConfirm.files;
    setDeleteConfirm({ open: false, files: [] });
    for (const f of toDelete) {
      const r = await ipc.deleteFile(f.libraryId, f.id);
      if (!r.ok) {
        notifications.show({ color: 'red', title: 'Delete failed', message: r.error });
        break;
      }
    }
    clearSelection();
  }, [deleteConfirm.files, clearSelection]);

  const performDuplicate = useCallback(async () => {
    const items = files.filter((f) => selectedFileIds.has(f.id));
    if (items.length === 0) return;
    for (const f of items) {
      const r = await ipc.duplicateFile(f.libraryId, f.id);
      if (!r.ok) {
        notifications.show({ color: 'red', title: 'Duplicate failed', message: r.error });
        break;
      }
    }
  }, [files, selectedFileIds]);

  const requestMove = useCallback(
    (toParentDir: string, fileIds: number[]) => {
      const draggedFiles = filesAt(fileIds);
      if (draggedFiles.length === 0) return;
      // Drag-onto-folder uses the folder tree of the active library, so the
      // drop only makes sense for files that live in that library. Drop the
      // rest silently rather than try to translate paths across libraries.
      const targetLib = draggedFiles[0].libraryId;
      const sameLib = draggedFiles.filter((f) => f.libraryId === targetLib);
      if (sameLib.length === 0) return;
      // Skip the confirm when the user drops into the folder the files
      // already live in.
      if (sameLib.every((f) => f.parentDir === toParentDir)) return;
      setMoveConfirm({ open: true, files: sameLib, toParentDir });
    },
    // filesAt closes over `files` state via a helper defined below
    []
  );

  const filesAt = useCallback(
    (ids: number[]) => files.filter((f) => ids.includes(f.id)),
    [files]
  );

  const performMove = useCallback(async () => {
    const { files: toMove, toParentDir } = moveConfirm;
    setMoveConfirm({ open: false, files: [], toParentDir: '' });
    for (const f of toMove) {
      // Moves stay within the file's owning library — the drop target is a
      // folder path that's only meaningful relative to that library's root.
      const r = await ipc.moveFile(f.libraryId, f.id, toParentDir);
      if (!r.ok) {
        notifications.show({ color: 'red', title: 'Move failed', message: r.error });
        break;
      }
    }
  }, [moveConfirm]);

  const handleAdd = useCallback(async () => {
    const picked = await ipc.pickFolder();
    if (picked.canceled || !picked.path) return;
    const result = await ipc.addLibrary({ mountPath: picked.path });
    if (!result.ok) {
      notifications.show({ color: 'red', title: 'Add library failed', message: result.error });
      return;
    }
    notifications.show({
      color: 'green',
      title: 'Library added',
      message: `${result.library.name} — scanning…`
    });
    await refreshLibraries();
    setSelectedLibraryId(result.library.id);
  }, [refreshLibraries]);

  const handleRemove = useCallback(
    async (id: string) => {
      const result = await ipc.removeLibrary({ id });
      if (!result.ok) {
        notifications.show({ color: 'red', title: 'Remove failed', message: result.error });
        return;
      }
      await refreshLibraries();
    },
    [refreshLibraries]
  );

  const handleRemoveAndDeleteCache = useCallback(
    async (id: string) => {
      const result = await ipc.removeLibrary({ id, deleteCache: true });
      if (!result.ok) {
        notifications.show({ color: 'red', title: 'Delete cache failed', message: result.error });
        return;
      }
      notifications.show({
        color: 'green',
        title: 'Cache deleted',
        message: 'Library removed and cache cleared.'
      });
      await refreshLibraries();
    },
    [refreshLibraries]
  );

  const handleRename = useCallback(
    async (id: string, name: string) => {
      const result = await ipc.renameLibrary({ id, name });
      if (!result.ok) {
        notifications.show({ color: 'red', title: 'Rename failed', message: result.error });
        return;
      }
      await refreshLibraries();
    },
    [refreshLibraries]
  );

  const handleReveal = useCallback(async (id: string) => {
    const result = await ipc.revealLibrary(id);
    if (!result.ok) {
      notifications.show({ color: 'orange', title: 'Reveal failed', message: result.error });
    }
  }, []);

  const handleRescanLibrary = useCallback(async (id: string) => {
    const result = await ipc.rescan(id);
    if (!result.ok) {
      notifications.show({ color: 'orange', title: 'Rescan', message: result.error ?? 'failed' });
    }
  }, []);

  const handleRescan = useCallback(async () => {
    if (!selectedLibraryId) return;
    const result = await ipc.rescan(selectedLibraryId);
    if (!result.ok) {
      notifications.show({ color: 'orange', title: 'Rescan', message: result.error ?? 'failed' });
    }
  }, [selectedLibraryId]);

  const handleRerenderThumb = useCallback(
    (fileId: number) => {
      const file = files.find((f) => f.id === fileId);
      if (!file) return;
      void ipc.rerenderThumb(file.libraryId, fileId);
    },
    [files]
  );

  // Bulk handlers — wired into the metadata pane's bulk mode.
  const selectedIdsArray = useMemo(() => [...selectedFileIds], [selectedFileIds]);

  const handleBulkAddTag = useCallback(
    async (tagName: string) => {
      if (!selectedLibraryId || selectedIdsArray.length === 0) return;
      await ipc.addTagToFiles(selectedLibraryId, selectedIdsArray, tagName);
    },
    [selectedLibraryId, selectedIdsArray]
  );

  const handleBulkRemoveTag = useCallback(
    async (tagId: number) => {
      if (!selectedLibraryId || selectedIdsArray.length === 0) return;
      await ipc.removeTagFromFiles(selectedLibraryId, selectedIdsArray, tagId);
    },
    [selectedLibraryId, selectedIdsArray]
  );

  const handleBulkSetOrientation = useCallback(
    async (orientation: FileOrientation | null) => {
      if (!selectedLibraryId || selectedIdsArray.length === 0) return;
      await ipc.setFileOrientations(selectedLibraryId, selectedIdsArray, orientation);
    },
    [selectedLibraryId, selectedIdsArray]
  );

  const handleBulkRerender = useCallback(async () => {
    if (!selectedLibraryId || selectedIdsArray.length === 0) return;
    await ipc.rerenderThumbs(selectedLibraryId, selectedIdsArray);
  }, [selectedLibraryId, selectedIdsArray]);

  // Rating/label apply to the single-file primary too — both panels route
  // through these same handlers, so there's one code path for tile/menu/panel
  // sources.
  const handleBulkSetRating = useCallback(
    async (rating: number) => {
      if (!selectedLibraryId || selectedIdsArray.length === 0) return;
      await ipc.setFileRatings(selectedLibraryId, selectedIdsArray, rating);
    },
    [selectedLibraryId, selectedIdsArray]
  );

  const handleBulkSetColorLabel = useCallback(
    async (label: ColorLabel | null) => {
      if (!selectedLibraryId || selectedIdsArray.length === 0) return;
      await ipc.setFileColorLabels(selectedLibraryId, selectedIdsArray, label);
    },
    [selectedLibraryId, selectedIdsArray]
  );

  // Global keyboard shortcuts. The input-focus guard prevents number keys
  // from re-rating files while the user is typing in search, tag input, or
  // any modal. We treat the renderer as a Bridge-style triage surface:
  //   0..5  — set rating on the current selection
  //   Cmd/Ctrl+0     — clear color label
  //   Cmd/Ctrl+1..5  — set red/yellow/green/blue/purple
  //   ArrowLeft/Right — move primary selection one tile
  //   Shift+Arrow   — extend selection
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Ignore when the user is typing into an input, textarea, contenteditable,
      // or any element that hosts focus in a modal/menu.
      if (target) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        )
          return;
      }
      if (!selectedLibraryId) return;

      // Color labels — modifier + 1..5 = red..purple, modifier + 0 = clear.
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey) {
        if (e.key === '0') {
          e.preventDefault();
          void handleBulkSetColorLabel(null);
          return;
        }
        const idx = '12345'.indexOf(e.key);
        if (idx >= 0 && idx < COLOR_LABELS.length) {
          e.preventDefault();
          void handleBulkSetColorLabel(COLOR_LABELS[idx]);
          return;
        }
      }

      // Ratings — plain number keys 0..5
      if (!mod && !e.altKey && !e.shiftKey) {
        const n = '012345'.indexOf(e.key);
        if (n >= 0) {
          if (selectedFileIds.size === 0) return;
          e.preventDefault();
          void handleBulkSetRating(n);
          return;
        }
      }

      // Delete / Backspace → trash the selection (with confirm).
      if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) {
        if (selectedFileIds.size === 0) return;
        e.preventDefault();
        requestDelete();
        return;
      }

      // Cmd/Ctrl+D → duplicate selection.
      if (mod && !e.shiftKey && !e.altKey && (e.key === 'd' || e.key === 'D')) {
        if (selectedFileIds.size === 0) return;
        e.preventDefault();
        void performDuplicate();
        return;
      }

      // Space → toggle fullscreen preview for the primary file.
      if (e.key === ' ' && !mod && !e.shiftKey && !e.altKey) {
        if (primaryFileId == null) return;
        e.preventDefault();
        setFullscreenOpen((v) => !v);
        return;
      }

      // Arrow nav (left/right linearly through the visible files array)
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (files.length === 0) return;
        const idx = primaryFileId != null ? files.findIndex((f) => f.id === primaryFileId) : -1;
        const nextIdx =
          idx < 0
            ? 0
            : e.key === 'ArrowRight'
              ? Math.min(files.length - 1, idx + 1)
              : Math.max(0, idx - 1);
        const nextFile = files[nextIdx];
        if (!nextFile) return;
        e.preventDefault();
        handleTileClick(nextFile.id, {
          shift: e.shiftKey,
          meta: false,
          ctrl: false
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    selectedLibraryId,
    selectedFileIds,
    files,
    primaryFileId,
    handleBulkSetRating,
    handleBulkSetColorLabel,
    handleTileClick,
    requestDelete,
    performDuplicate
  ]);

  const handleAddToCollection = useCallback(
    async (collectionId: number, fileIds: number[]) => {
      if (!selectedLibraryId) return;
      await ipc.addFilesToCollection(selectedLibraryId, collectionId, fileIds);
    },
    [selectedLibraryId]
  );

  const handleRemoveFromCollection = useCallback(
    async (collectionId: number, fileIds: number[]) => {
      if (!selectedLibraryId) return;
      await ipc.removeFilesFromCollection(selectedLibraryId, collectionId, fileIds);
    },
    [selectedLibraryId]
  );

  const handleCreateCollection = useCallback(
    async (name: string) => {
      if (!selectedLibraryId) return null;
      try {
        return await ipc.createCollection(selectedLibraryId, name);
      } catch (err) {
        notifications.show({
          color: 'red',
          title: 'Create collection failed',
          message: (err as Error).message
        });
        return null;
      }
    },
    [selectedLibraryId]
  );

  const handleRenameCollection = useCallback(
    async (id: number, name: string) => {
      if (!selectedLibraryId) return;
      try {
        await ipc.renameCollection(selectedLibraryId, id, name);
      } catch (err) {
        notifications.show({
          color: 'red',
          title: 'Rename collection failed',
          message: (err as Error).message
        });
      }
    },
    [selectedLibraryId]
  );

  const handleExportCollectionZip = useCallback(
    async (id: number) => {
      if (!selectedLibraryId) return;
      const r = await ipc.exportCollectionZip(selectedLibraryId, id);
      if (!r.ok) {
        notifications.show({ color: 'red', title: 'Export failed', message: r.error });
      } else if (!r.canceled) {
        notifications.show({
          color: 'green',
          title: 'Collection exported',
          message: `${r.fileCount} file${r.fileCount === 1 ? '' : 's'} → ${r.path}`
        });
      }
    },
    [selectedLibraryId]
  );

  const handleExportCollectionContactSheet = useCallback(
    async (id: number) => {
      if (!selectedLibraryId) return;
      // Fetch the collection's file ids via the regular query path — no new
      // IPC needed and it respects smart-collection rules too.
      const collectionFiles = await ipc.queryFiles({
        libraryId: selectedLibraryId,
        collectionId: id,
        limit: 5000
      });
      if (collectionFiles.length === 0) {
        notifications.show({
          color: 'orange',
          title: 'Contact sheet',
          message: 'Collection is empty.'
        });
        return;
      }
      const r = await ipc.exportContactSheet(
        selectedLibraryId,
        collectionFiles.map((f) => f.id)
      );
      if (!r.ok) {
        notifications.show({ color: 'red', title: 'Export failed', message: r.error });
      } else if (!r.canceled) {
        notifications.show({
          color: 'green',
          title: 'Contact sheet saved',
          message: r.path
        });
      }
    },
    [selectedLibraryId]
  );

  const handleDeleteCollection = useCallback(
    async (id: number) => {
      if (!selectedLibraryId) return;
      await ipc.deleteCollection(selectedLibraryId, id);
      if (selectedCollectionId === id) setSelectedCollectionId(null);
    },
    [selectedLibraryId, selectedCollectionId]
  );

  const handleToggleExtension = useCallback((ext: SupportedExtension) => {
    setSelectedExtensions((prev) => {
      const next = new Set(prev);
      if (next.has(ext)) next.delete(ext);
      else next.add(ext);
      return next;
    });
  }, []);

  const handleToggleColorLabel = useCallback((label: ColorLabel) => {
    setSelectedColorLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  const handleToggleTag = useCallback((tagId: number) => {
    setSelectedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }, []);

  const handleDeleteTag = useCallback(
    async (tagId: number) => {
      if (!selectedLibraryId) return;
      await ipc.deleteTag(selectedLibraryId, tagId);
      setSelectedTagIds((prev) => {
        const next = new Set(prev);
        next.delete(tagId);
        return next;
      });
    },
    [selectedLibraryId]
  );

  const { prefs } = usePreferences();
  const printBeds = prefs?.printBeds ?? [];
  const activeBed = selectedBedId ? printBeds.find((b) => b.id === selectedBedId) ?? null : null;

  // Client-side bed filter — runs after the DB query because bed dimensions
  // come from prefs (not the DB) and the bounding box lives in metadata_json.
  const displayedFiles = useMemo(() => {
    if (!activeBed) return files;
    return files.filter((f) => {
      const meta = parseMeta(f.metadataJson);
      return modelFitsSpecificBed(meta, activeBed);
    });
  }, [files, activeBed]);

  const selectedLibrary = libraries.find((l) => l.id === selectedLibraryId) ?? null;
  const selectedCollection =
    selectedCollectionId != null
      ? collections.find((c) => c.id === selectedCollectionId) ?? null
      : null;
  const primaryFile = useMemo(
    () => files.find((f) => f.id === primaryFileId) ?? null,
    [files, primaryFileId]
  );
  const selectedFiles = useMemo(
    () => files.filter((f) => selectedFileIds.has(f.id)),
    [files, selectedFileIds]
  );

  const leftSidebar = (
    <Stack
      gap={0}
      h="100%"
      style={{ borderRight: '1px solid var(--mantine-color-dark-4)' }}
    >
      {/* Top fixed: Libraries → "Show all" → Collections. These never get
          pushed by the folder tree expanding/collapsing because they sit
          above it in the flex column. */}
      <Stack gap="sm" style={{ padding: 8, flexShrink: 0 }}>
        <LibrarySidebar
          libraries={libraries}
          selectedId={selectedLibraryId}
          onSelect={setSelectedLibraryId}
          onAdd={handleAdd}
          onRename={handleRename}
          onReveal={handleReveal}
          onRescan={handleRescanLibrary}
          onRemove={handleRemove}
          onRemoveAndDeleteCache={handleRemoveAndDeleteCache}
        />
        {selectedLibrary && (
          <ShowAllInLibraryLink
            libraryName={selectedLibrary.name}
            active={viewScope === 'tree'}
            onClick={selectAllInCurrentLibrary}
          />
        )}
        {selectedLibrary && (
          <>
            <Divider />
            <CollectionsSidebar
              collections={collections}
              selectedCollectionId={selectedCollectionId}
              onSelect={selectCollection}
              onCreate={(name) => void handleCreateCollection(name)}
              onCreateSmart={() => setSmartCollectionEditor({ open: true, existing: null })}
              onEditSmart={(c) => setSmartCollectionEditor({ open: true, existing: c })}
              onRename={(id, name) => void handleRenameCollection(id, name)}
              onDelete={(id) => void handleDeleteCollection(id)}
              onExportZip={(id) => void handleExportCollectionZip(id)}
              onExportContactSheet={(id) => void handleExportCollectionContactSheet(id)}
            />
          </>
        )}
      </Stack>

      {/* Flexible middle: the folder tree. Auto-expansion to the selected
          path can grow this section freely; the scroll area absorbs any
          excess and the pinned-bottom area below stays put. */}
      {selectedLibrary && (
        <>
          <Divider />
          <div style={{ flex: 1, minHeight: 0 }}>
            <ScrollArea h="100%" type="auto">
              <div style={{ padding: 8 }}>
                <FolderTree
                  root={folderTree}
                  selectedPath={
                    viewScope !== 'normal' || selectedCollectionId != null
                      ? null
                      : selectedFolderPath
                  }
                  onSelect={selectFolder}
                  onDropFiles={requestMove}
                />
              </div>
            </ScrollArea>
          </div>
        </>
      )}

      {/* Pinned bottom: Favorites/Recent (expanded by default) and
          Triage/Tags (collapsed by default). All collapsible so power users
          can free up vertical space when they don't need them. */}
      {selectedLibrary && (
        <div
          style={{
            flexShrink: 0,
            borderTop: '1px solid var(--mantine-color-dark-4)',
            padding: 8,
            background: 'var(--mantine-color-dark-7)'
          }}
        >
          <Stack gap="xs">
            <CollapsibleSection title="Favorites" defaultExpanded>
              <FolderRowList
                paths={favoriteFolders}
                selectedPath={selectedFolderPath}
                onSelect={selectFolder}
                onToggleFavorite={toggleFavoriteFolder}
                isFavorite={isFavoriteFolder}
              />
            </CollapsibleSection>
            <CollapsibleSection title="Recent" defaultExpanded>
              <FolderRowList
                paths={visibleRecentFolders}
                selectedPath={selectedFolderPath}
                onSelect={selectFolder}
                onToggleFavorite={toggleFavoriteFolder}
                isFavorite={isFavoriteFolder}
              />
            </CollapsibleSection>
            <CollapsibleSection title="Triage">
              <TriageFacets
                headerless
                minRating={minRating}
                colorLabels={selectedColorLabels}
                onSetMinRating={setMinRating}
                onToggleLabel={handleToggleColorLabel}
              />
            </CollapsibleSection>
            <CollapsibleSection title="Tags">
              <TagsSidebar
                headerless
                libraryId={selectedLibraryId}
                tags={allTags}
                selectedTagIds={selectedTagIds}
                onToggle={handleToggleTag}
                onClear={() => setSelectedTagIds(new Set())}
                onDelete={handleDeleteTag}
              />
            </CollapsibleSection>
            {printBeds.length > 0 && (
              <PrintBedFacet
                beds={printBeds}
                selectedBedId={selectedBedId}
                onChange={setSelectedBedId}
              />
            )}
          </Stack>
        </div>
      )}
    </Stack>
  );

  const sortToolbar = (
    <ViewSortToolbar sort={sort} onSortChange={setSort} view={viewMode} onViewChange={setViewMode} />
  );

  const gridPane = !selectedLibrary ? (
    <Center h="100%">
      <Stack align="center" gap="xs">
        <Text c="dimmed">No libraries yet.</Text>
        <Text size="sm" c="dimmed">
          Click "Add library" in the sidebar to point meshFlask at a folder of 3D files.
        </Text>
      </Stack>
    </Center>
  ) : !selectedLibrary.online ? (
    <OfflineState library={selectedLibrary} />
  ) : viewMode === 'list' ? (
    <Stack gap={0} h="100%">
      <Group
        h={32}
        px={12}
        gap={6}
        justify="space-between"
        style={{
          flexShrink: 0,
          borderBottom: '1px solid var(--mantine-color-dark-4)',
          background: 'var(--mantine-color-dark-7)'
        }}
      >
        <Text size="xs" c="dimmed">
          {displayedFiles.length} {displayedFiles.length === 1 ? 'item' : 'items'}
          {selectedFileIds.size > 0 && ` · ${selectedFileIds.size} selected`}
        </Text>
        {sortToolbar}
      </Group>
      <FileListView
        libraryId={selectedLibrary.id}
        files={displayedFiles}
        thumbVersions={thumbVersions}
        selectedIds={selectedFileIds}
        primaryId={primaryFileId}
        onTileClick={handleTileClick}
        onTileContextMenu={handleTileContextMenu}
      />
    </Stack>
  ) : (
    <ThumbGrid
      libraryId={selectedLibrary.id}
      files={displayedFiles}
      thumbVersions={thumbVersions}
      selectedIds={selectedFileIds}
      primaryId={primaryFileId}
      onTileClick={handleTileClick}
      onTileContextMenu={handleTileContextMenu}
      headerExtras={sortToolbar}
      printBeds={printBeds}
    />
  );

  const previewPane = (
    <PreviewPane
      libraryId={selectedLibraryId}
      file={primaryFile}
      selectionCount={selectedFileIds.size}
      lightingStyle={lightingStyle}
      onLightingStyleChange={setLightingStyleState}
      onRerenderThumb={handleRerenderThumb}
    />
  );

  const metadataPane = (
    <div style={{ height: '100%', borderLeft: '1px solid var(--mantine-color-dark-4)' }}>
      <MetadataPanel
        libraryId={selectedLibraryId}
        primaryFile={primaryFile}
        selectedFiles={selectedFiles}
        allTags={allTags}
        collections={collections}
        activeCollectionId={selectedCollectionId}
        tagRefreshKey={tagRefreshKey}
        onBulkAddTag={handleBulkAddTag}
        onBulkRemoveTag={handleBulkRemoveTag}
        onBulkSetOrientation={handleBulkSetOrientation}
        onBulkSetRating={handleBulkSetRating}
        onBulkSetColorLabel={handleBulkSetColorLabel}
        onBulkRerender={handleBulkRerender}
        onBatchRename={() => setBatchRenameOpen(true)}
        onCompare={() => setCompareOpen(true)}
        onAddToCollection={handleAddToCollection}
        onRemoveFromCollection={handleRemoveFromCollection}
        onCreateCollection={handleCreateCollection}
      />
    </div>
  );

  return (
    <AppShell header={{ height: 88 }} padding={0}>
      <AppShell.Header>
        <Stack gap={0} h="100%">
          <Group h={44} px="md" gap="md" wrap="nowrap">
            <Group gap={8} wrap="nowrap" style={{ flexShrink: 0 }}>
              <Logo size={22} />
              <Text fw={600}>meshFlask</Text>
            </Group>
            <Divider orientation="vertical" />
            <Breadcrumbs
              library={selectedLibrary}
              folderPath={selectedFolderPath}
              collectionName={selectedCollection?.name ?? null}
              scope={viewScope}
            />
            <div style={{ flex: 1 }} />
            <ScanStatusBadge status={scanStatus} />
            <Tooltip label="Rescan library">
              <ActionIcon
                variant="subtle"
                onClick={handleRescan}
                disabled={!selectedLibraryId || scanStatus?.state === 'scanning'}
                aria-label="Rescan"
              >
                <IconRefresh size={16} />
              </ActionIcon>
            </Tooltip>
            <Select
              size="xs"
              w={140}
              placeholder="Workspace"
              value={workspace}
              onChange={(v) => applyWorkspace(v as Workspace | null)}
              data={Object.entries(WORKSPACES).map(([id, def]) => ({
                value: id,
                label: def.label
              }))}
              comboboxProps={{ withinPortal: true }}
              clearable
            />
            <Tooltip label="Support meshFlask">
              <ActionIcon
                variant="subtle"
                component="a"
                href="https://buymeacoffee.com/thorson"
                target="_blank"
                rel="noreferrer"
                aria-label="Buy me a coffee"
              >
                <IconCoffee size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Preferences">
              <ActionIcon
                variant="subtle"
                onClick={() => setPreferencesOpen(true)}
                aria-label="Preferences"
              >
                <IconSettings size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <Divider />
          <Group h={44} px="md" gap="md" wrap="nowrap">
            <SearchBar
              query={searchInput}
              onQueryChange={setSearchInput}
              selectedExtensions={selectedExtensions}
              onToggleExtension={handleToggleExtension}
              onClearExtensions={() => setSelectedExtensions(new Set())}
              libraryName={selectedLibrary?.name ?? null}
            />
            {filterActive && (
              <Badge size="sm" variant="light" color="indigo">
                {files.length} match{files.length === 1 ? '' : 'es'}
              </Badge>
            )}
          </Group>
        </Stack>
      </AppShell.Header>

      <AppShell.Main style={{ height: '100vh' }}>
        <PanelGroup
          ref={outerPanelGroupRef}
          direction="horizontal"
          autoSaveId="wh3d:panes"
          style={{ height: '100%' }}
        >
          <Panel defaultSize={22} minSize={12} order={1}>
            {leftSidebar}
          </Panel>
          <PanelResizeHandle className="wh3d-resize-handle wh3d-resize-handle--col" />
          <Panel defaultSize={53} minSize={25} order={2}>
            <PanelGroup
              ref={innerPanelGroupRef}
              direction="vertical"
              autoSaveId="wh3d:middle-panes"
              style={{ height: '100%' }}
            >
              <Panel defaultSize={55} minSize={20} order={1}>
                {previewPane}
              </Panel>
              <PanelResizeHandle className="wh3d-resize-handle wh3d-resize-handle--row" />
              <Panel defaultSize={45} minSize={20} order={2}>
                <div
                  style={{
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    borderTop: '1px solid var(--mantine-color-dark-4)'
                  }}
                >
                  {gridPane}
                </div>
              </Panel>
            </PanelGroup>
          </Panel>
          <PanelResizeHandle className="wh3d-resize-handle wh3d-resize-handle--col" />
          <Panel defaultSize={25} minSize={15} order={3}>
            {metadataPane}
          </Panel>
        </PanelGroup>
      </AppShell.Main>

      <PreferencesModal
        opened={preferencesOpen}
        onClose={() => setPreferencesOpen(false)}
        libraryId={selectedLibraryId}
      />

      <BatchRenameModal
        opened={batchRenameOpen}
        libraryId={selectedLibraryId}
        files={selectedFiles}
        onClose={() => setBatchRenameOpen(false)}
      />

      <FullscreenPreviewModal
        opened={fullscreenOpen}
        onClose={() => setFullscreenOpen(false)}
        libraryId={selectedLibraryId}
        file={primaryFile}
        lightingStyle={lightingStyle}
      />

      <DeleteConfirmModal
        opened={deleteConfirm.open}
        files={deleteConfirm.files}
        onCancel={() => setDeleteConfirm({ open: false, files: [] })}
        onConfirm={() => void performDelete()}
      />

      <MoveConfirmModal
        opened={moveConfirm.open}
        files={moveConfirm.files}
        toParentDir={moveConfirm.toParentDir}
        onCancel={() => setMoveConfirm({ open: false, files: [], toParentDir: '' })}
        onConfirm={() => void performMove()}
      />

      <CompareModal
        opened={compareOpen}
        onClose={() => setCompareOpen(false)}
        libraryId={selectedLibraryId}
        left={selectedFiles[0] ?? null}
        right={selectedFiles[1] ?? null}
        lightingStyle={lightingStyle}
      />

      <SmartCollectionModal
        opened={smartCollectionEditor.open}
        existing={smartCollectionEditor.existing}
        libraryId={selectedLibraryId}
        allTags={allTags}
        onClose={() => setSmartCollectionEditor({ open: false, existing: null })}
        onSaved={(c) => {
          // Refresh the collection list (handled via collections-changed event)
          // and jump to the saved collection so the user sees their query in action.
          setSelectedCollectionId(c.id);
          setSelectedFolderPath('');
        }}
      />

      {selectedLibraryId && (
        <ThumbContextMenu
          opened={contextMenu.open}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
          libraryId={selectedLibraryId}
          selectedFiles={selectedFiles}
          primaryFile={primaryFile}
          onOpenPreferences={() => setPreferencesOpen(true)}
          allTags={allTags}
          collections={collections}
          activeCollectionId={selectedCollectionId}
          onBulkAddTag={handleBulkAddTag}
          onBulkRemoveTag={handleBulkRemoveTag}
          onBulkSetOrientation={handleBulkSetOrientation}
          onBulkSetRating={handleBulkSetRating}
          onBulkSetColorLabel={handleBulkSetColorLabel}
          onBulkRerender={handleBulkRerender}
          onBatchRename={() => setBatchRenameOpen(true)}
          onDuplicate={() => void performDuplicate()}
          onDelete={requestDelete}
          onAddToCollection={handleAddToCollection}
          onRemoveFromCollection={handleRemoveFromCollection}
          onCreateCollection={handleCreateCollection}
        />
      )}
    </AppShell>
  );
}

function ShowAllInLibraryLink({
  libraryName,
  active,
  onClick
}: {
  libraryName: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        border: 'none',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        display: 'block',
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        borderRadius: 4,
        fontSize: 13,
        lineHeight: 1.5,
        color: active ? 'var(--mantine-color-indigo-3)' : 'var(--mantine-color-gray-3)',
        background: active ? 'var(--mantine-color-dark-5)' : 'transparent',
        fontWeight: active ? 600 : 500,
        whiteSpace: 'nowrap'
      }}
      title={`Show all models in current library: ${libraryName}`}
    >
      Show all models in current library:{' '}
      <span style={{ color: 'var(--mantine-color-indigo-3)' }}>{libraryName}</span>
    </button>
  );
}

function Breadcrumbs({
  library,
  folderPath,
  collectionName,
  scope
}: {
  library: LibrarySummary | null;
  folderPath: string;
  collectionName: string | null;
  scope: 'normal' | 'tree';
}) {
  if (!library)
    return (
      <Text size="sm" c="dimmed">
        No library
      </Text>
    );
  const segments =
    scope === 'tree' || collectionName ? [] : folderPath ? folderPath.split('/') : [];
  return (
    <Group gap={4} wrap="nowrap" style={{ minWidth: 0, overflow: 'hidden' }}>
      <Text size="sm" fw={500} truncate>
        {library.name}
      </Text>
      {scope === 'tree' && (
        <Group gap={4} wrap="nowrap">
          <Text size="sm" c="dimmed">
            /
          </Text>
          <Badge size="sm" variant="light" color="teal">
            All models
          </Badge>
        </Group>
      )}
      {collectionName != null && (
        <Group gap={4} wrap="nowrap">
          <Text size="sm" c="dimmed">
            /
          </Text>
          <Badge size="sm" variant="light" color="indigo">
            {collectionName}
          </Badge>
        </Group>
      )}
      {segments.map((seg, i) => (
        <Group key={i} gap={4} wrap="nowrap">
          <Text size="sm" c="dimmed">
            /
          </Text>
          <Text size="sm" truncate>
            {seg}
          </Text>
        </Group>
      ))}
    </Group>
  );
}

function ScanStatusBadge({ status }: { status: ScanProgress | null }) {
  if (!status) return null;
  if (status.state === 'scanning') {
    return (
      <Group gap={6} wrap="nowrap">
        <Loader size="xs" />
        <Text size="xs" c="dimmed">
          Scanning · {status.filesSeen} files
        </Text>
      </Group>
    );
  }
  if (status.state === 'error') {
    return (
      <Badge size="sm" color="red" variant="light">
        Scan error
      </Badge>
    );
  }
  if (status.state === 'watching') {
    const total = status.inserted + status.updated;
    return (
      <Text size="xs" c="dimmed">
        Watching · {status.filesSeen} files{total > 0 ? ` (+${total} this scan)` : ''}
      </Text>
    );
  }
  return null;
}

function OfflineState({ library }: { library: LibrarySummary }) {
  return (
    <Center h="100%">
      <Stack align="center" gap={4}>
        <Text fw={600}>{library.name} is offline</Text>
        <Text size="sm" c="dimmed">
          The library mount path was not found:
        </Text>
        <Text size="sm" c="dimmed" style={{ fontFamily: 'monospace' }}>
          {library.mountPath}
        </Text>
        <Text size="xs" c="dimmed" mt="md">
          Mount the volume or update the path in your libraries.json, then restart the app.
        </Text>
      </Stack>
    </Center>
  );
}
