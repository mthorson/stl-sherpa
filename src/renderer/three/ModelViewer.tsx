import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Center, Loader, Stack, Text } from '@mantine/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { disposeObject, loadModel, ThreeMFEmbeddedOnlyError } from './loaders';
import { frameObject, objectCenter } from './framing';
import { DEFAULT_LIGHTING_STYLE, LightingRig, type LightingStyle } from './lighting';
import { applyOrientation } from './orientation';
import type { CameraState, FileRecord } from '@shared/types';
import {
  DEFAULT_RENDER_QUALITY,
  getRenderQualityPreset,
  type RenderQuality,
  type RenderQualityPreset
} from '@shared/render-quality';

interface Props {
  /** Active library id, or null in "All Libraries" mode. Unused — the model
   *  fetch and orientation updates key off `file.libraryId` directly. Kept on
   *  the prop list so call sites can stay structurally identical to the
   *  pre-cross-library wiring. */
  libraryId: string | null;
  file: FileRecord;
  lightingStyle?: LightingStyle;
  /** Render quality tier; defaults to Low (no shadows, current historical behavior). */
  renderQuality?: RenderQuality;
}

function shadowFilterToThree(filter: 'basic' | 'pcf' | 'pcfsoft'): THREE.ShadowMapType {
  switch (filter) {
    case 'pcfsoft':
      return THREE.PCFSoftShadowMap;
    case 'pcf':
      return THREE.PCFShadowMap;
    case 'basic':
    default:
      return THREE.BasicShadowMap;
  }
}

/** Tag every Mesh in the subtree so it casts + receives shadows when the
 *  rig has shadows enabled. Idempotent and cheap to re-walk. */
function applyShadowFlags(root: THREE.Object3D, enabled: boolean): void {
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) {
      node.castShadow = enabled;
      node.receiveShadow = enabled;
    }
  });
}

/** Push a texture's anisotropy to the configured value on every material in
 *  the subtree. Quality presets above Low get sharper texture filtering. */
function applyAnisotropy(root: THREE.Object3D, anisotropy: number, max: number): void {
  if (anisotropy <= 1) return;
  const target = Math.min(anisotropy, max);
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      for (const v of Object.values(m)) {
        if (v && (v as THREE.Texture).isTexture) {
          (v as THREE.Texture).anisotropy = target;
          (v as THREE.Texture).needsUpdate = true;
        }
      }
    }
  });
}

interface ViewerCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  lighting: LightingRig;
  currentObject: THREE.Object3D | null;
  rafId: number | null;
  resizeObserver: ResizeObserver | null;
}

export interface ModelViewerHandle {
  /** True when a model is loaded and visible. */
  hasModel(): boolean;
  /** Render the current view to a PNG and return the bytes. Null if no model. */
  captureCurrentFrame(): Promise<Uint8Array | null>;
  /** Snapshot of the camera position/target/zoom — used by compare mode. */
  getCameraState(): CameraState | null;
  /** Apply a camera snapshot. Skips the change-listener fire to avoid loops. */
  setCameraState(state: CameraState): void;
  /** Subscribe to OrbitControls 'change' events. Returns unsubscribe. */
  onCameraChange(cb: () => void): () => void;
}

