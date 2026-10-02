import * as THREE from 'three';
import { disposeObject, loadModel } from './three/loaders';
import { frameObject } from './three/framing';
import { extract3MFEmbeddedThumbnail } from './three/three-mf-fast-path';
import { extractMetadata, thumbnailOnlyMetadata } from './three/metadata';
import { analyzeGeometry } from './three/validation';
import { computePrintability } from './three/printability';
import { extractFormatMetadata } from './three/format-metadata';
import { DEFAULT_LIGHTING_STYLE, LightingRig, type LightingStyle } from './three/lighting';
import { THUMB_WORKER_RENDER_SIZE } from '@shared/thumb-worker-protocol';
import type { ThumbRenderRequest, ThumbRenderResult, ThumbWorkerApi } from '@shared/thumb-worker-protocol';
import type { ExtractedMetadata } from '@shared/types';
import { scopedLogger } from './logger';
import { modelResourceUrl } from '@shared/model-source';

const log = scopedLogger('thumb-worker');

const workerApi = (window as unknown as { meshFlaskWorker: ThumbWorkerApi }).meshFlaskWorker;

let renderer: THREE.WebGLRenderer | null = null;
// Scene + lighting rig persist across jobs: rebuilding the rig per thumbnail
// costs a PMREM environment bake (a full cubemap render) per file, which for
// a bulk import rivals the model render itself. The rig memoizes by
// (style, quality), so repeat jobs with the same style skip the bake.
let scene: THREE.Scene | null = null;
let lighting: LightingRig | null = null;
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

function getSceneAndLighting(r: THREE.WebGLRenderer): { scene: THREE.Scene; lighting: LightingRig } {
  if (!scene || !lighting) {
    scene = new THREE.Scene();
    lighting = new LightingRig(scene, r);
  }
  return { scene, lighting };
}

function dropRenderContext(): void {
  lighting?.dispose();
  scene?.clear();
  scene = null;
  lighting = null;
  renderer = null;
}

interface RenderOutput {
  png: Uint8Array;
  metadata: ExtractedMetadata;
}

async function renderToPng(req: ThumbRenderRequest): Promise<RenderOutput> {
  const response = await fetch(`wh3d-file://${req.libraryId}/${req.fileId}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Couldn't load this file (error ${response.status}).`);
  const arrayBuffer = await response.arrayBuffer();

  if (req.ext === '3mf') {
    const embedded = extract3MFEmbeddedThumbnail(arrayBuffer);
    if (embedded) {
      // Fast-path: embedded slicer thumb. We skip mesh load entirely so we
      // don't pay the multi-second 3MF parse cost just for vertex counts.
      return { png: embedded, metadata: thumbnailOnlyMetadata('3mf-embedded') };
    }
  }

  const obj = await loadModel(arrayBuffer, req.ext, '', req.orientation,
    (uri) => modelResourceUrl(req.libraryId, req.fileId, uri));

  const r = getRenderer();
  const { scene: jobScene, lighting: jobLighting } = getSceneAndLighting(r);
  try {
    jobLighting.apply((req.lightingStyle as LightingStyle | undefined) ?? DEFAULT_LIGHTING_STYLE);
    jobScene.add(obj);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1000);
    frameObject(camera, obj);

    r.render(jobScene, camera);
    // A lost GL context (GPU reset, driver restart) renders nothing, but
    // toBlob still returns a valid all-background PNG — which would be cached
    // as a success and never retried. Fail the job and drop the renderer so
    // the next job starts from a fresh context.
    if (r.getContext().isContextLost()) {
      dropRenderContext();
      throw new Error('The graphics context was lost during render.');
    }

    const blob = await new Promise<Blob | null>((resolve) =>
      r.domElement.toBlob(resolve, 'image/png')
    );
    if (!blob) throw new Error("Couldn't capture the rendered image.");
    const png = new Uint8Array(await blob.arrayBuffer());

    // Extract metadata BEFORE disposal so the geometries/materials are still alive.
    // analyzeGeometry does watertightness, degenerate count, and volume in a
    // single pass over the triangles.
    const { validation, meshVolumeMm3 } = analyzeGeometry(obj);
    const printability = computePrintability(obj, validation);
    // Format-specific provenance is parsed from the original file bytes, not the
    // decoded scene, so it's independent of disposal ordering.
    const format = extractFormatMetadata(arrayBuffer, req.ext);
    const metadata = extractMetadata(
      obj,
      'gl',
      validation,
      meshVolumeMm3,
      printability,
      format
    );

    return { png, metadata };
  } finally {
    // The model is per-job; the scene/rig live on. Disposal runs on error
    // paths too — a folder of failing files would otherwise leak every
    // loaded geometry until the worker recycles.
    jobScene.remove(obj);
    disposeObject(obj);
  }
}

workerApi.onRender(async (req: ThumbRenderRequest) => {
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
      libraryId: req.libraryId,
      fileId: req.fileId,
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
  workerApi.result(result);
});

workerApi.ready();
log.info('worker started');
