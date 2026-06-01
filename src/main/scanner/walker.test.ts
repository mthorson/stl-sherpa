import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PathResolver } from '../../shared/paths';
import { walkLibrary, WalkAbortedError } from './walker';
import type { UpsertInput } from '../db/repos/files';

const TESTFILES = resolve(__dirname, '../../../testfiles');

// Skip the suite if the user hasn't placed sample files there.
const hasFixtures = existsSync(TESTFILES);

describe.runIf(hasFixtures)('walkLibrary against testfiles/', () => {
  it('finds the Manticore 3mf at the root and all 5 stl parts in the subfolder', async () => {
    const resolver = new PathResolver(TESTFILES);
    const collected: UpsertInput[] = [];
    const { totalSeen, seenRelPaths } = await walkLibrary(resolver, {
      onBatch: (batch) => {
        collected.push(...batch);
      }
    });

    expect(totalSeen).toBe(6);
    expect(collected).toHaveLength(6);
    expect(seenRelPaths.size).toBe(6);

    // POSIX paths only — even though the directory name has spaces.
    for (const p of seenRelPaths) {
      expect(p).not.toContain('\\');
    }

    expect(seenRelPaths.has('manticore.3mf')).toBe(true);

    const stlPaths = [...seenRelPaths].filter((p) => p.endsWith('.stl')).sort();
    expect(stlPaths).toHaveLength(5);
    for (const p of stlPaths) {
      expect(p.startsWith('Manticore - Tabletop Miniature - 4441441/files/')).toBe(true);
      expect(p.endsWith('.stl')).toBe(true);
    }

    // Root-level file has parentDir === ''.
    const root3mf = collected.find((c) => c.relPath === 'manticore.3mf')!;
    expect(root3mf.parentDir).toBe('');
    expect(root3mf.ext).toBe('3mf');
    expect(root3mf.sizeBytes).toBeGreaterThan(0);

    // Nested file has the correct POSIX parentDir.
    const oneStl = collected.find((c) => c.ext === 'stl')!;
    expect(oneStl.parentDir).toBe('Manticore - Tabletop Miniature - 4441441/files');
  });

  it('skips the .meshFlask/ cache directory if present', async () => {
    // Just verify the walker doesn't blow up on a real directory and that
    // there is no leakage of dot-files into the result set.
    const resolver = new PathResolver(TESTFILES);
    const { seenRelPaths } = await walkLibrary(resolver);
    for (const p of seenRelPaths) {
      expect(p.split('/').some((seg) => seg.startsWith('.'))).toBe(false);
    }
  });

});

describe('walkLibrary cancellation', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'meshflask-walk-'));
    const sub = join(root, 'parts');
    mkdirSync(sub);
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(sub, `part-${i}.stl`), `solid p${i}\nendsolid p${i}\n`);
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const resolver = new PathResolver(root);
    const controller = new AbortController();
    controller.abort();
    const batches: UpsertInput[][] = [];
    await expect(
      walkLibrary(resolver, {
        signal: controller.signal,
        onBatch: (batch) => {
          batches.push(batch);
        }
      })
    ).rejects.toBeInstanceOf(WalkAbortedError);
    // Aborted before descending into the root → no batches were delivered.
    expect(batches).toHaveLength(0);
  });

  it('stops early when aborted from inside onBatch', async () => {
    const resolver = new PathResolver(root);
    const controller = new AbortController();
    let seen = 0;
    await expect(
      walkLibrary(resolver, {
        // Small batch so the first flush happens well before the walk finishes.
        batchSize: 1,
        signal: controller.signal,
        onBatch: (batch) => {
          seen += batch.length;
          controller.abort();
        }
      })
    ).rejects.toBeInstanceOf(WalkAbortedError);
    // We aborted after the very first file, so far fewer than all 10 were seen.
    expect(seen).toBeLessThan(10);
    expect(seen).toBeGreaterThan(0);
  });
});
