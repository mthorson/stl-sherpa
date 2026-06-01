import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Stream a file's raw bytes through SHA-256 and return the lowercase hex
 * digest. Streaming (rather than reading the whole file into memory) keeps
 * peak memory bounded for the large STL/3MF meshes this app indexes.
 *
 * Resolves to `null` instead of throwing when the file can't be read
 * (permissions, disappeared mid-scan, etc.) so a single bad file never aborts
 * a whole scan — the row simply stays un-hashed and is skipped by the
 * duplicate grouping.
 */
export function hashFileContent(absPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absPath);
    stream.on('error', () => {
      stream.destroy();
      resolve(null);
    });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
