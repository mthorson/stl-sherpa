/**
 * Application menu. Uses platform roles for the standard items and adds:
 *   - Edit → Undo wired to the in-memory undo queue (move/rename only;
 *     deletes get their own "Show in Trash" toast).
 *   - Help → Open Logs Folder for support diagnostics.
 *
 * Rebuilt on undo-queue mutations so the Undo item's label and enabled
 * state stay current.
 */
import { Menu, type MenuItemConstructorOptions, app, shell } from 'electron';
import { getLogsDir } from './logger';
import { undoQueue } from './undo/queue';
import { runUndo } from './undo/runner';

function buildEditSubmenu(): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin';
  const top = undoQueue.peek();
  const undoItem: MenuItemConstructorOptions = {
    label: top ? `Undo ${top.label}` : 'Undo',
    accelerator: 'CmdOrCtrl+Z',
    enabled: top !== null,
    click: () => {
      // Fire-and-forget: errors get toasted by runUndo via a library event.
      void runUndo();
    }
  };
  // Reuse stock role-based items for the rest so platform behaviors (selection,
  // emoji & symbols submenu on macOS, etc.) are preserved.
  return [
    undoItem,
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    ...(isMac
      ? ([
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          {
            label: 'Speech',
            submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }]
          }
        ] as MenuItemConstructorOptions[])
      : ([
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' }
        ] as MenuItemConstructorOptions[]))
  ];
}

export function buildMenu(): Menu {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ role: 'appMenu' as const }]
      : []),
    { role: 'fileMenu' },
    { label: 'Edit', submenu: buildEditSubmenu() },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Open Logs Folder',
          click: () => {
            void shell.openPath(getLogsDir());
          }
        },
        ...(isMac
          ? []
          : [
              { type: 'separator' as const },
              {
                label: `About ${app.getName()}`,
                click: () => app.showAboutPanel()
              }
            ])
      ]
    }
  ];

  return Menu.buildFromTemplate(template);
}

/** Replace the current application menu in-place. Safe to call repeatedly. */
export function rebuildMenu(): void {
  Menu.setApplicationMenu(buildMenu());
}

let undoSubscribed = false;

/**
 * Subscribe the menu to undo-queue changes so the Undo label updates when
 * the user does new ops or runs Undo itself. Call once after the first
 * setApplicationMenu, from app startup.
 */
export function subscribeMenuToUndoQueue(): void {
  if (undoSubscribed) return;
  undoSubscribed = true;
  undoQueue.subscribe(() => {
    rebuildMenu();
  });
}
