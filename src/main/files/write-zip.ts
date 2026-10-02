import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import type { ExportFile } from './model-files';

/** Publish only a complete ZIP; failed exports leave an existing destination intact. */
export async function writeZip(destination: string, files: ExportFile[]): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const output = createWriteStream(temporary, { flags: 'wx' });
  archive.on('warning', (error: Error) => archive.destroy(error));
  const writing = pipeline(archive, output);
  try {
    for (const file of files) archive.file(file.abs, { name: file.relPath });
    await Promise.all([writing, archive.finalize()]);
    await rename(temporary, destination);
  } finally {
    archive.destroy();
    output.destroy();
    await writing.catch(() => undefined);
    await rm(temporary, { force: true });
  }
}
