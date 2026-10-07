/**
 * Per-file orientation override. The model is rotated on load so that its
 * `upAxis` (in model coordinates) ends up pointing at world +Y, matching
 * Three.js's scene convention. Default per file format is computed via
 * `getDefaultOrientation` — STL and 3MF default to +Z up (the 3D-printing
 * convention) so those files render upright without any user action.
 */
export type UpAxis = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

/**
 * Rotation in degrees around the world-up axis, applied AFTER upAxis
 * correction. Constrained to `YAW_STEP_DEG` increments in `[0, 360)`.
 */
export type Yaw = number;

/** Granularity of yaw rotation. UI buttons step by this amount. */
export const YAW_STEP_DEG = 15;

export interface FileOrientation {
  upAxis: UpAxis;
  /** Optional for back-compat with rows written before yaw existed; default 0. */
  yaw?: Yaw;
}

/** Stored as JSON in `files.orientation_json`. Bumping requires a migration. */

const DEFAULTS_BY_EXT: Record<string, FileOrientation> = {
  stl: { upAxis: '+Z' },
  '3mf': { upAxis: '+Z' },
  obj: { upAxis: '+Y' },
  ply: { upAxis: '+Y' },
  glb: { upAxis: '+Y' },
  gltf: { upAxis: '+Y' }
};

export function getDefaultOrientation(ext: string): FileOrientation {
  return DEFAULTS_BY_EXT[ext.toLowerCase()] ?? { upAxis: '+Y' };
}

export const UP_AXIS_OPTIONS: readonly { value: UpAxis; label: string }[] = [
  { value: '+X', label: '+X' },
  { value: '-X', label: '-X' },
  { value: '+Y', label: '+Y' },
  { value: '-Y', label: '-Y' },
  { value: '+Z', label: '+Z' },
  { value: '-Z', label: '-Z' }
];

const UP_AXIS_SET: ReadonlySet<UpAxis> = new Set([
  '+X',
  '-X',
  '+Y',
  '-Y',
  '+Z',
  '-Z'
]);

export function isUpAxis(value: unknown): value is UpAxis {
  return typeof value === 'string' && UP_AXIS_SET.has(value as UpAxis);
}

export function isYaw(value: unknown): value is Yaw {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value < 360 &&
    value % YAW_STEP_DEG === 0
  );
}

export function isFileOrientation(value: unknown): value is FileOrientation {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { upAxis?: unknown; yaw?: unknown };
  if (!isUpAxis(v.upAxis)) return false;
  if (v.yaw !== undefined && !isYaw(v.yaw)) return false;
  return true;
}

export function getYaw(orientation: FileOrientation): Yaw {
  return orientation.yaw ?? 0;
}

export function orientationEquals(a: FileOrientation, b: FileOrientation): boolean {
  return a.upAxis === b.upAxis && getYaw(a) === getYaw(b);
}

export function isDefaultOrientation(orientation: FileOrientation, ext: string): boolean {
  return orientationEquals(orientation, getDefaultOrientation(ext));
}

/**
 * Add a degree delta to yaw. Result is wrapped into `[0, 360)` and snapped
 * to the nearest `YAW_STEP_DEG` increment so floating-point drift can't
 * push the stored value off-grid.
 */
export function rotateYaw(current: Yaw, deltaDeg: number): Yaw {
  const sum = ((current + deltaDeg) % 360 + 360) % 360;
  return (Math.round(sum / YAW_STEP_DEG) * YAW_STEP_DEG) % 360;
}
