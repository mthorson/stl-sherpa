import { unzipSync } from 'fflate';
import { MAX_EMBEDDED_THUMB_BYTES, isSafeArchiveEntryName } from './zip-safety';

/**
 * Slicer-exported 3MFs (Bambu Studio, PrusaSlicer, OrcaSlicer) embed a
 * pre-rendered Metadata/thumbnail.png in the zip. Returning that directly
 * avoids a full GL render and matches what users already see in their slicer.
 */
const CANDIDATES = [
  'Metadata/thumbnail.png',
  'Metadata/thumbnail_middle.png',
  'Metadata/plate_1.png',
  'Metadata/plate_no_light_1.png',
  'Metadata/top_1.png'
];

export function extract3MFEmbeddedThumbnail(buffer: ArrayBuffer): Uint8Array | null {
  let unzipped: Record<string, Uint8Array>;
  try {
    // Zip-bomb defense: filter on declared decompressed size before fflate
    // allocates the output buffer. Only candidate-shaped PNGs under the
    // thumbnail size ceiling get decompressed; mesh data and oversized
    // entries are skipped entirely.
    unzipped = unzipSync(new Uint8Array(buffer), {
      filter: (file) =>
        file.name.startsWith('Metadata/') &&
        file.name.endsWith('.png') &&
        file.originalSize > 0 &&
        file.originalSize <= MAX_EMBEDDED_THUMB_BYTES &&
        isSafeArchiveEntryName(file.name)
    });
  } catch {
    return null;
  }
  for (const name of CANDIDATES) {
    if (unzipped[name] && unzipped[name].byteLength > 0) return unzipped[name];
  }
  // Fallback: any .png anywhere in Metadata/ that survived the filter.
  for (const data of Object.values(unzipped)) {
    if (data.byteLength > 0) return data;
  }
  return null;
}
