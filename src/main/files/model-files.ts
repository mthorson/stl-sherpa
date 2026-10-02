import { open, stat } from 'node:fs/promises';
import { PathResolver } from '@shared/paths';
import { gltfResourceUris } from '@shared/gltf-resources';
import { assertExistingPathInsideLibrary } from './path-safety';
import { resolveModelResource } from '@main/protocol/model-resource';

export interface ExportFile { abs: string; relPath: string }
const MAX_GLTF_JSON_BYTES = 64 * 1024 * 1024;

/** Read only the GLB JSON chunk; binary mesh buffers may be many gigabytes. */
async function readUris(abs: string, ext: string): Promise<string[]> {
  if (ext !== 'gltf' && ext !== 'glb') return [];
  const handle = await open(abs, 'r');
  try {
    const { size } = await handle.stat();
    let length = size;
    if (ext === 'glb') {
      const header = Buffer.alloc(20);
      const { bytesRead } = await handle.read(header, 0, 20, 0);
      if (bytesRead !== 20 || header.readUInt32LE(0) !== 0x46546c67 || header.readUInt32LE(4) !== 2 ||
          header.readUInt32LE(8) !== size || header.readUInt32LE(16) !== 0x4e4f534a) {
        throw new Error('Invalid GLB header');
      }
      length = 20 + header.readUInt32LE(12);
    }
    if (length > size || length > MAX_GLTF_JSON_BYTES) throw new Error('glTF JSON is truncated or exceeds 64 MB');
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(bytes, offset, length - offset, offset);
      if (bytesRead === 0) throw new Error('Model changed during export');
      offset += bytesRead;
    }
    return gltfResourceUris(bytes, ext);
  } finally {
    await handle.close();
  }
}

/** Keep library-relative paths so references still resolve after extraction. */
export async function collectModelFiles(
  root: string,
  models: Array<{ relPath: string; ext: string }>
): Promise<ExportFile[]> {
  const resolver = new PathResolver(root);
  const entries = new Map<string, ExportFile>();
  const add = async (abs: string) => {
    await assertExistingPathInsideLibrary(root, abs);
    if (!(await stat(abs)).isFile()) throw new Error(`Not a regular file: ${abs}`);
    const relPath = resolver.toRelative(abs);
    entries.set(relPath, { abs, relPath });
  };
  for (const model of models) {
    try {
      const abs = resolver.toAbsolute(model.relPath);
      await add(abs);
      for (const uri of await readUris(abs, model.ext)) {
        await add(await resolveModelResource(root, model.relPath, uri));
      }
    } catch (error) {
      throw new Error(`Cannot export ${model.relPath}: ${(error as Error).message}`);
    }
  }
  return [...entries.values()];
}
