import * as THREE from 'three';
import { disposeObject, loadModel } from './three/loaders';
import { frameObject } from './three/framing';
import { extract3MFEmbeddedThumbnail } from './three/three-mf-fast-path';
import { extractMetadata, thumbnailOnlyMetadata } from './three/metadata';
import { computeMeshVolume, validateScene } from './three/validation';
import { DEFAULT_LIGHTING_STYLE, LightingRig, type LightingStyle } from './three/lighting';
import { THUMB_WORKER_CHANNEL, THUMB_WORKER_RENDER_SIZE } from '@shared/thumb-worker-protocol';
import type { ThumbRenderRequest, ThumbRenderResult } from '@shared/thumb-worker-protocol';
import type { ExtractedMetadata } from '@shared/types';
import type { IpcRenderer } from 'electron';
import type { promises as FsPromises } from 'node:fs';
import { scopedLogger } from './logger';

const log = scopedLogger('thumb-worker');

// Use window.require() rather than ES `import` for the two Node-only modules
// because Vite's dev server can't transform them (the `electron` package's
// default export is a path string and `fs` isn't a browser module). The
// hidden worker BrowserWindow runs with nodeIntegration:true so
// window.require is available in both dev and prod.
const nodeRequire = (window as unknown as { require: NodeRequire }).require;
const { ipcRenderer } = nodeRequire('electron') as { ipcRenderer: IpcRenderer };
const fs = (nodeRequire('fs') as { promises: typeof FsPromises }).promises;

let renderer: THREE.WebGLRenderer | null = null;
let jobsRendered = 0;

function getRenderer(): THREE.WebGLRenderer {
  if (renderer) return renderer;
  const canvas = document.getElementById('render-canvas') as HTMLCanvasElement;
  canvas.width = THUMB_WORKER_RENDER_SIZE;
  canvas.height = THUMB_WORKER_RENDER_SIZE;
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true
  });
  renderer.setSize(THUMB_WORKER_RENDER_SIZE, THUMB_WORKER_RENDER_SIZE, false);
  renderer.setClearColor(0x101113, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

interface RenderOutput {
  png: Uint8Array;
  metadata: ExtractedMetadata;
}

async function renderToPng(req: ThumbRenderRequest): Promise<RenderOutput> {
  const buffer = await fs.readFile(req.absPath);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;

  if (req.ext === '3mf') {
    const embedded = extract3MFEmbeddedThumbnail(arrayBuffer);
    if (embedded) {
      // Fast-path: embedded slicer thumb. We skip mesh load entirely so we
      // don't pay the multi-second 3MF parse cost just for vertex counts.
      return { png: embedded, metadata: thumbnailOnlyMetadata('3mf-embedded') };
    }
  }

  const obj = await loadModel(arrayBuffer, req.ext, req.absPath, req.orientation);

  const r = getRenderer();
  const scene = new THREE.Scene();
  const lighting = new LightingRig(scene, r);
  lighting.apply((req.lightingStyle as LightingStyle | undefined) ?? DEFAULT_LIGHTING_STYLE);
  scene.add(obj);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1000);
  frameObject(camera, obj);

  r.render(scene, camera);

  const blob = await new Promise<Blob | null>((resolve) =>
    r.domElement.toBlob(resolve, 'image/png')
  );
  if (!blob) throw new Error('canvas.toBlob returned null');
  const png = new Uint8Array(await blob.arrayBuffer());

  // Extract metadata BEFORE disposal so the geometries/materials are still alive.
  const validation = validateScene(obj);
  const meshVolumeMm3 = computeMeshVolume(obj);
  const metadata = extractMetadata(obj, 'gl', validation, meshVolumeMm3);

  disposeObject(obj);
  lighting.dispose();
  scene.clear();
  return { png, metadata };
}

ipcRenderer.on(THUMB_WORKER_CHANNEL.render, async (_e, req: ThumbRenderRequest) => {
  let result: ThumbRenderResult;
  try {
    const { png, metadata } = await renderToPng(req);
    result = {
      jobId: req.jobId,
      ok: true,
      png,
      metadata,
      jobsRendered: ++jobsRendered
    };
  } catch (err) {
    log.error('render failed', {
      jobId: req.jobId,
      absPath: req.absPath,
      ext: req.ext,
      err: (err as Error).message ?? String(err)
    });
    result = {
      jobId: req.jobId,
      ok: false,
      error: (err as Error).message ?? String(err),
      jobsRendered: ++jobsRendered
    };
  }
  ipcRenderer.send(THUMB_WORKER_CHANNEL.result, result);
});

ipcRenderer.send(THUMB_WORKER_CHANNEL.ready);
log.info('worker started');
