import { posix } from 'node:path';
import { PathResolver, isAbsolute } from '@shared/paths';
import { assertExistingPathInsideLibrary } from '@main/files/path-safety';

/** Resolve a URI relative to a model, permitting parent folders only inside its library. */
export async function resolveModelResource(root: string, modelRelPath: string, uri: string): Promise<string> {
  if (/^[a-z][a-z\d+.-]*:/i.test(uri) || /^[\\/]/.test(uri)) {
    throw new Error('Only relative model resources are supported');
  }
  const decoded = decodeURIComponent(uri.split(/[?#]/, 1)[0]);
  if (isAbsolute(decoded) || decoded.includes('\\') || decoded.includes('\0')) {
    throw new Error('Invalid model resource path');
  }
  const relPath = posix.normalize(posix.join(posix.dirname(modelRelPath), decoded));
  const abs = new PathResolver(root).toAbsolute(relPath);
  await assertExistingPathInsideLibrary(root, abs);
  return abs;
}
