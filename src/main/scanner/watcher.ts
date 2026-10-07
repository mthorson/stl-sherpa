import chokidar from 'chokidar';
import { lstat, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { PathResolver } from '@shared/paths';
import { isNetworkMount } from '@main/files/network-mount';
import { extensionOf, isSupportedExtension } from '@shared/formats';
import type { FilesRepo } from '@main/db/repos/files';
import { hashFileContent } from '@main/files/hash';

// fsevents (mac) and inotify (linux) don't fire on network mounts, so chokidar
// is silent there unless we fall back to polling. 10s keeps NAS load low at
// the cost of changes taking up to ~10s to appear. Configurable via prefs
// (`nasPollIntervalSec`), threaded in at watcher construction.
const DEFAULT_NAS_POLL_INTERVAL_MS = 10_000;
const NAS_BINARY_POLL_MULTIPLIER = 3;

export interface WatcherCallbacks {
  onChange: () => void;
  onError?: (err: Error) => void;
}

export interface WatcherOptions {
  /** Override poll interval in ms (network mounts only). */
  nasPollIntervalMs?: number;
}

const IGNORE_DIR_NAMES: ReadonlySet<string> = new Set([
  '.meshFlask',
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '@eaDir'
]);

/** How long to hold an unlink before treating it as a real delete. */
const RENAME_WINDOW_MS = 1500;

function shouldIgnore(absPath: string): boolean {
  const name = basename(absPath);
  if (name.startsWith('.') && IGNORE_DIR_NAMES.has(name)) return true;
  if (name.startsWith('.') && name !== '.' && name !== '..') return true;
  if (IGNORE_DIR_NAMES.has(name)) return true;
  return false;
}

export interface LibraryWatcher {
  close(options?: { flushPending?: boolean }): Promise<void>;
}

interface PendingUnlink {
  fileId: number;
  relPath: string;
  filename: string;
  ext: string;
  sizeBytes: number;
  mtimeMs: number;
  contentSha256: string | null;
  timer: NodeJS.Timeout;
}

export function startWatcher(
  resolver: PathResolver,
  files: FilesRepo,
  cb: WatcherCallbacks,
  opts: WatcherOptions = {}
): LibraryWatcher {
  const root = resolver.getMountPath();
  const isNetwork = isNetworkMount(root);
  const requestedPollMs = opts.nasPollIntervalMs;
  const pollMs =
    typeof requestedPollMs === 'number' && Number.isFinite(requestedPollMs)
      ? Math.min(60_000, Math.max(1_000, requestedPollMs))
      : DEFAULT_NAS_POLL_INTERVAL_MS;

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    persistent: true,
    ignored: shouldIgnore,
    awaitWriteFinish: {
      stabilityThreshold: 750,
      pollInterval: 150
    },
    depth: 99,
    followSymlinks: false,
    // fsevents/inotify don't fire on network mounts. Fall back to polling so
    // external Finder changes still propagate; accept the staleness window.
    usePolling: isNetwork,
    interval: isNetwork ? pollMs : undefined,
    binaryInterval: isNetwork ? pollMs * NAS_BINARY_POLL_MULTIPLIER : undefined
  });

  // Pending unlinks bucketed by (size, mtime). When an add arrives matching
  // any bucket within RENAME_WINDOW_MS, we treat the pair as a rename and
  // preserve the file's id, thumbnail, and tags. Otherwise the timer fires
  // and the unlink becomes a real delete.
  const pending = new Map<string, PendingUnlink[]>();
  const activeTasks = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | null = null;

  const reportError = (err: unknown): void => {
    try {
      cb.onError?.(err instanceof Error ? err : new Error(String(err)));
    } catch {
      // Error reporting must not create an unhandled rejection of its own.
    }
  };

  const runTask = (fn: () => Promise<void>): void => {
    if (closing) return;
    const task = fn()
      .catch(reportError)
      .finally(() => activeTasks.delete(task));
    activeTasks.add(task);
  };

  const sigKey = (size: number, mtime: number) => `${size}:${mtime}`;

  const removePending = (entry: PendingUnlink): void => {
    const key = sigKey(entry.sizeBytes, entry.mtimeMs);
    const list = pending.get(key);
    if (!list) return;
    const idx = list.indexOf(entry);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) pending.delete(key);
  };

  const handleAddOrChange = async (absPath: string, allowRename: boolean) => {
    const ext = extensionOf(absPath);
    if (!isSupportedExtension(ext)) return;

    let s: Awaited<ReturnType<typeof stat>>;
    try {
      if ((await lstat(absPath)).isSymbolicLink()) return;
      s = await stat(absPath);
    } catch {
      return;
    }
    let relPath: string;
    try {
      relPath = resolver.toRelative(absPath);
    } catch {
      return;
    }
    const sizeBytes = s.size;
    const mtimeMs = Math.floor(s.mtimeMs);
    const slash = relPath.lastIndexOf('/');
    const parentDir = slash < 0 ? '' : relPath.slice(0, slash);
    const filename = basename(absPath);

    // Rename match: an unlink with the same (size, mtime) is waiting in the
    // pending bucket. Pair them, cancel the delete timer, rename in place.
    const key = sigKey(sizeBytes, mtimeMs);
    const bucket = pending.get(key);
    const matches = bucket?.filter((entry) => entry.ext === ext) ?? [];
    if (allowRename && !files.getByRelPath(relPath) && bucket && matches.length === 1) {
      const match = matches[0];
      // Reserve the candidate before hashing. Large files can take longer
      // than the rename window, and its delete timer must not fire mid-hash.
      bucket.splice(bucket.indexOf(match), 1);
      if (bucket.length === 0) pending.delete(key);
      clearTimeout(match.timer);
      const digest = match.contentSha256 ? await hashFileContent(absPath) : null;
      if (match.contentSha256 === null || digest === match.contentSha256) {
        files.applyRenames([
          {
            id: match.fileId,
            toRelPath: relPath,
            toParentDir: parentDir,
            toFilename: filename
          }
        ]);
        cb.onChange();
        return;
      }
      files.deleteByRelPath(match.relPath);
    }

    files.upsert({ relPath, parentDir, filename, ext, sizeBytes, mtimeMs });
    cb.onChange();
  };

  const handleUnlink = (absPath: string) => {
    const ext = extensionOf(absPath);
    if (!isSupportedExtension(ext)) return;
    let relPath: string;
    try {
      relPath = resolver.toRelative(absPath);
    } catch {
      return;
    }
    const file = files.getByRelPath(relPath);
    if (!file) return;

    const entry: PendingUnlink = {
      fileId: file.id,
      relPath: file.relPath,
      filename: file.filename,
      ext: file.ext,
      sizeBytes: file.sizeBytes,
      mtimeMs: file.mtimeMs,
      contentSha256: file.contentSha256,
      timer: setTimeout(() => {
        try {
          removePending(entry);
          if (files.deleteByRelPath(file.relPath)) cb.onChange();
        } catch (err) {
          reportError(err);
        }
      }, RENAME_WINDOW_MS)
    };
    const key = sigKey(file.sizeBytes, file.mtimeMs);
    const list = pending.get(key);
    if (list) list.push(entry);
    else pending.set(key, [entry]);
  };

  watcher.on('add', (p) => runTask(() => handleAddOrChange(p, true)));
  watcher.on('change', (p) => runTask(() => handleAddOrChange(p, false)));
  watcher.on('unlink', (p) => {
    if (closing) return;
    try {
      handleUnlink(p);
    } catch (err) {
      reportError(err);
    }
  });
  watcher.on('error', reportError);

  return {
    close(options = {}) {
      if (!closePromise) {
        closePromise = (async () => {
          closing = true;
          // Stop timers before waiting so none can touch the DB during close.
          for (const list of pending.values()) {
            for (const entry of list) clearTimeout(entry.timer);
          }
          await watcher.close();
          await Promise.all(activeTasks);

          if (options.flushPending !== false) {
            // Flush unmatched unlinks after active add/change handlers have
            // had their final chance to pair them as renames. A rescan opts
            // out because its full diff owns stale-row reconciliation.
            for (const list of pending.values()) {
              for (const entry of list) {
                if (files.deleteByRelPath(entry.relPath)) cb.onChange();
              }
            }
          }
          pending.clear();
        })();
      }
      return closePromise;
    }
  };
}
