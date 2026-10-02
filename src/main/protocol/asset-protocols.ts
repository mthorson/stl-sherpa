import { app, net, protocol } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getOpenLibrary } from '@main/libraries/manager';
import { thumbAbsPath } from '@main/thumb-pool/storage';
import { scopedLogger } from '@main/logger';
import { assertExistingPathInsideLibrary } from '@main/files/path-safety';
import { resolveModelResource } from './model-resource';
import { collectModelFiles } from '@main/files/model-files';

const log = scopedLogger('protocol');

export const SCHEME_THUMB = 'wh3d-thumb';
export const SCHEME_FILE = 'wh3d-file';

/**
 * Must be called BEFORE app.whenReady so the schemes are recognised by the
 * renderer's CSP and registered as standard URL schemes.
 */
export function registerAssetSchemes(): void {
  // corsEnabled + the Access-Control-Allow-Origin headers below: the
  // renderer's fetch() of wh3d-file:// is a cross-origin request (its origin
  // is the dev server or file://), and Electron 34+ actually enforces CORS
  // for custom schemes. Without both, fetch() fails while <img> loads
  // (no-cors) keep working — the preview breaks but thumbnails don't.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME_THUMB,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    },
    {
      scheme: SCHEME_FILE,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
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
  const seg = parsed.pathname.slice(1);
  if (!/^[1-9]\d*$/.test(seg)) return null;
  const fileId = Number(seg);
  if (!Number.isSafeInteger(fileId)) return null;
  return { libraryId, fileId };
}

// Every response carries ACAO so the renderer's cross-origin fetch() passes
// the CORS check. The handlers validate library membership and file identity
// themselves, and no remote content ever runs in this app, so a wildcard is
// safe here.
const CORS_HEADER = { 'access-control-allow-origin': '*' } as const;

function notFound(message: string): Response {
  return new Response(message, {
    status: 404,
    headers: { 'content-type': 'text/plain', ...CORS_HEADER }
  });
}

function badRequest(message: string): Response {
  return new Response(message, {
    status: 400,
    headers: { 'content-type': 'text/plain', ...CORS_HEADER }
  });
}

/** Wrap a net.fetch response with the CORS header, preserving body + status. */
function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, headers });
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
    return withCors(await net.fetch(pathToFileURL(abs).toString()));
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
    let abs: string;
    try {
      const resource = new URL(req.url).searchParams.get('resource');
      log.debug('serving model asset', { libraryId: parsed.libraryId, fileId: parsed.fileId, resource });
      if (resource !== null) {
        if (file.ext !== 'gltf' && file.ext !== 'glb') return badRequest('Not a glTF model');
        abs = await resolveModelResource(lib.entry.mountPath, file.relPath, resource);
      } else {
        abs = lib.resolver.toAbsolute(file.relPath);
        await assertExistingPathInsideLibrary(lib.entry.mountPath, abs);
        // Validate every glTF dependency up front. GLTFLoader otherwise swallows
        // texture failures and can cache an incomplete model as a successful render.
        if (file.ext === 'gltf' || file.ext === 'glb') {
          await collectModelFiles(lib.entry.mountPath, [file]);
        }
      }
      if (!statSync(abs).isFile()) return notFound('File missing on disk');
    } catch (err) {
      log.warn('model asset rejected', { libraryId: parsed.libraryId, fileId: parsed.fileId, error: (err as Error).message });
      return notFound('File missing or outside library');
    }
    return withCors(await net.fetch(pathToFileURL(abs).toString()));
  });

  // Sanity: registering the protocol must happen after app is ready.
  if (!app.isReady()) {
    throw new Error('registerAssetProtocols must be called inside app.whenReady()');
  }
}
