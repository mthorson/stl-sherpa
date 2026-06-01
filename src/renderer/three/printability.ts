import * as THREE from 'three';
import type { MeshValidation, PrintabilityReport } from '@shared/types';

// Mirror the validation cap: overhang scanning is O(triangles) and we don't
// want to blow the render budget on pathological meshes.
const MAX_TRIANGLES_FOR_PRINTABILITY = 500_000;

/**
 * Triangles whose downward-facing normal tilts past this angle from vertical
 * need support on an FDM printer. 45° is the conventional rule-of-thumb cutoff
 * most slicers default to.
 */
const OVERHANG_ANGLE_DEG = 45;

/**
 * Below this fraction of the model's largest dimension, the smallest bounding
 * extent is treated as a thin wall / fragile feature that hurts printability.
 * Heuristic only — we have no true wall-thickness analysis, so we use the
 * overall slab-likeness of the bounding box as a cheap proxy.
 */
const THIN_WALL_RATIO = 0.02;

interface OverhangScan {
  /** Fraction (0..1) of downward-facing area that exceeds the overhang angle. */
  overhangArea: number;
  /** Total surface area considered (world units²). */
  totalArea: number;
  /** True when no usable geometry was found / the scan was skipped. */
  skipped: boolean;
}

/**
 * Accumulate the share of surface area that would print as an unsupported
 * overhang. World-space triangles are used so multi-part objects with their
 * own transforms contribute correctly. We weight by triangle area rather than
 * count so a few huge overhanging facets aren't drowned out by many tiny ones.
 */
function scanOverhangs(obj: THREE.Object3D): OverhangScan {
  let totalTriangles = 0;
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!(mesh as THREE.Object3D).type || !mesh.isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    const pos = geom?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const idx = geom!.getIndex();
    totalTriangles += idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
  });
  if (totalTriangles === 0 || totalTriangles > MAX_TRIANGLES_FOR_PRINTABILITY) {
    return { overhangArea: 0, totalArea: 0, skipped: true };
  }

  obj.updateWorldMatrix(true, true);
  const cosCutoff = Math.cos(THREE.MathUtils.degToRad(180 - OVERHANG_ANGLE_DEG));
  const up = new THREE.Vector3(0, 1, 0);
  let overhangArea = 0;
  let totalArea = 0;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();

  const accumulate = () => {
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    cross.crossVectors(ab, ac);
    const area = cross.length() * 0.5;
    if (area === 0) return;
    totalArea += area;
    // Face normal points along the cross product; compare against +Y. A normal
    // pointing down (toward -Y) past the cutoff means the underside faces away
    // from the build direction and needs support.
    const dot = cross.dot(up) / cross.length();
    if (dot <= cosCutoff) overhangArea += area;
  };

  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!(mesh as THREE.Object3D).type || !mesh.isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    const pos = geom?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const m = mesh.matrixWorld;
    const idx = geom!.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        a.fromBufferAttribute(pos, idx.getX(i)).applyMatrix4(m);
        b.fromBufferAttribute(pos, idx.getX(i + 1)).applyMatrix4(m);
        c.fromBufferAttribute(pos, idx.getX(i + 2)).applyMatrix4(m);
        accumulate();
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        a.fromBufferAttribute(pos, i).applyMatrix4(m);
        b.fromBufferAttribute(pos, i + 1).applyMatrix4(m);
        c.fromBufferAttribute(pos, i + 2).applyMatrix4(m);
        accumulate();
      }
    }
  });

  return {
    overhangArea,
    totalArea,
    skipped: totalArea === 0
  };
}

/**
 * Slab-likeness from the bounding box: the smallest extent relative to the
 * largest. A model whose thinnest dimension is a sliver of its largest is
 * fragile / fiddly to print. Returns null when the box is degenerate.
 */
function thinWallRatio(size: [number, number, number]): number | null {
  const [x, y, z] = size;
  const max = Math.max(x, y, z);
  const min = Math.min(x, y, z);
  if (max <= 0) return null;
  return min / max;
}

/**
 * Combine watertightness, overhang share, and the thin-wall proxy into a single
 * 0..100 printability score plus the contributing factors. Pure — takes only
 * the already-computed inputs so it can be unit-tested without Three.js.
 *
 * The weighting is deliberately simple and explained inline; this is a rough
 * "is this likely to print cleanly?" hint, not a slicer-grade analysis.
 */
export function scorePrintability(input: {
  isWatertight: boolean | null;
  overhangFraction: number | null;
  minMaxRatio: number | null;
}): PrintabilityReport {
  const { isWatertight, overhangFraction, minMaxRatio } = input;

  // Start from a perfect score and deduct for each problem. Unknown factors
  // (null) are treated as neutral so we never over-penalize a skipped check.
  let score = 100;
  const factors: string[] = [];

  if (isWatertight === false) {
    score -= 40;
    factors.push('not watertight');
  } else if (isWatertight === null) {
    factors.push('watertightness unknown');
  }

  if (overhangFraction != null) {
    // Up to 35 points off, scaling linearly with overhanging surface area.
    const penalty = Math.round(Math.min(1, overhangFraction) * 35);
    score -= penalty;
    if (overhangFraction >= 0.15) {
      factors.push(`${Math.round(overhangFraction * 100)}% overhangs (supports likely)`);
    }
  }

  if (minMaxRatio != null && minMaxRatio < THIN_WALL_RATIO) {
    score -= 15;
    factors.push('thin / slab-like geometry');
  }

  score = Math.max(0, Math.min(100, score));

  let rating: PrintabilityReport['rating'];
  if (score >= 80) rating = 'good';
  else if (score >= 50) rating = 'fair';
  else rating = 'poor';

  return { score, rating, factors };
}

/**
 * Full printability pass over a loaded scene: scans overhangs, reads the
 * bounding box for the thin-wall proxy, and folds in the watertight result.
 * Returns null when there's nothing usable to score.
 */
export function computePrintability(
  obj: THREE.Object3D,
  validation: MeshValidation
): PrintabilityReport | null {
  const overhang = scanOverhangs(obj);

  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty() && overhang.skipped) return null;
  const size = new THREE.Vector3();
  box.getSize(size);

  return scorePrintability({
    isWatertight: validation.isWatertight,
    overhangFraction:
      overhang.skipped || overhang.totalArea === 0
        ? null
        : overhang.overhangArea / overhang.totalArea,
    minMaxRatio: box.isEmpty() ? null : thinWallRatio([size.x, size.y, size.z])
  });
}
