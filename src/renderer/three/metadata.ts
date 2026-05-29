import * as THREE from 'three';
import type { ExtractedMetadata, MeshValidation, TextureInfo } from '@shared/types';

const MAX_MATERIAL_NAMES = 32;
const MAX_TEXTURE_RECORDS = 32;

/**
 * PBR-style slots we look for on each material. Order matches the typical
 * visual stack so the metadata pane displays them in a sensible order.
 */
const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'displacementMap',
  'specularMap',
  'alphaMap',
  'envMap',
  'bumpMap'
] as const;

/**
 * Walk a loaded Object3D and aggregate searchable / display metadata. Pure
 * read of Three.js geometry/material state — no IO. Called by the thumbnail
 * worker right before disposing the scene.
 */
export function extractMetadata(
  obj: THREE.Object3D,
  thumbSource: 'gl' | '3mf-embedded',
  validation?: MeshValidation,
  meshVolumeMm3?: number | null
): ExtractedMetadata {
  let vertexCount = 0;
  let triangleCount = 0;
  let meshCount = 0;
  let hasTextures = false;
  const materialNames = new Set<string>();
  // Dedupe textures by (role, name) — a single texture often appears on
  // multiple meshes of a model and there's no need to list it twice.
  const textureKeys = new Set<string>();
  const textures: TextureInfo[] = [];

  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!(mesh as THREE.Object3D).type || !(mesh as THREE.Mesh).isMesh) return;
    if (!mesh.geometry) return;

    meshCount++;
    const posAttr = mesh.geometry.getAttribute('position');
    if (posAttr) vertexCount += posAttr.count;

    const idx = mesh.geometry.getIndex();
    if (idx) triangleCount += Math.floor(idx.count / 3);
    else if (posAttr) triangleCount += Math.floor(posAttr.count / 3);

    const mats: THREE.Material[] = Array.isArray(mesh.material)
      ? (mesh.material as THREE.Material[])
      : mesh.material
        ? [mesh.material as THREE.Material]
        : [];
    for (const m of mats) {
      const label = m.name?.trim() || `<${m.type}>`;
      if (materialNames.size < MAX_MATERIAL_NAMES) materialNames.add(label);
      for (const slot of TEXTURE_SLOTS) {
        const tex = (m as unknown as Record<string, unknown>)[slot];
        if (!tex || !(tex as THREE.Texture).isTexture) continue;
        hasTextures = true;
        if (textures.length >= MAX_TEXTURE_RECORDS) continue;
        const t = tex as THREE.Texture;
        const name =
          (t.name?.trim() && t.name.trim()) ||
          textureSourceName(t) ||
          '<unnamed>';
        const key = `${slot}:${name}`;
        if (textureKeys.has(key)) continue;
        textureKeys.add(key);
        textures.push({ role: slot, name });
      }
    }
  });

  const box = new THREE.Box3().setFromObject(obj);
  const isEmpty = box.isEmpty();
  const size = new THREE.Vector3();
  if (!isEmpty) box.getSize(size);

  return {
    vertexCount,
    triangleCount,
    meshCount,
    materialCount: materialNames.size,
    hasTextures,
    boundingBox: {
      min: isEmpty ? [0, 0, 0] : [box.min.x, box.min.y, box.min.z],
      max: isEmpty ? [0, 0, 0] : [box.max.x, box.max.y, box.max.z],
      size: [size.x, size.y, size.z]
    },
    thumbSource,
    materialNames: [...materialNames],
    validation,
    textures: textures.length > 0 ? textures : undefined,
    meshVolumeMm3: meshVolumeMm3 == null ? undefined : meshVolumeMm3
  };
}

/**
 * Best-effort name extraction from a Three.Texture. glTF loaders set
 * `texture.name` from the glTF asset, but other loaders / formats only set
 * `image.src` or `image.name`. We fall back through the common shapes.
 */
function textureSourceName(t: THREE.Texture): string | null {
  const src = (t.image as { src?: string; name?: string } | undefined) ?? undefined;
  if (!src) return null;
  if (typeof src.name === 'string' && src.name.length > 0) return src.name;
  if (typeof src.src === 'string' && src.src.length > 0) {
    // Strip data: URIs to just "<inline N bytes>" so we don't blow up the row.
    if (src.src.startsWith('data:')) {
      const idx = src.src.indexOf(',');
      return `<inline ${idx > 0 ? src.src.length - idx : src.src.length}B>`;
    }
    // Last path segment.
    const slash = src.src.lastIndexOf('/');
    return slash < 0 ? src.src : src.src.slice(slash + 1);
  }
  return null;
}

/** Stub used when we serve a 3MF embedded thumbnail without loading meshes. */
export function thumbnailOnlyMetadata(thumbSource: 'gl' | '3mf-embedded'): ExtractedMetadata {
  return {
    vertexCount: 0,
    triangleCount: 0,
    meshCount: 0,
    materialCount: 0,
    hasTextures: false,
    boundingBox: { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] },
    thumbSource,
    materialNames: []
  };
}
