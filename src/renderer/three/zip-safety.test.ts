import { describe, expect, it } from 'vitest';
import {
  MAX_TOTAL_DECOMPRESSED_BYTES,
  MAX_ZIP_ENTRIES,
  assertSafeArchive,
  isSafeArchiveEntryName
} from './zip-safety';

describe('isSafeArchiveEntryName', () => {
  it('accepts normal slicer-thumbnail names', () => {
    expect(isSafeArchiveEntryName('Metadata/thumbnail.png')).toBe(true);
    expect(isSafeArchiveEntryName('3D/3dmodel.model')).toBe(true);
    expect(isSafeArchiveEntryName('_rels/.rels')).toBe(true);
  });

  it('rejects names with traversal segments', () => {
    expect(isSafeArchiveEntryName('../etc/passwd')).toBe(false);
    expect(isSafeArchiveEntryName('foo/../bar')).toBe(false);
    expect(isSafeArchiveEntryName('foo\\..\\bar')).toBe(false);
  });

  it('rejects absolute names', () => {
    expect(isSafeArchiveEntryName('/etc/passwd')).toBe(false);
    expect(isSafeArchiveEntryName('\\Windows\\System32')).toBe(false);
    expect(isSafeArchiveEntryName('C:/Windows/foo')).toBe(false);
    expect(isSafeArchiveEntryName('C:\\Windows\\foo')).toBe(false);
  });

  it('rejects NUL bytes', () => {
    expect(isSafeArchiveEntryName('Metadata/thumb\0.png')).toBe(false);
  });

  it('allows names that contain .. as substring but not as a segment', () => {
    expect(isSafeArchiveEntryName('Metadata/foo..bar.png')).toBe(true);
    expect(isSafeArchiveEntryName('..hidden/file.txt')).toBe(true);
  });
});

describe('assertSafeArchive', () => {
  it('passes a small, well-formed archive listing', () => {
    const sizes = new Map<string, number>([
      ['_rels/.rels', 200],
      ['3D/3dmodel.model', 50_000],
      ['Metadata/thumbnail.png', 12_000]
    ]);
    expect(() => assertSafeArchive(sizes)).not.toThrow();
  });

  it('throws when entry count exceeds the limit', () => {
    const sizes = new Map<string, number>();
    for (let i = 0; i <= MAX_ZIP_ENTRIES; i++) sizes.set(`f${i}.bin`, 0);
    expect(() => assertSafeArchive(sizes)).toThrow(/too many entries/);
  });

  it('throws when total decompressed size exceeds the cap (zip-bomb)', () => {
    const sizes = new Map<string, number>([
      ['a.bin', MAX_TOTAL_DECOMPRESSED_BYTES],
      ['b.bin', 1]
    ]);
    expect(() => assertSafeArchive(sizes)).toThrow(/total decompressed size/);
  });

  it('throws on a single declared-huge entry (zip-bomb)', () => {
    const sizes = new Map<string, number>([
      ['huge.bin', Number.MAX_SAFE_INTEGER]
    ]);
    expect(() => assertSafeArchive(sizes)).toThrow(/total decompressed size/);
  });

  it('throws on an unsafe entry name', () => {
    const sizes = new Map<string, number>([['../../etc/passwd', 10]]);
    expect(() => assertSafeArchive(sizes)).toThrow(/unsafe entry name/);
  });
});
