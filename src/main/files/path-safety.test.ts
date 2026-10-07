import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { moveOnDisk } from './move-service';

describe('moveOnDisk library containment', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('rejects a destination whose parent symlink escapes the library', async () => {
    const root = mkdtempSync(join(tmpdir(), 'meshflask-safe-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'meshflask-safe-outside-'));
    cleanup.push(root, outside);
    const source = join(root, 'model.stl');
    const escapedTarget = join(root, 'linked', 'model.stl');
    writeFileSync(source, 'model');
    symlinkSync(outside, join(root, 'linked'), 'dir');

    const result = await moveOnDisk(root, source, escapedTarget);

    expect(result.ok).toBe(false);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(outside, 'model.stl'))).toBe(false);
  });
});