export const ModelViewer = forwardRef<ModelViewerHandle, Props>(function ModelViewer(
  {
    libraryId: _libraryId,
    file,
    lightingStyle = DEFAULT_LIGHTING_STYLE,
    renderQuality = DEFAULT_RENDER_QUALITY
  },
  ref
) {
  const orientationRef = useRef(file.orientation);
  orientationRef.current = file.orientation;
  const qualityPreset: RenderQualityPreset = getRenderQualityPreset(renderQuality);
  const containerRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<ViewerCtx | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // For 3MFs we can't render as live 3D (Bambu/Prusa multi-part exports
  // larger than the inline budget): show the slicer's embedded PNG instead
  // of an error. Object URL — revoked on swap/unmount.
  const [embeddedPngUrl, setEmbeddedPngUrl] = useState<string | null>(null);
  // Compare mode wires N viewers together via onCameraChange. We collect the
  // subscribers in a ref so the cleanup function can remove them precisely.
  const cameraListenersRef = useRef<Set<() => void>>(new Set());
  // When the camera is being programmatically synced from a sibling viewer,
  // skip firing our own change listeners or we'd loop forever.
  const suppressChangeRef = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      hasModel() {
        return ctxRef.current?.currentObject != null;
      },
      async captureCurrentFrame() {
        const ctx = ctxRef.current;
        if (!ctx || !ctx.currentObject) return null;
        // Force a fresh render right before reading pixels — the rAF loop
        // composites and clears between frames, so blitting can return blank
        // unless we've just rendered. preserveDrawingBuffer:true on the
        // renderer also helps keep the buffer stable for the readback.
        ctx.renderer.render(ctx.scene, ctx.camera);

        // Crop a centered 1:1 square out of the (possibly non-square) canvas.
        // The CropOverlay in PreviewPane previews exactly this region so the
        // user knows what'll end up in the thumbnail.
        const src = ctx.renderer.domElement;
        const srcW = src.width;
        const srcH = src.height;
        const cropPx = Math.min(srcW, srcH);
        if (cropPx <= 0) return null;
        const offsetX = Math.floor((srcW - cropPx) / 2);
        const offsetY = Math.floor((srcH - cropPx) / 2);
        // Cap output at 1024 to keep PNGs reasonably small while still being
        // crisper than the worker's 512px renders when the viewer is large.
        const outSize = Math.min(cropPx, 1024);

        const out = document.createElement('canvas');
        out.width = outSize;
        out.height = outSize;
        const ctx2d = out.getContext('2d');
        if (!ctx2d) return null;
        ctx2d.drawImage(src, offsetX, offsetY, cropPx, cropPx, 0, 0, outSize, outSize);

        const blob = await new Promise<Blob | null>((resolve) =>
          out.toBlob(resolve, 'image/png')
        );
        if (!blob) return null;
        return new Uint8Array(await blob.arrayBuffer());
      },
      getCameraState() {
        const ctx = ctxRef.current;
        if (!ctx) return null;
        return {
          position: [ctx.camera.position.x, ctx.camera.position.y, ctx.camera.position.z],
          target: [ctx.controls.target.x, ctx.controls.target.y, ctx.controls.target.z],
          zoom: ctx.camera.zoom
        };
      },
      setCameraState(state) {
        const ctx = ctxRef.current;
        if (!ctx) return;
        suppressChangeRef.current = true;
        ctx.camera.position.set(state.position[0], state.position[1], state.position[2]);
        ctx.controls.target.set(state.target[0], state.target[1], state.target[2]);
        ctx.camera.zoom = state.zoom;
        ctx.camera.updateProjectionMatrix();
        ctx.controls.update();
        // Release the suppression on the next microtask so the corresponding
        // OrbitControls 'change' event (fired during controls.update) doesn't
        // re-broadcast.
        queueMicrotask(() => {
          suppressChangeRef.current = false;
        });
      },
      onCameraChange(cb) {
        cameraListenersRef.current.add(cb);
        return () => {
          cameraListenersRef.current.delete(cb);
        };
      }
    }),
    []
  );

  // Renderer / scene / camera live for the lifetime of the component.
  // Recreating them per file caused the compositor to reference freed GPU
  // mailboxes (shared_image_manager errors) and was needlessly expensive.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { width, height } = container.getBoundingClientRect();
    const w = Math.max(width, 1);
    const h = Math.max(height, 1);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      // Required so captureCurrentFrame()'s toBlob() reliably reads pixels —
      // otherwise the buffer may be cleared by compositing between render()
      // and the toBlob callback.
      preserveDrawingBuffer: true
    });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, h);
    renderer.setClearColor(0x101113, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = qualityPreset.shadows.enabled;
    renderer.shadowMap.type = shadowFilterToThree(qualityPreset.shadows.filter);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const lighting = new LightingRig(scene, renderer);
    lighting.apply(lightingStyle, qualityPreset);

    const camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 1000);
    camera.position.set(0, 0, 5);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    // Notify external subscribers (compare mode) on user-driven camera moves
    // — but skip during programmatic sync to avoid feedback loops.
    controls.addEventListener('change', () => {
      if (suppressChangeRef.current) return;
      for (const cb of cameraListenersRef.current) cb();
    });

    const ctx: ViewerCtx = {
      renderer,
      scene,
      camera,
      controls,
      lighting,
      currentObject: null,
      rafId: null,
      resizeObserver: null
    };
    ctxRef.current = ctx;

    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      ctx.rafId = requestAnimationFrame(tick);
    };
    tick();

    const ro = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      renderer.setSize(rect.width, rect.height);
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
    });
    ro.observe(container);
    ctx.resizeObserver = ro;

    return () => {
      if (ctx.rafId !== null) cancelAnimationFrame(ctx.rafId);
      ctx.resizeObserver?.disconnect();
      controls.dispose();
      if (ctx.currentObject) {
        scene.remove(ctx.currentObject);
        disposeObject(ctx.currentObject);
      }
      ctx.lighting.dispose();
      scene.clear();
      // Detach the canvas BEFORE disposing the renderer so Chromium's
      // compositor stops referencing the GPU mailbox before the texture is
      // freed. Skipping forceContextLoss() avoids the same race — Three's
      // dispose() is enough; the GL context is collected when the canvas is
      // removed from the DOM.
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
      renderer.dispose();
      ctxRef.current = null;
    };
    // Quality is in the dep array because the renderer's shadowMap settings
    // are immutable post-init in practice (changing shadowMap.type after
    // first frame doesn't always flush program caches). Recreating the GL
    // context on tier change is the simplest reliable path; quality changes
    // are infrequent (user toggling a pref) so the brief flash is acceptable.
  }, [renderQuality]);

  // Hot-swap lighting when the user picks a different preset. No canvas /
  // model teardown — LightingRig.apply() clears the prior lights/env and
  // installs the new set. Quality is passed through so the rig keeps env-map
  // sharpness + shadow caster in sync with the active tier.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.lighting.apply(lightingStyle, qualityPreset);
    if (ctx.currentObject) {
      ctx.lighting.fitToModel(new THREE.Box3().setFromObject(ctx.currentObject));
    }
  }, [lightingStyle, qualityPreset]);

  // Up-axis change → re-apply orientation AND reframe the camera. Changing
  // which way is "up" is a fundamental pose correction, so jumping back to
  // a sensible default 3/4 view is what the user expects.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx?.currentObject) return;
    applyOrientation(ctx.currentObject, file.orientation);
    ctx.lighting.fitToModel(new THREE.Box3().setFromObject(ctx.currentObject));
    frameObject(ctx.camera, ctx.currentObject);
    ctx.controls.target.copy(objectCenter(ctx.currentObject));
    ctx.controls.update();
  }, [file.orientation.upAxis]);

  // Yaw change → spin the model in place; do NOT reframe the camera. The
  // lights are world-fixed, so leaving the camera alone makes the lighting
  // appear stationary while the model rotates under it — the user can pick
  // which side faces the camera/light. We still nudge controls.target so an
  // offset model stays in view (OrbitControls keeps camera position fixed
  // when only the target moves; it just reorients the lookAt).
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx?.currentObject) return;
    applyOrientation(ctx.currentObject, file.orientation);
    ctx.lighting.fitToModel(new THREE.Box3().setFromObject(ctx.currentObject));
    ctx.controls.target.copy(objectCenter(ctx.currentObject));
  }, [file.orientation.yaw]);

  // Load / swap the model when the selected file changes. The renderer
  // keeps running through the swap so there's no canvas teardown.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;

    let canceled = false;
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    setEmbeddedPngUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    // Hide any leftover scene from the previous file while we load. The
    // embedded-PNG fallback below paints over the canvas anyway, but
    // dropping the live object also frees its GPU memory.
    if (ctx.currentObject) {
      ctx.scene.remove(ctx.currentObject);
      disposeObject(ctx.currentObject);
      ctx.currentObject = null;
    }

    const load = async () => {
      try {
        // Use file.libraryId so cross-library views (the "All Libraries"
        // sidebar entry) resolve correctly without the parent needing to
        // pipe a per-tile library prop.
        const res = await fetch(`wh3d-file://${file.libraryId}/${file.id}`, {
          signal: abort.signal
        });
        if (!res.ok) throw new Error(`Couldn't load this file (error ${res.status}).`);
        const buffer = await res.arrayBuffer();
        if (canceled) return;

        const obj = await loadModel(buffer, file.ext, '', file.orientation);
        if (canceled) {
          disposeObject(obj);
          return;
        }
        // Orientation may change while a large model is parsing. Apply the
        // latest value before the object becomes visible.
        applyOrientation(obj, orientationRef.current);

        ctx.scene.add(obj);
        ctx.currentObject = obj;

        // Apply quality-tier shadow flags + texture anisotropy. Cheap to
        // do here and means re-loading a file picks up any quality change.
        applyShadowFlags(obj, qualityPreset.shadows.enabled);
        applyAnisotropy(
          obj,
          qualityPreset.anisotropy,
          ctx.renderer.capabilities.getMaxAnisotropy()
        );

        // Size the shadow caster's camera + position to the model's actual
        // scale so shadows work for tiny STLs and meter-scale glTFs alike.
        const box = new THREE.Box3().setFromObject(obj);
        ctx.lighting.fitToModel(box);

        // Prefer the saved camera (captured when the user composed the
        // thumbnail) over the default frame-fit, so reopening the file
        // restarts at the same angle. frameObject still runs first because
        // it sets near/far to match the model's scale — without that, a
        // large model reopens clipped by the default far plane.
        frameObject(ctx.camera, obj);
        if (file.camera) {
          ctx.camera.position.set(
            file.camera.position[0],
            file.camera.position[1],
            file.camera.position[2]
          );
          ctx.controls.target.set(
            file.camera.target[0],
            file.camera.target[1],
            file.camera.target[2]
          );
          ctx.camera.zoom = file.camera.zoom;
          ctx.camera.updateProjectionMatrix();
          ctx.controls.update();
        } else {
          ctx.controls.target.copy(objectCenter(obj));
          ctx.controls.update();
        }

        setLoading(false);
      } catch (err) {
        if (canceled || (err as Error).name === 'AbortError') return;
        if (err instanceof ThreeMFEmbeddedOnlyError && err.png) {
          const blob = new Blob([err.png as BlobPart], { type: 'image/png' });
          setEmbeddedPngUrl(URL.createObjectURL(blob));
          setLoading(false);
          return;
        }
        setError((err as Error).message ?? String(err));
        setLoading(false);
      }
    };

    void load();

    return () => {
      canceled = true;
      abort.abort();
    };
  }, [file.libraryId, file.id, file.ext, renderQuality]);

  // Release the object URL on unmount.
  useEffect(() => {
    return () => {
      if (embeddedPngUrl) URL.revokeObjectURL(embeddedPngUrl);
    };
  }, [embeddedPngUrl]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        background: '#101113',
        overflow: 'hidden'
      }}
    >
      {embeddedPngUrl && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#101113'
          }}
        >
          <img
            src={embeddedPngUrl}
            alt="Embedded slicer preview"
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
          <Text
            size="xs"
            c="dimmed"
            style={{
              position: 'absolute',
              left: 8,
              bottom: 6,
              background: 'rgba(0,0,0,0.45)',
              padding: '2px 6px',
              borderRadius: 3
            }}
          >
            Showing the slicer's preview image. This 3MF is too big to open in 3D.
          </Text>
        </div>
      )}
      {loading && (
        <Center style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <Loader size="sm" />
        </Center>
      )}
      {error && (
        <Center style={{ position: 'absolute', inset: 0, padding: 8 }}>
          <Stack gap={2} align="center">
            <Text size="xs" c="red">
              Preview failed
            </Text>
            <Text size="xs" c="dimmed" ta="center" style={{ wordBreak: 'break-word' }}>
              {error}
            </Text>
          </Stack>
        </Center>
      )}
    </div>
  );
});
