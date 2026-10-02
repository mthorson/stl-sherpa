import { describe, expect, it } from 'vitest';
import { isInvalidFilename, renderTemplate } from './rename-template';

const sample = {
  filename: 'hero_v2.stl',
  ext: 'stl',
  mtimeMs: new Date('2024-03-15T11:09:07Z').getTime()
};

describe('renderTemplate', () => {
  it('passthrough with no tokens', () => {
    expect(renderTemplate(sample, 0, 1, 'fixed.stl')).toBe('fixed.stl');
  });

  it('substitutes {name} and {ext}', () => {
    expect(renderTemplate(sample, 0, 1, '{name}{ext}')).toBe('hero_v2.stl');
  });

  it('handles {original}', () => {
    expect(renderTemplate(sample, 0, 1, '_{original}')).toBe('_hero_v2.stl');
  });

  it('1-based counter', () => {
    expect(renderTemplate(sample, 0, 5, 'f_{counter}{ext}')).toBe('f_1.stl');
    expect(renderTemplate(sample, 4, 5, 'f_{counter}{ext}')).toBe('f_5.stl');
  });

  it('zero-padded counter', () => {
    expect(renderTemplate(sample, 0, 12, '{counter:03}{ext}')).toBe('001.stl');
    expect(renderTemplate(sample, 11, 12, '{counter:03}{ext}')).toBe('012.stl');
  });

  it('date tokens use file mtime', () => {
    expect(renderTemplate(sample, 0, 1, '{date:YYYY-MM-DD}{ext}')).toMatch(/^2024-03-1[45]\.stl$/);
  });

  it('unknown tokens are left verbatim', () => {
    expect(renderTemplate(sample, 0, 1, '{nope}_{name}{ext}')).toBe('{nope}_hero_v2.stl');
  });

  it('handles a name without an extension match', () => {
    const ctx = { filename: 'README', ext: '', mtimeMs: 0 };
    expect(renderTemplate(ctx, 0, 1, '{name}{ext}')).toBe('README');
  });

  it('strips uppercase on-disk extensions ({name} must not double-extension)', () => {
    const ctx = { filename: 'HERO.STL', ext: 'stl', mtimeMs: 0 };
    expect(renderTemplate(ctx, 0, 1, '{name}{ext}')).toBe('HERO.stl');
    expect(renderTemplate(ctx, 0, 1, '{name}')).toBe('HERO');
  });
});

describe('isInvalidFilename', () => {
  it('flags empty / dot-only', () => {
    expect(isInvalidFilename('')).toBe(true);
    expect(isInvalidFilename('.')).toBe(true);
    expect(isInvalidFilename('..')).toBe(true);
  });

  it('flags reserved chars', () => {
    expect(isInvalidFilename('a/b')).toBe(true);
    expect(isInvalidFilename('a\\b')).toBe(true);
    expect(isInvalidFilename('a:b')).toBe(true);
    expect(isInvalidFilename('a*b')).toBe(true);
    expect(isInvalidFilename('a?b')).toBe(true);
    expect(isInvalidFilename('a"b')).toBe(true);
    expect(isInvalidFilename('a<b')).toBe(true);
    expect(isInvalidFilename('a>b')).toBe(true);
    expect(isInvalidFilename('a|b')).toBe(true);
  });

  it('accepts plain names', () => {
    expect(isInvalidFilename('hero.stl')).toBe(false);
    expect(isInvalidFilename('print_001.3mf')).toBe(false);
    expect(isInvalidFilename('Some File With Spaces.obj')).toBe(false);
  });

  it('flags Windows reserved device names, with or without extension', () => {
    expect(isInvalidFilename('con')).toBe(true);
    expect(isInvalidFilename('CON.stl')).toBe(true);
    expect(isInvalidFilename('aux.3mf')).toBe(true);
    expect(isInvalidFilename('COM1')).toBe(true);
    expect(isInvalidFilename('lpt9.obj')).toBe(true);
    expect(isInvalidFilename('console.stl')).toBe(false);
    expect(isInvalidFilename('com10.stl')).toBe(false);
  });

  it('flags trailing dots and spaces (Windows strips them silently)', () => {
    expect(isInvalidFilename('hero.stl.')).toBe(true);
    expect(isInvalidFilename('hero.stl ')).toBe(true);
  });
});
