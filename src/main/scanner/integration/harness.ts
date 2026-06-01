import { mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

/**
 * Filesystem integration test harness. Creates a throwaway library directory
 * under the OS temp dir, populated with REAL files (binary STLs, real ZIP-based
 * 3MFs) so the scanner / walker / watcher exercise actual `readdir`/`stat`
 * codepaths rather than mocks. Tear down with `dispose()` in an afterEach.
 *
 * Unlike the in-memory repo tests, these touch the real disk and the chokidar
 * watcher, so they are slower and gated behind `--run-integration` (see
 * ./gate.ts). Default `npm test` / `npm run test:full` skips them.
 */
export interface LibraryHarness {
  /** Absolute path to the library root (use as the PathResolver mount). */
  readonly root: string;
  /** Write a real binary STL at a library-relative POSIX path. */
  writeStl(relPath: string, opts?: { triangles?: number; seed?: number }): void;
  /** Write a real (ZIP container) 3MF at a library-relative POSIX path. */
  write3mf(relPath: string, opts?: { title?: string }): void;
  /** Write arbitrary bytes at a library-relative POSIX path. */
  writeRaw(relPath: string, bytes: Buffer | Uint8Array | string): void;
  /** Move/rename a file, creating any parent directories of the target. */
  move(fromRel: string, toRel: string): void;
  /** Delete a file. */
  remove(relPath: string): void;
  /** Absolute path for a library-relative POSIX path. */
  abs(relPath: string): string;
  /** Remove the entire temp library tree. */
  dispose(): void;
}

function absOf(root: string, relPath: string): string {
  // Library paths are POSIX; translate to the host separator for fs calls.
  return join(root, ...relPath.split('/'));
}

function ensureParent(absPath: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
}

/**
 * Build a minimal but valid binary STL. The 80-byte header is followed by a
 * uint32 triangle count and 50 bytes per triangle. The geometry is a fan of
 * degenerate-but-parseable triangles; size scales with `triangles` so distinct
 * files get distinct (size, mtime) signatures the rename detector keys on.
 */
function buildStl(triangles: number, seed: number): Buffer {
  const count = Math.max(1, triangles);
  const buf = Buffer.alloc(80 + 4 + count * 50);
  buf.write('meshFlask integration test STL', 0, 'ascii');
  buf.writeUInt32LE(count, 80);
  let off = 84;
  for (let i = 0; i < count; i++) {
    // Normal (3 floats) then 3 vertices (9 floats); attribute byte count (u16).
    const base = (i + seed) * 0.5;
    const floats = [
      0, 0, 1,
      base, 0, 0,
      base + 1, 0, 0,
      base, 1, 0
    ];
    for (const f of floats) {
      buf.writeFloatLE(f, off);
      off += 4;
    }
    buf.writeUInt16LE(0, off);
    off += 2;
  }
  return buf;
}

/**
 * Build a real 3MF: a ZIP archive carrying the OPC content-types part and a
 * minimal 3D model part. This is a genuine zip on disk so any code that opens
 * the container (or just stats it) behaves as in production.
 */
function build3mf(title: string): Uint8Array {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
    '</Relationships>';
  const model =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<model unit="millimeter" xml:lang="en-US" ' +
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    `<metadata name="Title">${title}</metadata>` +
    '<resources>' +
    '<object id="1" type="model"><mesh>' +
    '<vertices>' +
    '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>' +
    '<vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>' +
    '</vertices>' +
    '<triangles>' +
    '<triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="1" v3="3"/>' +
    '<triangle v1="0" v2="2" v3="3"/><triangle v1="1" v2="2" v3="3"/>' +
    '</triangles>' +
    '</mesh></object>' +
    '</resources>' +
    '<build><item objectid="1"/></build>' +
    '</model>';
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model)
  });
}

export function createLibraryHarness(prefix = 'meshflask-it-'): LibraryHarness {
  const root = mkdtempSync(join(tmpdir(), prefix));

  return {
    root,
    abs: (relPath) => absOf(root, relPath),
    writeStl(relPath, opts = {}) {
      const abs = absOf(root, relPath);
      ensureParent(abs);
      writeFileSync(abs, buildStl(opts.triangles ?? 4, opts.seed ?? 0));
    },
    write3mf(relPath, opts = {}) {
      const abs = absOf(root, relPath);
      ensureParent(abs);
      writeFileSync(abs, build3mf(opts.title ?? 'model'));
    },
    writeRaw(relPath, bytes) {
      const abs = absOf(root, relPath);
      ensureParent(abs);
      writeFileSync(abs, bytes);
    },
    move(fromRel, toRel) {
      const fromAbs = absOf(root, fromRel);
      const toAbs = absOf(root, toRel);
      ensureParent(toAbs);
      renameSync(fromAbs, toAbs);
    },
    remove(relPath) {
      unlinkSync(absOf(root, relPath));
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}
