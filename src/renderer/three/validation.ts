import * as THREE from 'three';
import type { MeshValidation } from '@shared/types';

const MAX_TRIANGLES_FOR_VALIDATION = 500_000;

/**
 * Lightweight watertight / degenerate-triangle check. Walks every mesh in
 * the scene, accumulates edge-half-counts, and reports whether every edge is
 * shared by exactly two triangles. Skipped for very large meshes — the
 * O(triangles) hashing dominates render time otherwise.
 *
 * Indexed geometry only: non-indexed (every vertex inlined per-triangle) is
 * almost always artist-export output where every triangle has its own
 * vertices and watertightness is meaningless. We report `skipped: non-indexed`
 * and let the UI surface "n/a" rather than misleading "leaky".
 */
export function validateScene(obj: THREE.Object3D): MeshValidation {
  let edgeMap: Map<string, number> | null = null;
  let degenerateTriangles = 0;
  let totalTriangles = 0;
  let sawIndexed = false;
  let sawNonIndexed = false;

  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!(mesh as THREE.Object3D).type || !mesh.isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom) return;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const idx = geom.getIndex();
    const triCount = idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
    totalTriangles += triCount;
  });

  if (totalTriangles === 0) {
    return { isWatertight: null, degenerateTriangles: 0, skipped: 'no-position' };
  }
  if (totalTriangles > MAX_TRIANGLES_FOR_VALIDATION) {
    return { isWatertight: null, degenerateTriangles: 0, skipped: 'too-large' };
  }

  edgeMap = new Map();

  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!(mesh as THREE.Object3D).type || !mesh.isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom) return;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const idx = geom.getIndex();
    if (!idx) {
      sawNonIndexed = true;
      return;
    }
    sawIndexed = true;

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const cross = new THREE.Vector3();
    for (let i = 0; i < idx.count; i += 3) {
      const ia = idx.getX(i);
      const ib = idx.getX(i + 1);
      const ic = idx.getX(i + 2);
      a.fromBufferAttribute(pos, ia);
      b.fromBufferAttribute(pos, ib);
      c.fromBufferAttribute(pos, ic);
      // Degenerate area check via 0.5 * |cross|; we just compare cross magnitude.
      cross.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      if (cross.lengthSq() < 1e-12) degenerateTriangles++;
      addEdge(edgeMap!, ia, ib);
      addEdge(edgeMap!, ib, ic);
      addEdge(edgeMap!, ic, ia);
    }
  });

  if (sawNonIndexed && !sawIndexed) {
    return { isWatertight: null, degenerateTriangles, skipped: 'non-indexed' };
  }

  let watertight = true;
  for (const count of edgeMap.values()) {
    if (count !== 2) {
      watertight = false;
      break;
    }
  }
  return { isWatertight: watertight, degenerateTriangles };
}

function addEdge(map: Map<string, number>, a: number, b: number): void {
  // Canonicalize so (a,b) and (b,a) hash the same.
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  map.set(key, (map.get(key) ?? 0) + 1);
}

const MAX_TRIANGLES_FOR_VOLUME = MAX_TRIANGLES_FOR_VALIDATION;

/**
 * Signed-tetrahedron mesh volume. For each triangle (a, b, c), contributes
 * `(a · (b × c)) / 6` to the total — a closed manifold mesh sums to its
 * enclosed volume regardless of triangle order. Non-watertight meshes give
 * an approximate (sometimes negative) number; we `abs()` the final result
 * because callers want a magnitude.
 *
 * Vertices are transformed to world space so multi-mesh objects (typical
 * 3MFs with translated parts) sum correctly. Units match the geometry input
 * (mm for STL/3MF in the meshFlask convention).
 *
 * Returns null when no usable mesh is found or the total triangle count is
 * over the same cap that `validateScene` uses, so the worker stays bounded.
 */
export function computeMeshVolume(obj: THREE.Object3D): number | null {
  let totalTriangles = 0;
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!(mesh as THREE.Object3D).type || !mesh.isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom) return;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const idx = geom.getIndex();
    totalTriangles += idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
  });
  if (totalTriangles === 0 || totalTriangles > MAX_TRIANGLES_FOR_VOLUME) return null;

  obj.updateWorldMatrix(true, true);
  let signedSixVolume = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const bxc = new THREE.Vector3();

  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!(mesh as THREE.Object3D).type || !mesh.isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom) return;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const idx = geom.getIndex();
    const m = mesh.matrixWorld;

    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        a.fromBufferAttribute(pos, idx.getX(i)).applyMatrix4(m);
        b.fromBufferAttribute(pos, idx.getX(i + 1)).applyMatrix4(m);
        c.fromBufferAttribute(pos, idx.getX(i + 2)).applyMatrix4(m);
        bxc.crossVectors(b, c);
        signedSixVolume += a.dot(bxc);
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        a.fromBufferAttribute(pos, i).applyMatrix4(m);
        b.fromBufferAttribute(pos, i + 1).applyMatrix4(m);
        c.fromBufferAttribute(pos, i + 2).applyMatrix4(m);
        bxc.crossVectors(b, c);
        signedSixVolume += a.dot(bxc);
      }
    }
  });

  return Math.abs(signedSixVolume) / 6;
}
