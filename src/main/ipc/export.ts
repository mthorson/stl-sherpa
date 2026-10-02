import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IPC } from '@shared/ipc-channels';
import type { ExportResult } from '@shared/types';
import { getOpenLibrary } from '@main/libraries/manager';
import { collectModelFiles } from '@main/files/model-files';
import { writeZip } from '@main/files/write-zip';
import { scopedLogger } from '@main/logger';

const log = scopedLogger('export');

export function registerExportIpc(): void {
  ipcMain.handle(
    IPC.exportCollectionZip,
    async (event, libraryId: string, collectionId: number): Promise<ExportResult> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return { ok: false, error: `Library ${libraryId} not open` };
      const col = lib.collections.getById(collectionId);
      if (!col) return { ok: false, error: 'Collection not found' };

      const files = lib.collectionQuery.queryAll({ collectionId });
      if (files.length === 0) return { ok: false, error: 'Collection is empty' };

      let exportFiles;
      try {
        exportFiles = await collectModelFiles(lib.entry.mountPath, files);
      } catch (error) {
        log.warn('export dependency check failed', { libraryId, error: (error as Error).message });
        return { ok: false, error: (error as Error).message };
      }

      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      const saveOpts = {
        title: 'Export collection as ZIP',
        defaultPath: `${col.name}.zip`,
        filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
      };
      const result = senderWindow
        ? await dialog.showSaveDialog(senderWindow, saveOpts)
        : await dialog.showSaveDialog(saveOpts);
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      const destPath = result.filePath;
      log.debug('export started', { libraryId, destPath });

      try {
        await writeZip(destPath, exportFiles);
      } catch (err) {
        log.error('export failed', { libraryId, destPath, error: (err as Error).message });
        return { ok: false, error: (err as Error).message };
      }
      log.debug('ZIP export completed', { libraryId, destPath, models: files.length, count: exportFiles.length });
      return { ok: true, canceled: false, path: destPath, fileCount: exportFiles.length };
    }
  );

  ipcMain.handle(
    IPC.exportContactSheet,
    async (event, libraryId: string, selection: number[] | { collectionId: number }): Promise<ExportResult> => {
      const lib = getOpenLibrary(libraryId);
      if (!lib) return { ok: false, error: `Library ${libraryId} not open` };
      const fileIds = Array.isArray(selection)
        ? selection
        : lib.collectionQuery.queryAll({ collectionId: selection.collectionId }).map((file) => file.id);
      if (fileIds.length === 0) return { ok: false, error: 'No files selected' };

      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      const saveOpts = {
        title: 'Export contact sheet as PDF',
        defaultPath: `contact-sheet.pdf`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      };
      const result = senderWindow
        ? await dialog.showSaveDialog(senderWindow, saveOpts)
        : await dialog.showSaveDialog(saveOpts);
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      const destPath = result.filePath;
      log.debug('export started', { libraryId, destPath });

      // Build a self-contained print-styled HTML grid of thumbs. The thumb
      // protocol (wh3d-thumb://) is registered as privileged so a hidden
      // BrowserWindow can resolve those URLs without our involvement.
      const html = buildContactSheetHtml(
        libraryId,
        fileIds.map((id) => {
          const f = lib.files.getById(id);
          return f ? { id, name: f.filename } : null;
        }).filter((x): x is { id: number; name: string } => x !== null)
      );

      const win = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, sandbox: true }
      });
      // Load from a temp file rather than a data: URL — Chromium caps URL
      // length around 2MB, which a sheet of a few thousand files exceeds.
      const htmlPath = join(app.getPath('temp'), `meshflask-contact-sheet-${Date.now()}.html`);
      try {
        await writeFile(htmlPath, html, 'utf8');
        await win.loadFile(htmlPath);
        // printToPDF doesn't await image loads, so wait until every thumbnail
        // has decoded. Capped so a missing thumb can't hang the export.
        await Promise.race([
          win.webContents.executeJavaScript(
            'Promise.allSettled([...document.images].map((img) => img.decode()))',
            true
          ),
          new Promise((r) => setTimeout(r, 10_000))
        ]);
        const pdf = await win.webContents.printToPDF({
          printBackground: true,
          pageSize: 'Letter',
          margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
        });
        await writeFile(destPath, pdf);
      } catch (err) {
        log.error('export failed', { libraryId, destPath, error: (err as Error).message });
        return { ok: false, error: (err as Error).message };
      } finally {
        win.destroy();
        await rm(htmlPath, { force: true });
      }
      log.debug('PDF export completed', { libraryId, destPath, count: fileIds.length });
      return { ok: true, canceled: false, path: destPath, fileCount: fileIds.length };
    }
  );
}

function buildContactSheetHtml(
  libraryId: string,
  items: Array<{ id: number; name: string }>
): string {
  const cells = items
    .map(
      (it) => `
      <div class="cell">
        <img src="wh3d-thumb://${libraryId}/${it.id}?v=0" alt="${escapeHtml(it.name)}" />
        <div class="caption">${escapeHtml(it.name)}</div>
      </div>`
    )
    .join('');
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: Letter; margin: 0.5in; }
      body { margin: 0; font-family: -apple-system, system-ui, sans-serif; color: #111; }
      .grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 12px;
      }
      .cell {
        display: flex;
        flex-direction: column;
        align-items: center;
        page-break-inside: avoid;
      }
      .cell img {
        width: 100%;
        aspect-ratio: 1 / 1;
        object-fit: cover;
        background: #f4f4f4;
        border: 1px solid #ddd;
      }
      .caption {
        margin-top: 4px;
        font-size: 9pt;
        word-break: break-all;
        text-align: center;
      }
      h1 {
        font-size: 12pt;
        margin: 0 0 12px;
      }
    </style>
  </head>
  <body>
    <h1>meshFlask contact sheet (${items.length} file${items.length === 1 ? '' : 's'})</h1>
    <div class="grid">${cells}</div>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}
