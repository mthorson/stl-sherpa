import { unzipSync, zipSync, type Unzipped, type Zippable } from 'fflate';
import { extract3MFEmbeddedThumbnail } from './three-mf-fast-path';
import { assertSafeArchive, isSafeArchiveEntryName } from './zip-safety';

/**
 * Bambu Studio / PrusaSlicer / OrcaSlicer exports use the 3MF Production
 * Extension: the visible mesh data lives in a secondary `.model` part
 * (e.g. `3D/Objects/object_2.model`) and the main `3D/3dmodel.model` only
 * references it via `<component p:path="...">`.
 *
 * Stock ThreeMFLoader.parse() processes `for (file in zip)` in central-
 * directory order. When the main model is processed first, `buildComposite`
 * tries to resolve the component's objectId against the main model's
 * `resources.object` map (the wrong model), gets `undefined`, and crashes
 * with `Cannot read properties of undefined (reading 'mesh')`.
 *
 * Fix: reorder the zip so referenced sub-model parts appear BEFORE the
 * referencing main model. Then ThreeMFLoader builds the sub-model's objects
 * first into its flat `objects[]` cache; when buildComposite later looks up
 * the component's objectId, it finds the cached object and never invokes
 * the broken cross-modelData lookup.
 *
 * For huge meshes (the manticore.3mf test file is 136 MB compressed) the
 * full XML parse would hang/OOM the renderer — those fall back to the
 * embedded slicer PNG so the user still gets a preview.
 */

const MAX_INLINE_PART_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_INLINE_BYTES = 60 * 1024 * 1024;
const MAX_MAIN_MODEL_BYTES = 4 * 1024 * 1024;

export type ThreeMFInspection =
  | { kind: 'single' }
  | { kind: 'rewritten'; buffer: ArrayBuffer }
  | { kind: 'too-large'; embeddedPng: Uint8Array | null };

export function inspectThreeMF(buffer: ArrayBuffer): ThreeMFInspection {
  const bytes = new Uint8Array(buffer);

  let sizes: Map<string, number>;
  try {
    sizes = collectFileSizes(bytes);
    // Zip-bomb / zip-slip defense: cap entry count + total decompressed size,
    // and reject archives that contain entry names attempting to escape.
    assertSafeArchive(sizes);
  } catch {
    // A failed safety check (or an unreadable central directory) falls
    // through to the embedded PNG path so the user still gets a preview.
    return { kind: 'too-large', embeddedPng: extract3MFEmbeddedThumbnail(buffer) };
  }

  const mainModelName = readMainModelName(bytes);
  if (!mainModelName) return { kind: 'single' };

  const mainSize = sizes.get(mainModelName) ?? 0;
  if (mainSize === 0 || mainSize > MAX_MAIN_MODEL_BYTES) {
    return { kind: 'too-large', embeddedPng: extract3MFEmbeddedThumbnail(buffer) };
  }

  const mainXml = decodePart(bytes, mainModelName);
  if (mainXml == null) return { kind: 'single' };

  const referencedPaths = extractReferencedPaths(mainXml);
  if (referencedPaths.length === 0) return { kind: 'single' };

  let totalReferenced = 0;
  for (const p of referencedPaths) {
    const size = sizes.get(p) ?? 0;
    if (size === 0 || size > MAX_INLINE_PART_BYTES) {
      return { kind: 'too-large', embeddedPng: extract3MFEmbeddedThumbnail(buffer) };
    }
    totalReferenced += size;
  }
  if (totalReferenced > MAX_TOTAL_INLINE_BYTES) {
    return { kind: 'too-large', embeddedPng: extract3MFEmbeddedThumbnail(buffer) };
  }

  let full: Unzipped;
  try {
    full = unzipSync(bytes);
  } catch {
    return { kind: 'too-large', embeddedPng: extract3MFEmbeddedThumbnail(buffer) };
  }

  const rewritten = repackInDependencyOrder(full, mainModelName, referencedPaths);
  const ab = rewritten.buffer.slice(
    rewritten.byteOffset,
    rewritten.byteOffset + rewritten.byteLength
  ) as ArrayBuffer;
  return { kind: 'rewritten', buffer: ab };
}

function collectFileSizes(bytes: Uint8Array): Map<string, number> {
  const sizes = new Map<string, number>();
  unzipSync(bytes, {
    filter: (file) => {
      sizes.set(file.name, file.originalSize);
      return false;
    }
  });
  return sizes;
}

function decodePart(bytes: Uint8Array, name: string): string | null {
  try {
    const out = unzipSync(bytes, { filter: (f) => f.name === name });
    const data = out[name];
    if (!data) return null;
    return new TextDecoder().decode(data);
  } catch {
    return null;
  }
}

function readMainModelName(bytes: Uint8Array): string | null {
  const xml = decodePart(bytes, '_rels/.rels');
  if (!xml) return null;
  const re = /<Relationship\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0];
    if (!/Type="[^"]*3dmodel[^"]*"/i.test(tag)) continue;
    const target = tag.match(/Target="([^"]+)"/i)?.[1];
    if (!target) continue;
    const normalized = normalizeZipPath(target);
    if (!isSafeArchiveEntryName(normalized)) continue;
    return normalized;
  }
  return null;
}

function extractReferencedPaths(mainXml: string): string[] {
  const seen = new Set<string>();
  const re = /<component\b[^>]*\bp:path="([^"]+)"[^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(mainXml)) !== null) {
    const normalized = normalizeZipPath(m[1]);
    // Skip any referenced path that looks like a traversal attempt. These
    // would otherwise be looked up in the zip's name table; an attacker
    // can't reach outside the archive, but we want a clear refusal rather
    // than silent acceptance of a poisoned reference.
    if (!isSafeArchiveEntryName(normalized)) continue;
    seen.add(normalized);
  }
  return Array.from(seen);
}

function normalizeZipPath(p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}

function repackInDependencyOrder(
  full: Unzipped,
  mainModelName: string,
  referencedPaths: string[]
): Uint8Array {
  const refSet = new Set(referencedPaths);
  const referencedFirst: string[] = [];
  const others: string[] = [];
  for (const name of Object.keys(full)) {
    if (name === mainModelName) continue;
    if (refSet.has(name)) referencedFirst.push(name);
    else others.push(name);
  }
  const ordered = [...referencedFirst, ...others, mainModelName];

  const zippable: Zippable = {};
  for (const name of ordered) {
    // level 0 = store; we're feeding straight back into ThreeMFLoader's
    // in-memory unzip, so paying for re-compression buys nothing.
    zippable[name] = [full[name], { level: 0 }];
  }
  return zipSync(zippable);
}
