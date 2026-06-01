import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { extract3mfMetadata, extractFormatMetadata, extractStlMetadata } from './format-metadata';

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function binaryStl(header: string, triangleCount = 0): ArrayBuffer {
  const buf = new Uint8Array(84 + triangleCount * 50);
  const headerBytes = strToU8(header);
  buf.set(headerBytes.subarray(0, 80), 0);
  new DataView(buf.buffer).setUint32(80, triangleCount, true);
  return toArrayBuffer(buf);
}

function asciiStl(name: string): ArrayBuffer {
  const text = `solid ${name}\n  facet normal 0 0 1\n    outer loop\n      vertex 0 0 0\n      vertex 1 0 0\n      vertex 0 1 0\n    endloop\n  endfacet\nendsolid ${name}\n`;
  return toArrayBuffer(strToU8(text));
}

function threeMf(metadataXml: string, modelPart = '3D/3dmodel.model'): ArrayBuffer {
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
${metadataXml}
<resources/>
<build/>
</model>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/${modelPart}" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
  const zipped = zipSync({
    '_rels/.rels': strToU8(rels),
    [modelPart]: strToU8(model)
  });
  return toArrayBuffer(zipped);
}

describe('extractStlMetadata', () => {
  it('reads a binary STL 80-byte header banner', () => {
    const out = extractStlMetadata(binaryStl('Exported by MeshFlask Test'));
    expect(out).toEqual({ stlHeader: 'Exported by MeshFlask Test' });
  });

  it('strips zero padding and control bytes from a binary header', () => {
    const out = extractStlMetadata(binaryStl('Banner'));
    expect(out?.stlHeader).toBe('Banner');
  });

  it('returns null for a blank binary header', () => {
    expect(extractStlMetadata(binaryStl(''))).toBeNull();
  });

  it('reads the solid name from an ASCII STL', () => {
    const out = extractStlMetadata(asciiStl('WidgetBracket'));
    expect(out?.solidName).toBe('WidgetBracket');
    expect(out?.stlHeader).toBe('solid WidgetBracket');
  });

  it('returns null for too-short input', () => {
    expect(extractStlMetadata(new Uint8Array([1, 2]).buffer)).toBeNull();
  });
});

describe('extract3mfMetadata', () => {
  it('parses Title, Designer, License, Copyright, Application', () => {
    const xml = [
      '<metadata name="Title">Dragon Miniature</metadata>',
      '<metadata name="Designer">Jane Maker</metadata>',
      '<metadata name="LicenseTerms">CC BY-NC 4.0</metadata>',
      '<metadata name="Copyright">2025 Jane Maker</metadata>',
      '<metadata name="Application">MeshFlask 1.0</metadata>'
    ].join('\n');
    const out = extract3mfMetadata(threeMf(xml));
    expect(out).toEqual({
      title: 'Dragon Miniature',
      author: 'Jane Maker',
      license: 'CC BY-NC 4.0',
      copyright: '2025 Jane Maker',
      application: 'MeshFlask 1.0'
    });
  });

  it('decodes XML entities in values', () => {
    const out = extract3mfMetadata(threeMf('<metadata name="Title">A &amp; B &lt;v2&gt;</metadata>'));
    expect(out?.title).toBe('A & B <v2>');
  });

  it('falls back to Author and License aliases', () => {
    const xml = [
      '<metadata name="Author">Bob</metadata>',
      '<metadata name="License">MIT</metadata>'
    ].join('\n');
    const out = extract3mfMetadata(threeMf(xml));
    expect(out?.author).toBe('Bob');
    expect(out?.license).toBe('MIT');
  });

  it('follows a renamed model part via _rels/.rels', () => {
    const out = extract3mfMetadata(
      threeMf('<metadata name="Title">Renamed</metadata>', '3D/custom.model')
    );
    expect(out?.title).toBe('Renamed');
  });

  it('returns null when there is no metadata', () => {
    expect(extract3mfMetadata(threeMf(''))).toBeNull();
  });

  it('returns null for a non-zip buffer', () => {
    expect(extract3mfMetadata(new Uint8Array([1, 2, 3, 4, 5]).buffer)).toBeNull();
  });
});

describe('extractFormatMetadata dispatch', () => {
  it('routes by extension and ignores unsupported formats', () => {
    expect(extractFormatMetadata(binaryStl('Hi'), 'stl')).toEqual({ stlHeader: 'Hi' });
    expect(extractFormatMetadata(threeMf('<metadata name="Title">T</metadata>'), '3mf')).toEqual({
      title: 'T'
    });
    expect(extractFormatMetadata(binaryStl('Hi'), 'obj')).toBeNull();
  });
});
