import * as THREE from 'three';
import type { MeshValidation } from '@shared/types';

const MAX_TRIANGLES_FOR_ANALYSIS = 500_000;

export interface GeometryAnalysis {
  validation: MeshValidation;
  /**
   * Signed-tetrahedron mesh volume: per mesh, each triangle (a, b, c)
   * contributes `(a · (b × c)) / 6`; a closed manifold sums to its enclosed
   * volume regardless of triangle order. The per-mesh sums are abs'd before
   * totalling so a mirrored part (negative-determinant transform, legal in
   * glTF) can't cancel its twin. Vertices are transformed to world space so
   * multi-mesh objects (typical 3MFs with translated parts) sum correctly;
   * units match the geometry input (mm for STL/3MF in the meshFlask
   * convention). Null when no usable mesh exists or the scene is over the
   * triangle cap.
   */
  meshVolumeMm3: number | null;
}

/**
 * Single-pass geometry analysis: watertightness, degenerate-triangle count,
 * and mesh volume in one walk over every triangle. These used to be separate
 * full passes; on a 500k-triangle mesh that tripled the per-thumbnail
 * geometry cost in the worker.
 *
 * Watertightness walks per-mesh edge counts (indices are mesh-local, so a
 * shared map would collide across meshes) and reports watertight iff every
 * edge of every indexed mesh is shared by exactly two triangles. Non-indexed
 * geometry (every vertex inlined per-triangle) is almost always artist-export
 * output where watertightness is meaningless — those meshes still count
 * toward volume but are skipped for validation, and a scene with ONLY
 * non-indexed meshes reports `skipped: 'non-indexed'`.
 *
 * Skipped entirely for very large scenes — the O(triangles) hashing would
 * dominate render time.
 */
export function analyzeGeometry(obj: THREE.Object3D): GeometryAnalysis {
  let totalTriangles = 0;
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom) return;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const idx = geom.getIndex();
    totalTriangles += idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
  });

  if (totalTriangles === 0) {
    return {
      validation: { isWatertight: null, degenerateTriangles: 0, skipped: 'no-position' },
      meshVolumeMm3: null
    };
  }
  if (totalTriangles > MAX_TRIANGLES_FOR_ANALYSIS) {
    return {
      validation: { isWatertight: null, degenerateTriangles: 0, skipped: 'too-large' },
      meshVolumeMm3: null
    };
  }

  obj.updateWorldMatrix(true, true);

  let degenerateTriangles = 0;
  let sawIndexed = false;
  let sawNonIndexed = false;
  let watertight = true;
  let totalSixVolume = 0;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();
  const wa = new THREE.Vector3();
  const wb = new THREE.Vector3();
  const wc = new THREE.Vector3();
  const bxc = new THREE.Vector3();

  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom) return;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const idx = geom.getIndex();
    const m = mesh.matrixWorld;
    let meshSixVolume = 0;

    if (idx) {
      sawIndexed = true;
      const edgeMap = new Map<string, number>();
      for (let i = 0; i < idx.count; i += 3) {
        const ia = idx.getX(i);
        const ib = idx.getX(i + 1);
        const ic = idx.getX(i + 2);
        a.fromBufferAttribute(pos, ia);
        b.fromBufferAttribute(pos, ib);
        c.fromBufferAttribute(pos, ic);
        // Degenerate area check via 0.5 * |cross|, in local coordinates.
        cross.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
        if (cross.lengthSq() < 1e-12) degenerateTriangles++;
        addEdge(edgeMap, ia, ib);
        addEdge(edgeMap, ib, ic);
        addEdge(edgeMap, ic, ia);
        // Volume term in world coordinates.
        wa.copy(a).applyMatrix4(m);
        wb.copy(b).applyMatrix4(m);
        wc.copy(c).applyMatrix4(m);
        meshSixVolume += wa.dot(bxc.crossVectors(wb, wc));
      }
      for (const count of edgeMap.values()) {
        if (count !== 2) {
          watertight = false;
          break;
        }
      }
    } else {
      sawNonIndexed = true;
      for (let i = 0; i < pos.count; i += 3) {
        wa.fromBufferAttribute(pos, i).applyMatrix4(m);
        wb.fromBufferAttribute(pos, i + 1).applyMatrix4(m);
        wc.fromBufferAttribute(pos, i + 2).applyMatrix4(m);
        meshSixVolume += wa.dot(bxc.crossVectors(wb, wc));
      }
    }
    totalSixVolume += Math.abs(meshSixVolume);
  });

  const meshVolumeMm3 = totalSixVolume / 6;
  if (sawNonIndexed && !sawIndexed) {
    return {
      validation: { isWatertight: null, degenerateTriangles, skipped: 'non-indexed' },
      meshVolumeMm3
    };
  }
  return {
    validation: { isWatertight: watertight, degenerateTriangles },
    meshVolumeMm3
  };
}

function addEdge(map: Map<string, number>, a: number, b: number): void {
  // Canonicalize so (a,b) and (b,a) hash the same.
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Watertight / degenerate-triangle check. Thin wrapper over analyzeGeometry. */
export function validateScene(obj: THREE.Object3D): MeshValidation {
  return analyzeGeometry(obj).validation;
}

/** Mesh volume in mm³ (or null). Thin wrapper over analyzeGeometry. */
export function computeMeshVolume(obj: THREE.Object3D): number | null {
  return analyzeGeometry(obj).meshVolumeMm3;
}
