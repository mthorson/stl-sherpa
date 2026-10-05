// Small, generated fixtures: no downloaded models or private user libraries.
const fs = require('node:fs');
const path = require('node:path');
const { zipSync, unzipSync, strToU8 } = require('fflate');

function binaryStl(scale = 10) {
  const vertices = [[0, 0, 0], [scale, 0, 0], [0, scale, 0], [0, 0, scale]];
  const faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
  const bytes = Buffer.alloc(84 + faces.length * 50);
  bytes.write('stl-sherpa smoke tetrahedron');
  bytes.writeUInt32LE(faces.length, 80);
  faces.forEach((face, i) => {
    const [a, b, c] = face.map((id) => vertices[id]);
    const u = b.map((v, j) => v - a[j]);
    const v = c.map((value, j) => value - a[j]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...normal);
    [...normal.map((n) => n / length), ...a, ...b, ...c].forEach((value, j) => bytes.writeFloatLE(value, 84 + i * 50 + j * 4));
  });
  return bytes;
}

function threeMf(png) {
  const parts = {
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8('<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>')
  };
  if (png) parts['Metadata/thumbnail.png'] = png;
  return zipSync(parts);
}

function writeSamples(root, png) {
  fs.mkdirSync(root, { recursive: true });
  const write = (name, bytes) => fs.writeFileSync(path.join(root, name), bytes);
  write('tetra.stl', binaryStl());
  write('other.stl', binaryStl(15));
  write('ascii.stl', 'solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid triangle\n');
  write('triangle.obj', 'v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n');
  write('triangle.ply', 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n10 0 0\n0 10 0\n3 0 1 2\n');
  write('tetra.3mf', threeMf());
  write('embedded.3mf', threeMf(png));
  const bin = Buffer.from(new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 1, 0, 0, 1]).buffer);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    buffers: [{ uri: 'triangle.bin', byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [10, 10, 0] }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }],
    images: [{ uri: 'checker%20texture.png' }], textures: [{ source: 0 }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } }]
  };
  write('triangle.bin', bin);
  write('checker texture.png', png);
  write('external.gltf', JSON.stringify(gltf));
  const embedded = structuredClone(gltf);
  delete embedded.buffers[0].uri;
  embedded.images[0].uri = `data:image/png;base64,${png.toString('base64')}`;
  const json = Buffer.from(JSON.stringify(embedded));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const glb = Buffer.alloc(12 + 8 + padded.length + 8 + bin.length);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); padded.copy(glb, 20);
  glb.writeUInt32LE(bin.length, 20 + padded.length); glb.writeUInt32LE(0x004e4942, 24 + padded.length); bin.copy(glb, 28 + padded.length);
  write('embedded.glb', glb);
  const corrupt = Buffer.alloc(84);
  corrupt.writeUInt32LE(0xffffffff, 80);
  write('corrupt.stl', corrupt);
  fs.mkdirSync(path.join(root, 'guard'));
  write('guard/protected.stl', binaryStl(3));
}

function largeStl(count) {
  const bytes = Buffer.alloc(84 + count * 50);
  bytes.write('Generated stl-sherpa stress sample');
  bytes.writeUInt32LE(count, 80);
  const tetra = binaryStl(1);
  for (let i = 0; i < count; i++) {
    const offset = 84 + i * 50;
    tetra.copy(bytes, offset, 84 + (i % 4) * 50, 84 + (i % 4 + 1) * 50);
    const cell = Math.floor(i / 4);
    for (const j of [12, 24, 36]) {
      bytes.writeFloatLE(bytes.readFloatLE(offset + j) + (cell % 100) * 2, offset + j);
      bytes.writeFloatLE(bytes.readFloatLE(offset + j + 4) + Math.floor(cell / 100) * 2, offset + j + 4);
    }
  }
  return bytes;
}

function multipart3mf(png, oversized = false) {
  const parts = unzipSync(threeMf());
  const mesh = new TextDecoder().decode(parts['3D/3dmodel.model']).replace('id="1"', 'id="2"').replace('objectid="1"', 'objectid="2"');
  parts['3D/3dmodel.model'] = strToU8('<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources><object id="1" type="model"><components><component p:path="/3D/Objects/part.model" objectid="2"/></components></object></resources><build><item objectid="1"/></build></model>');
  // A large valid XML comment exercises the declared-size fallback without a downloaded fixture.
  parts['3D/Objects/part.model'] = strToU8(mesh + (oversized ? '<!--' + 'x'.repeat(31 * 1024 * 1024) + '-->' : ''));
  if (png) parts['Metadata/thumbnail.png'] = png;
  return zipSync(parts);
}

module.exports = { binaryStl, threeMf, writeSamples, largeStl, multipart3mf };
