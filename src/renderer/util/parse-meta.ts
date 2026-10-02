import type { ExtractedMetadata } from '@shared/types';

/**
 * Parse a FileRecord.metadataJson blob. Returns null for missing or corrupt
 * JSON — callers treat both the same (no metadata available yet).
 */
export function parseFileMeta(json: string | null): ExtractedMetadata | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ExtractedMetadata;
  } catch {
    return null;
  }
}
