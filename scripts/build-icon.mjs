#!/usr/bin/env node
// Render build/icon.svg → build/icon.png at 1024×1024 with sharp. The PNG
// is what electron-builder reads at packaging time; it auto-generates the
// platform-specific .icns / .ico from a single high-res square PNG.
//
// Run with: npm run build:icon
// The release workflow runs this before packaging, since the PNG is gitignored.

import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const SVG_PATH = resolve(here, '..', 'build', 'icon.svg');
const PNG_PATH = resolve(here, '..', 'build', 'icon.png');
const SIZE = 1024;

const svg = await readFile(SVG_PATH);

const png = await sharp(svg, { density: 512 })
  .resize(SIZE, SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9 })
  .toBuffer();

await writeFile(PNG_PATH, png);

const { size } = await stat(PNG_PATH);
console.log(`Wrote ${PNG_PATH} (${SIZE}×${SIZE}, ${(size / 1024).toFixed(1)} KB)`);
