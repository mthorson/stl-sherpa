import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { extract3MFEmbeddedThumbnail } from './three-mf-fast-path';
import { inspectThreeMF } from './three-mf-multipart';
import { MAX_EMBEDDED_THUMB_BYTES } from './zip-safety';

// A generated fixture makes these checks run on every checkout and CI runner.
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const arrayBuffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

describe('3MF embedded previews', () => {
  it('extracts exactly the embedded PNG bytes', () => {
    const zip = zipSync({ 'Metadata/thumbnail.png': png, '3D/3dmodel.model': new TextEncoder().encode('<model/>') });
    expect(extract3MFEmbeddedThumbnail(arrayBuffer(zip))).toEqual(png);
  });

  it('returns null for a buffer that is not a zip', () => {
    expect(extract3MFEmbeddedThumbnail(new Uint8Array([1, 2, 3, 4, 5]).buffer)).toBeNull();
  });

  it('does not decompress oversized embedded images', () => {
    const zip = zipSync({ 'Metadata/thumbnail.png': new Uint8Array(MAX_EMBEDDED_THUMB_BYTES + 1) });
    expect(extract3MFEmbeddedThumbnail(arrayBuffer(zip))).toBeNull();
  });

  it('uses the embedded image when a multipart model exceeds the live-preview budget', () => {
    const zip = zipSync({
      '_rels/.rels': new TextEncoder().encode('<Relationships><Relationship Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
      '3D/3dmodel.model': new TextEncoder().encode('<model><component p:path="/3D/Objects/part.model" objectid="2"/></model>'),
      '3D/Objects/part.model': new Uint8Array(31 * 1024 * 1024),
      'Metadata/thumbnail.png': png
    });
    expect(inspectThreeMF(arrayBuffer(zip))).toEqual({ kind: 'too-large', embeddedPng: png });
  });
});
