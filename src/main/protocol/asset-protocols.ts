import { app, net, protocol } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getOpenLibrary } from '@main/libraries/manager';
import { thumbAbsPath } from '@main/thumb-pool/storage';
import { scopedLogger } from '@main/logger';

const log = scopedLogger('protocol');

export const SCHEME_THUMB = 'wh3d-thumb';
export const SCHEME_FILE = 'wh3d-file';

/**
 * Must be called BEFORE app.whenReady so the schemes are recognised by the
 * renderer's CSP and registered as standard URL schemes.
 */
export function registerAssetSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME_THUMB,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    },
    {
      scheme: SCHEME_FILE,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false
      }
    }
  ]);
}

interface ParsedAssetURL {
  libraryId: string;
  fileId: number;
}

/**
 * URL shape: wh3d-thumb://<libraryId>/<fileId>
 *            wh3d-file://<libraryId>/<fileId>
 * Hosts and paths can both contain numbers; we treat the host as libraryId
 * and the first non-empty path segment as the integer fileId.
 */
function parse(url: string): ParsedAssetURL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const libraryId = parsed.hostname;
  if (!libraryId) return null;
  const seg = parsed.pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  const fileId = Number.parseInt(seg, 10);
  if (!Number.isFinite(fileId) || fileId <= 0) return null;
  return { libraryId, fileId };
}

function notFound(message: string): Response {
  return new Response(message, { status: 404, headers: { 'content-type': 'text/plain' } });
}

function badRequest(message: string): Response {
  return new Response(message, { status: 400, headers: { 'content-type': 'text/plain' } });
}

export function registerAssetProtocols(): void {
  protocol.handle(SCHEME_THUMB, async (req) => {
    const parsed = parse(req.url);
    if (!parsed) {
      log.warn('invalid wh3d-thumb url', { url: req.url });
      return badRequest('Invalid wh3d-thumb URL');
    }
    const lib = getOpenLibrary(parsed.libraryId);
    if (!lib) return notFound(`Library ${parsed.libraryId} not open`);
    const abs = thumbAbsPath(lib.entry.mountPath, parsed.fileId);
    if (!existsSync(abs)) return notFound('Thumbnail not yet rendered');
    return net.fetch(pathToFileURL(abs).toString());
  });

  protocol.handle(SCHEME_FILE, async (req) => {
    const parsed = parse(req.url);
    if (!parsed) {
      log.warn('invalid wh3d-file url', { url: req.url });
      return badRequest('Invalid wh3d-file URL');
    }
    const lib = getOpenLibrary(parsed.libraryId);
    if (!lib) return notFound(`Library ${parsed.libraryId} not open`);
    const file = lib.files.getById(parsed.fileId);
    if (!file) return notFound('File not in library');
    const abs = lib.resolver.toAbsolute(file.relPath);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      log.warn('file missing on disk for wh3d-file', { libraryId: parsed.libraryId, fileId: parsed.fileId, abs });
      return notFound('File missing on disk');
    }
    return net.fetch(pathToFileURL(abs).toString());
  });

  // Sanity: registering the protocol must happen after app is ready.
  if (!app.isReady()) {
    throw new Error('registerAssetProtocols must be called inside app.whenReady()');
  }
}
