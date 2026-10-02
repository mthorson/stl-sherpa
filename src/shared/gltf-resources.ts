/** External buffers/textures in glTF 2.0, including the JSON chunk of a GLB. */
export function gltfResourceUris(bytes: Uint8Array, ext: string): string[] {
  if (ext !== 'gltf' && ext !== 'glb') return [];
  let json = bytes;
  if (ext === 'glb') {
    if (bytes.byteLength < 20) throw new Error('Truncated GLB header');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(12, true);
    if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 ||
        view.getUint32(16, true) !== 0x4e4f534a || length > bytes.byteLength - 20) {
      throw new Error('Invalid GLB JSON chunk');
    }
    json = bytes.subarray(20, 20 + length);
  }
  const model = JSON.parse(new TextDecoder().decode(json));
  if (!model || typeof model !== 'object') throw new Error('Invalid glTF document');
  const uris = new Set<string>();
  for (const key of ['buffers', 'images']) {
    if (model[key] === undefined) continue;
    if (!Array.isArray(model[key])) throw new Error(`Invalid glTF ${key}`);
    for (const item of model[key]) {
      if (item?.uri === undefined) continue;
      if (typeof item.uri !== 'string' || item.uri.length === 0) throw new Error('Invalid glTF resource URI');
      // Inline data is part of the model. A serialized blob: reference is not portable.
      if (!/^data:/i.test(item.uri)) uris.add(item.uri);
    }
  }
  return [...uris];
}
