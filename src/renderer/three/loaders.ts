import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { getDefaultOrientation, type FileOrientation } from '@shared/orientation';
import { applyOrientation } from './orientation';
import { inspectThreeMF } from './three-mf-multipart';
import { extract3MFEmbeddedThumbnail } from './three-mf-fast-path';

/**
 * Signals that a 3MF couldn't be rendered as live 3D — the renderer should
 * fall back to displaying the slicer-embedded PNG preview (when present).
 */
export class ThreeMFEmbeddedOnlyError extends Error {
  readonly png: Uint8Array | null;
  constructor(message: string, png: Uint8Array | null) {
    super(message);
    this.name = 'ThreeMFEmbeddedOnlyError';
    this.png = png;
  }
}

/**
 * Pure loaders: take the file's bytes, return a renderable Object3D. No
 * filesystem or fetch IO — callers (thumb worker / in-UI viewer) are
 * responsible for delivering bytes through whatever transport works in
 * their context.
 *
 * Orientation is applied here so every consumer gets a consistently
 * upright model. Caller may pass an override; otherwise the format default
 * (e.g. STL/3MF → +Z up) is used.
 */
export async function loadModel(
  buffer: ArrayBuffer,
  ext: string,
  resourcePath = '',
  orientation?: FileOrientation,
  resolveResource?: (uri: string) => string
): Promise<THREE.Object3D> {
  let obj: THREE.Object3D;
  switch (ext) {
    case 'glb':
    case 'gltf':
      obj = await loadGLTF(buffer, resourcePath, resolveResource);
      break;
    case 'obj':
      obj = loadOBJ(buffer);
      break;
    case 'stl':
      obj = loadSTL(buffer);
      break;
    case 'ply':
      obj = loadPLY(buffer);
      break;
    case '3mf':
      obj = loadThreeMF(buffer);
      break;
    default:
      throw new Error(`Can't preview .${ext} files.`);
  }
  applyOrientation(obj, orientation ?? getDefaultOrientation(ext));
  // A mesh with NaN/Infinity vertices (corrupt or truncated file) loads
  // without throwing but poisons everything downstream: the camera frames
  // to NaN and the thumb worker caches a black render as a success. Fail
  // loudly instead so the failure is recorded and retried like any other.
  const box = new THREE.Box3().setFromObject(obj);
  if (!box.isEmpty()) {
    const finite =
      Number.isFinite(box.min.x + box.min.y + box.min.z) &&
      Number.isFinite(box.max.x + box.max.y + box.max.z);
    if (!finite) {
      disposeObject(obj);
      throw new Error('This file contains invalid geometry and appears to be corrupt.');
    }
  }
  return obj;
}

function loadGLTF(buffer: ArrayBuffer, resourcePath: string, resolveResource?: (uri: string) => string): Promise<THREE.Object3D> {
  return new Promise((resolve, reject) => {
    const manager = new THREE.LoadingManager();
    if (resolveResource) manager.setURLModifier(resolveResource);
    const loader = new GLTFLoader(manager);
    loader.parse(
      buffer,
      resourcePath,
      (gltf) => resolve(gltf.scene),
      (err) => reject(err instanceof Error ? err : new Error(String(err)))
    );
  });
}

function loadOBJ(buffer: ArrayBuffer): THREE.Object3D {
  const text = new TextDecoder().decode(buffer);
  const loader = new OBJLoader();
  const obj = loader.parse(text);
  applyDefaultMaterial(obj);
  return obj;
}

function loadSTL(buffer: ArrayBuffer): THREE.Mesh {
  // Binary STL declares its face count in the header, and STLLoader allocates
  // arrays for that count before reading any data. Validate the declared
  // count against the actual byte length first, or a truncated/crafted file
  // can trigger a multi-GB allocation before it fails.
  if (isBinarySTL(buffer)) {
    const faces = new DataView(buffer).getUint32(80, true);
    if (84 + faces * 50 > buffer.byteLength) {
      throw new Error('This STL is truncated or corrupt.');
    }
  }
  const loader = new STLLoader();
  const geom = loader.parse(buffer);
  if (!geom.hasAttribute('normal')) geom.computeVertexNormals();
  return new THREE.Mesh(geom, neutralMaterial());
}

