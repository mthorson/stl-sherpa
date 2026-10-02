import type { FileRecord } from './types';

/** Identifies the bytes loaded in a viewer, independently of UI metadata edits. */
export function modelSourceKey(file: Pick<FileRecord, 'libraryId' | 'id' | 'relPath' | 'mtimeMs' | 'sizeBytes'>): string {
  return JSON.stringify([file.libraryId, file.id, file.relPath, file.mtimeMs, file.sizeBytes]);
}

/** Keep relative glTF resources tied to the indexed model that requested them. */
export function modelResourceUrl(libraryId: string, fileId: number, uri: string): string {
  if (/^(data|blob):/i.test(uri)) return uri;
  if (/^[a-z][a-z\d+.-]*:/i.test(uri) || /^[\\/]/.test(uri)) {
    throw new Error('Model resources must be relative to the library');
  }
  return `wh3d-file://${libraryId}/${fileId}?resource=${encodeURIComponent(uri)}`;
}
