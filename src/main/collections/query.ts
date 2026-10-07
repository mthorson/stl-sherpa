import type { CollectionsRepo } from '@main/db/repos/collections';
import type { FilesRepo } from '@main/db/repos/files';
import type { FileQueryRequest, FileRecord } from '@shared/types';
import { DEFAULT_SORT } from '@shared/sort';

type QueryRequest = Omit<FileQueryRequest, 'libraryId'>;

export interface CollectionQuery {
  query(request: QueryRequest): FileRecord[];
}

function isDefaultSort(request: QueryRequest): boolean {
  return (
    request.sort?.field === DEFAULT_SORT.field &&
    request.sort.direction === DEFAULT_SORT.direction
  );
}

export function createCollectionQuery(
  files: FilesRepo,
  collections: CollectionsRepo
): CollectionQuery {
  return {
    query(request) {
      if (request.collectionId == null) return files.query(request);
      if (!Number.isInteger(request.collectionId)) return [];

      const collection = collections.getById(request.collectionId);
      if (!collection) return [];

      const {
        parentDir: _parentDir,
        recursive: _recursive,
        ...unscoped
      } = request;

      if (!collection.smartQuery) {
        return files.query({
          ...unscoped,
          sort: isDefaultSort(request) ? undefined : request.sort
        });
      }

      const saved = collection.smartQuery;
      const runtimeSearch = request.query?.trim();
      return files.query({
        ...unscoped,
        collectionId: undefined,
        query: runtimeSearch || saved.search?.trim() || undefined,
        extensions:
          request.extensions && request.extensions.length > 0
            ? request.extensions
            : saved.extensions,
        tagIds:
          request.tagIds && request.tagIds.length > 0
            ? request.tagIds
            : saved.tagIds,
        minRating:
          request.minRating && request.minRating > 0
            ? request.minRating
            : saved.minRating,
        colorLabels:
          request.colorLabels && request.colorLabels.length > 0
            ? request.colorLabels
            : saved.colorLabels
      });
    }
  };
}
