import { unzipSync } from 'fflate';
import type { FormatMetadata } from '@shared/types';
import { isSafeArchiveEntryName, MAX_TOTAL_DECOMPRESSED_BYTES } from './zip-safety';

/**
 * Format-specific metadata pulled straight from the file bytes — author/title
 * embedded by 3MF authoring tools, the 80-byte header text in a binary STL,
 * the `solid` name in an ASCII STL. These complement the geometry-derived
 * metadata which can't see this provenance information.
 *
 * All parsers are pure (bytes in, plain object out), defensive against
 * malformed input, and bounded so a hostile file can't exhaust memory.
 */

const DEFAULT_MODEL_PART = '3D/3dmodel.model';
const MAX_MODEL_XML_BYTES = 4 * 1024 * 1024;
const MAX_FIELD_CHARS = 512;

export function extractFormatMetadata(buffer: ArrayBuffer, ext: string): FormatMetadata | null {
  switch (ext) {
    case 'stl':
      return extractStlMetadata(buffer);
    case '3mf':
      return extract3mfMetadata(buffer);
    default:
      return null;
  }
}

/**
 * STL has two on-disk shapes:
 *  - ASCII: starts with `solid <name>` — the name often carries the part name
 *    or the authoring tool.
 *  - Binary: an 80-byte header (free text, conventionally the exporter banner)
 *    followed by a uint32 triangle count.
 * We surface whichever is present. ASCII files reuse the leading `solid` line
 * as a header too so the UI always has something to show.
 */
export function extractStlMetadata(buffer: ArrayBuffer): FormatMetadata | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 5) return null;

  if (isAsciiStl(bytes)) {
    const firstLine = decodeAsciiLine(bytes, 0, 256);
    const solidName = firstLine.replace(/^solid\b[ \t]*/i, '').trim();
    const out: FormatMetadata = {};
    if (solidName) out.solidName = clip(solidName);
    if (firstLine) out.stlHeader = clip(firstLine);
    return hasAny(out) ? out : null;
  }

  // Binary STL: bytes 0..79 are the header. Strip the trailing zero padding and
  // any non-printable bytes, then trim. Many exporters leave it blank.
  const header = sanitizeText(new TextDecoder('latin1').decode(bytes.subarray(0, 80)));
  if (!header) return null;
  return { stlHeader: clip(header) };
}

function isAsciiStl(bytes: Uint8Array): boolean {
  // The conventional sniff: an ASCII STL begins with "solid". Binary files can
  // also start with "solid" in their header, so we additionally require that
  // the first chunk contains the word "facet" (binary headers are arbitrary
  // text and won't reliably contain STL keywords). Cheap and good enough for a
  // metadata hint.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 512)).toLowerCase();
  return head.trimStart().startsWith('solid') && head.includes('facet');
}

function decodeAsciiLine(bytes: Uint8Array, start: number, maxLen: number): string {
  let end = start;
  const limit = Math.min(bytes.byteLength, start + maxLen);
  while (end < limit && bytes[end] !== 0x0a && bytes[end] !== 0x0d) end++;
  return sanitizeText(new TextDecoder('latin1').decode(bytes.subarray(start, end)));
}

/**
 * 3MF document metadata lives as `<metadata name="Title">value</metadata>`
 * elements in the main model part (`3D/3dmodel.model`, occasionally renamed and
 * pointed to by `_rels/.rels`). The core spec defines Title, Designer,
 * Description, Copyright, LicenseTerms, Rating, CreationDate, ModificationDate,
 * and Application; we surface the human-meaningful ones.
 */
export function extract3mfMetadata(buffer: ArrayBuffer): FormatMetadata | null {
  const bytes = new Uint8Array(buffer);
  const modelName = findModelPartName(bytes) ?? DEFAULT_MODEL_PART;
  const xml = decodeModelPart(bytes, modelName);
  if (!xml) return null;

  const map = parseMetadataElements(xml);
  const out: FormatMetadata = {};
  const title = map.get('title');
  const author = map.get('designer') ?? map.get('author');
  const description = map.get('description');
  const license = map.get('licenseterms') ?? map.get('license');
  const copyright = map.get('copyright');
  const application = map.get('application');
  if (title) out.title = clip(title);
  if (author) out.author = clip(author);
  if (description) out.description = clip(description);
  if (license) out.license = clip(license);
  if (copyright) out.copyright = clip(copyright);
  if (application) out.application = clip(application);
  return hasAny(out) ? out : null;
}

/** Map lower-cased `name` attribute -> element text for every `<metadata>` tag. */
function parseMetadataElements(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<metadata\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/metadata>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const key = m[1].trim().toLowerCase();
    // Strip a possible namespace prefix on the name, e.g. "dc:title".
    const bare = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key;
    const value = decodeXmlEntities(m[2]).trim();
    if (value && !map.has(bare)) map.set(bare, value);
  }
  return map;
}

/** Resolve the main model part name via `_rels/.rels`, falling back to null. */
function findModelPartName(bytes: Uint8Array): string | null {
  const xml = decodeZipEntry(bytes, '_rels/.rels');
  if (!xml) return null;
  const re = /<Relationship\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0];
    if (!/Type="[^"]*3dmodel[^"]*"/i.test(tag)) continue;
    const target = tag.match(/Target="([^"]+)"/i)?.[1];
    if (!target) continue;
    const normalized = target.startsWith('/') ? target.slice(1) : target;
    if (!isSafeArchiveEntryName(normalized)) continue;
    return normalized;
  }
  return null;
}

function decodeModelPart(bytes: Uint8Array, name: string): string | null {
  if (!isSafeArchiveEntryName(name)) return null;
  return decodeZipEntry(bytes, name, MAX_MODEL_XML_BYTES);
}

/**
 * Decompress a single named zip entry. Bounded by `maxBytes` (declared
 * decompressed size) so a zip-bomb entry is skipped before allocation,
 * mirroring the defenses in three-mf-fast-path.
 */
function decodeZipEntry(
  bytes: Uint8Array,
  name: string,
  maxBytes = MAX_TOTAL_DECOMPRESSED_BYTES
): string | null {
  try {
    const out = unzipSync(bytes, {
      filter: (file) =>
        file.name === name && file.originalSize > 0 && file.originalSize <= maxBytes
    });
    const data = out[name];
    if (!data) return null;
    return new TextDecoder().decode(data);
  } catch {
    return null;
  }
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'"
};

function decodeXmlEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (ent) => {
    if (ent in XML_ENTITIES) return XML_ENTITIES[ent];
    if (ent.startsWith('&#x')) return safeCodePoint(parseInt(ent.slice(3, -1), 16));
    if (ent.startsWith('&#')) return safeCodePoint(parseInt(ent.slice(2, -1), 10));
    return ent;
  });
}

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/** Drop control characters (keep tab) so a binary header can't smuggle junk. */
function sanitizeText(s: string): string {
  // Strip C0 controls (NUL..US) except tab, plus DEL. Binary STL headers are
  // commonly zero-padded; this keeps only the printable banner text.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, '').trim();
}

function clip(s: string): string {
  return s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS)}…` : s;
}

function hasAny(o: FormatMetadata): boolean {
  return Object.keys(o).length > 0;
}