/** Mirrors STLLoader's own binary detection: an ASCII STL starts with "solid". */
function isBinarySTL(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 84) return false;
  const head = new Uint8Array(buffer, 0, 5);
  const solid = [0x73, 0x6f, 0x6c, 0x69, 0x64]; // "solid"
  return !solid.every((c, i) => head[i] === c);
}

function loadPLY(buffer: ArrayBuffer): THREE.Mesh {
  const loader = new PLYLoader();
  const geom = loader.parse(buffer);
  if (!geom.hasAttribute('normal')) geom.computeVertexNormals();
  const mat = geom.hasAttribute('color')
    ? new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.05, roughness: 0.7 })
    : neutralMaterial();
  return new THREE.Mesh(geom, mat);
}

function loadThreeMF(buffer: ArrayBuffer): THREE.Object3D {
  // Slicer-exported 3MFs (Bambu/Prusa/Orca) use the Production Extension
  // which splits the mesh into sub-`.model` parts referenced via
  // `<component p:path>`. Stock ThreeMFLoader can't follow those, so we
  // pre-process the zip (reorder parts so referenced ones are decoded
  // first) and short-circuit huge files to the embedded PNG fallback.
  const inspection = inspectThreeMF(buffer);
  if (inspection.kind === 'too-large') {
    throw new ThreeMFEmbeddedOnlyError(
      'This 3MF is too big to preview in 3D.',
      inspection.embeddedPng
    );
  }
  const input = inspection.kind === 'rewritten' ? inspection.buffer : buffer;
  const loader = new ThreeMFLoader();
  let obj: THREE.Object3D;
  try {
    obj = loader.parse(input) as THREE.Object3D;
  } catch (err) {
    // Any remaining parse failure (e.g. unsupported extension on a smaller
    // multi-part 3MF) → fall back to the embedded PNG rather than showing
    // the cryptic loader error.
    throw new ThreeMFEmbeddedOnlyError(
      (err as Error).message || "Couldn't read this 3MF. The file may be corrupt.",
      // Re-extract from the original buffer; the rewritten one drops nothing
      // but it's cheaper to scan the original we already have in hand.
      extract3MFEmbeddedThumbnail(buffer)
    );
  }
  applyDefaultMaterial(obj);
  return obj;
}

function neutralMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0xb0b3b8, metalness: 0.05, roughness: 0.65 });
}

/**
 * Replaces materials that are obviously placeholder defaults (e.g. OBJLoader's
 * MeshPhongMaterial with white) so the thumbnail looks consistent across
 * formats. We keep any material that already has a texture map.
 */
function applyDefaultMaterial(obj: THREE.Object3D): void {
  const fallback = neutralMaterial();
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material;
    const isVanillaWhite = (m: THREE.Material) =>
      (m as THREE.MeshBasicMaterial).map == null &&
      ((m as THREE.MeshPhongMaterial).color?.equals(new THREE.Color(0xffffff)) ?? false);
    if (Array.isArray(mat)) {
      mesh.material = mat.map((m) => (isVanillaWhite(m) ? fallback : m));
    } else if (mat && isVanillaWhite(mat)) {
      mesh.material = fallback;
    }
    if (mesh.geometry && !mesh.geometry.hasAttribute('normal')) {
      mesh.geometry.computeVertexNormals();
    }
  });
}

/** Free all GPU resources owned by an object subtree. Idempotent. */
export function disposeObject(obj: THREE.Object3D): void {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();
  const disposedTextures = new Set<THREE.Texture>();
  const closedBitmaps = new Set<ImageBitmap>();
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry && !disposedGeometries.has(mesh.geometry)) {
      disposedGeometries.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    const mats: THREE.Material[] = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : [];
    for (const m of mats) {
      if (disposedMaterials.has(m)) continue;
      disposedMaterials.add(m);
      for (const v of Object.values(m)) {
        const texture = v as THREE.Texture;
        if (!v || !texture.isTexture || disposedTextures.has(texture)) continue;
        disposedTextures.add(texture);
        const image = texture.image;
        if (
          typeof ImageBitmap !== 'undefined' &&
          image instanceof ImageBitmap &&
          !closedBitmaps.has(image)
        ) {
          closedBitmaps.add(image);
          image.close();
        }
        texture.dispose();
      }
      m.dispose();
    }
  });
}
