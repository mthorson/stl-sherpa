import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { basename, extname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { IPC } from '@shared/ipc-channels';
import type { ExternalAppRegistration, PreferencesFile } from '@shared/preferences';
import * as store from '@main/preferences/store';
import { getOpenLibrary } from '@main/libraries/manager';
import { rebuildThumbnailCache, purgeOrphanThumbs } from '@main/cache/management';
import { DEFAULT_LOG_LEVEL, openLogsFolder, setLogLevel, scopedLogger } from '@main/logger';
import { runUndo } from '@main/undo/runner';

const log = scopedLogger('shell');

/**
 * Tokenize a CLI args template and substitute `{file}` / `{profile}`. Splits
 * on whitespace; quoted segments aren't supported (path arguments with spaces
 * work because we substitute the whole token, not the surrounding chars).
 * When the template is missing or empty, returns just `[file]`.
 */
function buildArgv(template: string | undefined, file: string, profile: string): string[] {
  if (!template || template.trim() === '') return [file];
  return template
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/\{file\}/g, file).replace(/\{profile\}/g, profile))
    .filter((t) => t !== ''); // drop empties so a missing {profile} doesn't add a blank arg
}

export function registerPreferencesIpc(): void {
  ipcMain.handle(
    IPC.listExternalApps,
    async (): Promise<ExternalAppRegistration[]> => store.listExternalApps()
  );

  ipcMain.handle(
    IPC.addExternalApp,
    async (event, extensions: string[]): Promise<ExternalAppRegistration | null> => {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      // macOS opens .app bundles via openDirectory; Windows/Linux pick .exe / scripts.
      const opts: Electron.OpenDialogOptions =
        platform() === 'darwin'
          ? {
              title: 'Pick an application',
              defaultPath: '/Applications',
              properties: ['openFile', 'treatPackageAsDirectory'],
              filters: [{ name: 'Applications', extensions: ['app'] }]
            }
          : {
              title: 'Pick an application',
              properties: ['openFile']
            };
      const result = senderWindow
        ? await dialog.showOpenDialog(senderWindow, opts)
        : await dialog.showOpenDialog(opts);
      if (result.canceled || result.filePaths.length === 0) return null;
      const appPath = result.filePaths[0];
      const name = basename(appPath, extname(appPath));
      return store.addExternalApp({ name, path: appPath, extensions });
    }
  );

  ipcMain.handle(IPC.removeExternalApp, async (_e, id: string) => {
    store.removeExternalApp(id);
  });

  ipcMain.handle(IPC.setDefaultExternalApp, async (_e, id: string, ext: string) => {
    store.setDefaultExternalApp(id, ext);
  });

  ipcMain.handle(
    IPC.openWithExternalApp,
    async (
      _e,
      libraryId: string,
      fileId: number,
      appId: string | null,
      profileId: string | null = null
    ) => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return;
      const file = lib.files.getById(fileId);
      if (!file) return;
      const absPath = lib.resolver.toAbsolute(file.relPath);
      if (!existsSync(absPath)) return;
      if (appId === null) {
        await shell.openPath(absPath);
        return;
      }
      const app = store.findExternalApp(appId);
      if (!app) return;
      const profile = profileId
        ? app.profiles?.find((p) => p.id === profileId) ?? null
        : null;
      const args = buildArgv(app.argsTemplate, absPath, profile?.path ?? '');
      if (platform() === 'darwin' && app.path.endsWith('.app')) {
        // `open -a Bundle.app file --args ...` is how you pass through to the
        // bundled executable. When we have a template we use --args; otherwise
        // the original simpler form.
        const baseArgs = ['-a', app.path];
        if (args.length === 1 && args[0] === absPath) {
          spawn('open', [...baseArgs, absPath], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn(
            'open',
            [...baseArgs, '--args', ...args],
            { detached: true, stdio: 'ignore' }
          ).unref();
        }
      } else {
        spawn(app.path, args, { detached: true, stdio: 'ignore' }).unref();
      }
    }
  );

  ipcMain.handle(IPC.getPreferences, async (): Promise<PreferencesFile> => store.getAll());

  ipcMain.handle(IPC.setPreferences, async (_e, prefs: PreferencesFile) => {
    if (prefs && prefs.version === 1) {
      store.saveAll(prefs);
      // Apply the saved level immediately so renderer-driven changes don't
      // require a restart to take effect on main-side logs.
      setLogLevel(prefs.logLevel ?? DEFAULT_LOG_LEVEL);
    }
  });

  ipcMain.handle(IPC.openLogsFolder, async (): Promise<void> => {
    await openLogsFolder();
  });

  ipcMain.handle(IPC.openTrash, async (): Promise<void> => {
    // No Electron API exists for "show OS trash". Open the per-platform
    // default location; Windows has no stable user-facing path so we fall
    // back to the shell:RecycleBinFolder URI via explorer.
    const p = platform();
    try {
      if (p === 'darwin') {
        await shell.openPath(join(homedir(), '.Trash'));
      } else if (p === 'win32') {
        spawn('explorer.exe', ['shell:RecycleBinFolder'], { detached: true, stdio: 'ignore' }).unref();
      } else {
        // Most XDG environments use ~/.local/share/Trash/files
        await shell.openPath(join(homedir(), '.local/share/Trash/files'));
      }
    } catch (err) {
      log.warn('openTrash failed', { err: (err as Error).message });
    }
  });

  ipcMain.handle(IPC.undo, async () => runUndo());

  ipcMain.handle(IPC.rebuildThumbCache, async (_e, libraryId: string) => {
    const lib = getOpenLibrary(libraryId);
    if (!lib) return;
    rebuildThumbnailCache(lib);
  });

  ipcMain.handle(
    IPC.purgeOrphanThumbs,
    async (_e, libraryId: string): Promise<{ removed: number }> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return { removed: 0 };
      return purgeOrphanThumbs(lib);
    }
  );

  ipcMain.handle(IPC.revealFile, async (_e, libraryId: string, fileId: number) => {
    const lib = getOpenLibrary(libraryId);
    if (!lib) return;
    const file = lib.files.getById(fileId);
    if (!file) return;
    const absPath = lib.resolver.toAbsolute(file.relPath);
    if (!existsSync(absPath)) return;
    shell.showItemInFolder(absPath);
  });
}
