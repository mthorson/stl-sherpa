import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function nearestExistingAncestor(absPath: string): Promise<string> {
  let current = absPath;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}

/** Require an existing path to resolve inside the canonical library root. */
export async function assertExistingPathInsideLibrary(
  libraryRoot: string,
  absPath: string
): Promise<void> {
  const [root, candidate] = await Promise.all([realpath(libraryRoot), realpath(absPath)]);
  if (!isInside(root, candidate)) {
    throw new Error(`Path resolves outside the library: ${absPath}`);
  }
}

/** Require the nearest existing destination ancestor to resolve inside the library. */
export async function assertDestinationInsideLibrary(
  libraryRoot: string,
  absPath: string
): Promise<void> {
  const ancestor = await nearestExistingAncestor(dirname(absPath));
  const [root, candidate] = await Promise.all([realpath(libraryRoot), realpath(ancestor)]);
  if (!isInside(root, candidate)) {
    throw new Error(`Destination resolves outside the library: ${absPath}`);
  }
}
