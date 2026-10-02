import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { collectModelFiles } from './model-files';
import { writeZip } from './write-zip';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup(uri = '../textures/a%20b.png') {
  const root = await mkdtemp(join(tmpdir(), 'meshflask-export-'));
  roots.push(root);
  await mkdir(join(root, 'models'));
  await mkdir(join(root, 'textures'));
  await writeFile(join(root, 'models', 'mesh.bin'), 'mesh bytes');
  await writeFile(join(root, 'textures', 'a b.png'), 'texture bytes');
  const json = { asset: { version: '2.0' }, buffers: [{ uri: 'mesh.bin' }], images: [{ uri }, { uri: 'data:image/png;base64,AA==' }] };
  await writeFile(join(root, 'models', 'a.gltf'), JSON.stringify(json));
  return { root, json, models: [{ relPath: 'models/a.gltf', ext: 'gltf' }] };
}

describe('portable model exports', () => {
  it('preserves parent-relative and encoded resource paths, deduplicating shared assets', async () => {
    const { root, json, models } = await setup();
    await writeFile(join(root, 'models', 'b.gltf'), JSON.stringify(json));
    const files = await collectModelFiles(root, [...models, { relPath: 'models/b.gltf', ext: 'gltf' }]);
    expect(files.map((file) => file.relPath).sort()).toEqual(['models/a.gltf', 'models/b.gltf', 'models/mesh.bin', 'textures/a b.png']);
    const destination = join(root, 'collection.zip');
    await writeZip(destination, files);
    const extracted = unzipSync(await readFile(destination));
    expect(Object.keys(extracted).sort()).toEqual(files.map((file) => file.relPath).sort());
    expect(new TextDecoder().decode(extracted['models/mesh.bin'])).toBe('mesh bytes');
  });

  it('includes external textures referenced by a GLB JSON chunk', async () => {
    const { root, json } = await setup();
    const text = JSON.stringify(json);
    const chunk = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, ' '));
    const bytes = Buffer.alloc(20 + chunk.length);
    bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
    bytes.writeUInt32LE(chunk.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); chunk.copy(bytes, 20);
    await writeFile(join(root, 'models', 'a.glb'), bytes);
    expect((await collectModelFiles(root, [{ relPath: 'models/a.glb', ext: 'glb' }])).map((file) => file.relPath))
      .toEqual(['models/a.glb', 'models/mesh.bin', 'textures/a b.png']);
  });

  it.each(['../../outside.png', 'https://example.com/remote.png', 'file:///etc/passwd', 'blob:missing', 'missing.png'])('fails the entire export for %s', async (uri) => {
    const { root, models } = await setup(uri);
    await expect(collectModelFiles(root, models)).rejects.toThrow('Cannot export models/a.gltf');
  });

  it('rejects a resource symlink outside the library', async () => {
    const { root, models } = await setup('link.png');
    const outside = await setup();
    await symlink(join(outside.root, 'textures', 'a b.png'), join(root, 'models', 'link.png'));
    await expect(collectModelFiles(root, models)).rejects.toThrow('outside');
  });

  it('retains an existing export and removes temporary files if an input disappears', async () => {
    const { root, models } = await setup();
    const files = await collectModelFiles(root, models);
    await rm(join(root, 'models', 'mesh.bin'));
    const destination = join(root, 'collection.zip');
    await writeFile(destination, 'previous export');
    await expect(writeZip(destination, files)).rejects.toThrow();
    expect(await readFile(destination, 'utf8')).toBe('previous export');
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
