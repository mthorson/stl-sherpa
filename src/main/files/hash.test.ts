import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFileContent } from './hash';

describe('hashFileContent', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'meshflask-hash-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the SHA-256 hex digest of a file matching crypto.createHash', async () => {
    const payload = Buffer.from('solid cube\nfacet normal 0 0 1\n');
    const file = join(dir, 'model.stl');
    await writeFile(file, payload);
    const expected = createHash('sha256').update(payload).digest('hex');
    expect(await hashFileContent(file)).toBe(expected);
  });

  it('produces identical digests for identical content and differs otherwise', async () => {
    const a = join(dir, 'a.bin');
    const b = join(dir, 'b.bin');
    const c = join(dir, 'c.bin');
    await writeFile(a, 'duplicate-bytes');
    await writeFile(b, 'duplicate-bytes');
    await writeFile(c, 'other-bytes');
    const [ha, hb, hc] = await Promise.all([
      hashFileContent(a),
      hashFileContent(b),
      hashFileContent(c)
    ]);
    expect(ha).toBe(hb);
    expect(ha).not.toBe(hc);
  });

  it('resolves null instead of throwing when the file cannot be read', async () => {
    expect(await hashFileContent(join(dir, 'does-not-exist.stl'))).toBeNull();
  });
});
