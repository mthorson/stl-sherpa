import type { Archiver as ArchiveStream, ArchiverOptions as ArchiveOptions } from 'archiver';

// Archiver 8 exports format-specific constructors. The published v7 typings
// still describe the removed factory; reuse their stream/options definitions.
declare module 'archiver' {
  const ZipArchive: new (options?: ArchiveOptions) => ArchiveStream;
}
