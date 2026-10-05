import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveModelResource } from './model-resource';

describe('model sidecar containment', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'stl-sherpa-resource-'));
    roots.push(root);
    mkdirSync(join(root, 'models'));
    mkdirSync(join(root, 'textures'));
    writeFileSync(join(root, 'models', 'mesh.bin'), 'mesh');
    writeFileSync(join(root, 'textures', 'a # b.png'), 'image');
    return root;
  }
  it('loads siblings and encoded parent-relative textures inside the library', async () => {
    const root = setup();
    expect(await resolveModelResource(root, 'models/a.gltf', 'mesh.bin')).toBe(join(root, 'models', 'mesh.bin'));
    expect(await resolveModelResource(root, 'models/a.gltf', '../textures/a%20%23%20b.png')).toBe(join(root, 'textures', 'a # b.png'));
  });
  it.each(['../../outside.bin', '%2e%2e/%2e%2e/outside.bin', '/etc/passwd', '%2Fetc/passwd', 'file:///etc/passwd', 'https://example.com/a.bin', '..%5c..%5csecret', '%00.bin'])('rejects %s', async (uri) => {
    await expect(resolveModelResource(setup(), 'models/a.gltf', uri)).rejects.toThrow();
  });
  it('rejects a sidecar symlink to another directory', async () => {
    const root = setup();
    const outside = setup();
    symlinkSync(join(outside, 'models', 'mesh.bin'), join(root, 'models', 'linked.bin'));
    await expect(resolveModelResource(root, 'models/a.gltf', 'linked.bin')).rejects.toThrow('outside');
  });
});
