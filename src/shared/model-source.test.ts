import { describe, expect, it } from 'vitest';
import { modelResourceUrl, modelSourceKey } from './model-source';

describe('viewer source identity', () => {
  it('invalidates changes to content, location, or owning library', () => {
    const file = { libraryId: 'lib', id: 1, relPath: 'a.stl', mtimeMs: 1, sizeBytes: 5 };
    for (const patch of [{ mtimeMs: 2 }, { sizeBytes: 6 }, { relPath: 'b.stl' }, { libraryId: 'other' }]) {
      expect(modelSourceKey({ ...file, ...patch })).not.toBe(modelSourceKey(file));
    }
  });
  it('keeps parent references associated with the model and preserves inline textures', () => {
    const url = new URL(modelResourceUrl('lib', 1, '../textures/a%20b.png'));
    expect(url.pathname).toBe('/1');
    expect(url.searchParams.get('resource')).toBe('../textures/a%20b.png');
    expect(modelResourceUrl('lib', 1, 'data:image/png;base64,eA==')).toBe('data:image/png;base64,eA==');
    expect(modelResourceUrl('lib', 1, 'blob:local')).toBe('blob:local');
    expect(() => modelResourceUrl('lib', 1, 'https://example.com/a.bin')).toThrow();
  });
});
