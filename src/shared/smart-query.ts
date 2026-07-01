/**
 * SmartQuery — the serialized rule set behind a Smart Collection.
 *
 * Intentionally a subset of `FileQueryRequest`: only filters that make sense
 * to "save" travel here. Folder scope and explicit sort live on the runtime
 * request because they're view-state, not membership rules. All rules AND
 * together — no boolean nesting in v1.
 */

import type { ColorLabel } from './ratings';

export interface SmartQuery {
  /** Free-text FTS search applied across filename + tags + metadata. */
  search?: string;
  /** Restrict to these lowercase extensions. */
  extensions?: string[];
  /** Files must carry ALL listed tag ids. */
  tagIds?: number[];
  /** Files must be at least this rating. */
  minRating?: number;
  /** Files must have one of these color labels. */
  colorLabels?: ColorLabel[];
}

export function isSmartQuery(value: unknown): value is SmartQuery {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.search != null && typeof v.search !== 'string') return false;
  if (v.extensions != null && !Array.isArray(v.extensions)) return false;
  if (v.tagIds != null && !Array.isArray(v.tagIds)) return false;
  if (v.minRating != null && typeof v.minRating !== 'number') return false;
  if (v.colorLabels != null && !Array.isArray(v.colorLabels)) return false;
  return true;
}

export function emptySmartQuery(): SmartQuery {
  return {};
}

export function isSmartQueryEmpty(q: SmartQuery): boolean {
  if (q.search && q.search.trim().length > 0) return false;
  if (q.extensions && q.extensions.length > 0) return false;
  if (q.tagIds && q.tagIds.length > 0) return false;
  if (q.minRating && q.minRating > 0) return false;
  if (q.colorLabels && q.colorLabels.length > 0) return false;
  return true;
}
