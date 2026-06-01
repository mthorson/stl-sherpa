/**
 * Defenses against malicious zip archives in 3MF files.
 *
 * 3MFs are untrusted: they come from slicers and arbitrary downloads. A
 * crafted archive can declare absurd decompressed sizes (zip-bomb), include
 * thousands of empty entries (memory exhaustion), or use entry names like
 * `../../etc/passwd` (zip-slip — we never extract to disk but check anyway
 * as defense in depth).
 */

export const MAX_ZIP_ENTRIES = 5_000;
export const MAX_TOTAL_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
export const MAX_EMBEDDED_THUMB_BYTES = 4 * 1024 * 1024;

export function isSafeArchiveEntryName(name: string): boolean {
  if (name.includes('\0')) return false;
  if (name.startsWith('/') || name.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(name)) return false;
  for (const seg of name.split(/[/\\]/)) {
    if (seg === '..') return false;
  }
  return true;
}

export function assertSafeArchive(sizes: Map<string, number>): void {
  if (sizes.size > MAX_ZIP_ENTRIES) {
    throw new Error(`3MF has too many entries (${sizes.size} > ${MAX_ZIP_ENTRIES})`);
  }
  let total = 0;
  for (const [name, size] of sizes) {
    if (!isSafeArchiveEntryName(name)) {
      throw new Error(`3MF has unsafe entry name: ${name}`);
    }
    total += size;
    if (total > MAX_TOTAL_DECOMPRESSED_BYTES) {
      throw new Error(
        `3MF total decompressed size exceeds ${MAX_TOTAL_DECOMPRESSED_BYTES} bytes`
      );
    }
  }
}
