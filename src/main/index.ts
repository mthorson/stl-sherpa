import { app, BrowserWindow, Menu, shell } from 'electron';
import { join } from 'node:path';
import { registerLibraryIpc } from '@main/ipc/libraries';
import { registerFilesIpc } from '@main/ipc/files';
import { registerTagsIpc } from '@main/ipc/tags';
import { registerCollectionsIpc } from '@main/ipc/collections';
import { registerPreferencesIpc } from '@main/ipc/preferences';
import { registerExportIpc } from '@main/ipc/export';
import * as manager from '@main/libraries/manager';
import {
  registerAssetProtocols,
  registerAssetSchemes
} from '@main/protocol/asset-protocols';
import { thumbPool } from '@main/thumb-pool/pool';
import { queueRunner } from '@main/thumb-pool/queue-runner';
import { DEFAULT_LOG_LEVEL, initLogger, scopedLogger, setLogLevel } from '@main/logger';
import { buildMenu, subscribeMenuToUndoQueue } from '@main/menu';
import * as prefsStore from '@main/preferences/store';

// Keep the established profile (including renderer localStorage) across the
// product rename. Respect explicit profiles supplied by desktop tests/tools.
if (app.getPath('userData') === join(app.getPath('appData'), 'stl-sherpa')) {
  app.setPath('userData', join(app.getPath('appData'), 'meshFlask'));
}

const isDev = !app.isPackaged;
const log = scopedLogger('app');
let mainWindow: BrowserWindow | null = null;

// Custom URL schemes must be registered as privileged BEFORE app is ready so
// the renderer's CSP recognizes wh3d-thumb: / wh3d-file: as image / fetch
// sources.
registerAssetSchemes();

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1a1b1e',
    title: 'stl-sherpa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    // Hidden thumbnail workers are not application windows.
    if (process.platform !== 'darwin' && !shutdownStarted) app.quit();
  });
  win.once('ready-to-show', () => win.show());
  // Library events that fired before the first window existed (e.g.
  // integrity-check failures during openAllFromRegistry) stay queued in
  // @main/events until the renderer pulls them via drainPendingEvents.

  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Only hand valid, encrypted web URLs to the OS. Anything else (file:,
    // custom schemes, malformed URLs) stays inside the app.
    try {
      if (new URL(url).protocol === 'https:') void shell.openExternal(url);
    } catch {
      // Ignore malformed URLs.
    }
    return { action: 'deny' };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

void app.whenReady().then(() => {
  // Init the logger with the default level FIRST, then read prefs and adjust.
  // Reading prefs may itself want to log (corrupt file recovery), so the
  // logger must be ready to receive those entries with the right file path.
  initLogger(DEFAULT_LOG_LEVEL);
  const prefs = prefsStore.getAll();
  setLogLevel(prefs.logLevel ?? DEFAULT_LOG_LEVEL);
  log.info('app ready', { version: app.getVersion(), platform: process.platform, dev: isDev });

  Menu.setApplicationMenu(buildMenu());
  subscribeMenuToUndoQueue();
  registerAssetProtocols();
  registerLibraryIpc();
  registerFilesIpc();
  registerTagsIpc();
  registerCollectionsIpc();
  registerPreferencesIpc();
  registerExportIpc();
  // Best-effort restore of registered libraries; failures show as offline.
  // After each library opens its scanner kicks off a scan, and on completion
  // the queue runner reconciles thumbnails.
  const summaries = manager.openAllFromRegistry();
  log.info('opened libraries from registry', {
    total: summaries.length,
    online: summaries.filter((s) => s.online).length
  });
  // Also reconcile right away in case a library has no new scan to wait for
  // (already-indexed files just need their thumbnails re-checked).
  for (const s of summaries) {
    if (!s.online) continue;
    const lib = manager.getOpenLibrary(s.id);
    if (lib) queueRunner.reconcile(lib);
  }
  const win = createMainWindow();

  // Startup time: from process launch to the first window being ready to show.
  // process.uptime() is wall-clock seconds since this process started, which
  // captures module load + app.whenReady + library open all in one number.
  win.once('ready-to-show', () => {
    log.info('startup complete', { ms: Math.round(process.uptime() * 1000) });
  });

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let shutdownStarted = false;

app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  log.info('app shutting down');
  void (async () => {
    try {
      await queueRunner.shutdown();
    } catch (err) {
      log.error('queue runner shutdown failed', { err: (err as Error).message });
    }
    try {
      await thumbPool.shutdown();
    } catch (err) {
      log.error('thumbnail pool shutdown failed', { err: (err as Error).message });
    }
    await manager.shutdown();
    app.quit();
  })();
});
