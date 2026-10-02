/**
 * 3D-preview rendering quality presets.
 *
 * Tiers off two main axes:
 *   - shadow casting (off / hard / soft) — biggest visual jump, biggest cost
 *   - texture / env-map sharpness (anisotropy + PMREM roughness)
 *
 * Low matches the renderer's historical default (no shadows, default
 * anisotropy, slightly blurred env reflections) so existing thumbnails and
 * the offline thumbnail worker keep producing identical output.
 */

export const RENDER_QUALITY_IDS = ['low', 'medium', 'high', 'ultra'] as const;
export type RenderQuality = (typeof RENDER_QUALITY_IDS)[number];

export const DEFAULT_RENDER_QUALITY: RenderQuality = 'low';

export type ShadowFilter = 'basic' | 'pcf' | 'pcfsoft';

export interface RenderQualityPreset {
  id: RenderQuality;
  label: string;
  description: string;
  shadows: {
    enabled: boolean;
    /** 'basic' = hard, fastest. 'pcf' / 'pcfsoft' = increasingly soft. */
    filter: ShadowFilter;
    /** Shadow map texture size — bigger = sharper at higher GPU cost. */
    mapSize: number;
  };
  /** Anisotropic filtering applied to loaded textures. 1 disables it. */
  anisotropy: number;
  /**
   * PMREM blur amount when baking the env map. 0 = no blur (sharpest
   * reflections, slowest bake); higher = blurrier. The historical value was
   * 0.04, which Low preserves.
   */
  envMapRoughness: number;
}

export const LOW_PRESET: RenderQualityPreset = {
  id: 'low',
  label: 'Low',
  description: 'No shadows, soft reflections. The fastest option.',
  shadows: { enabled: false, filter: 'basic', mapSize: 0 },
  anisotropy: 1,
  envMapRoughness: 0.04
};

export const MEDIUM_PRESET: RenderQualityPreset = {
  id: 'medium',
  label: 'Medium',
  description: 'Hard shadows and sharper textures.',
  shadows: { enabled: true, filter: 'basic', mapSize: 1024 },
  anisotropy: 4,
  envMapRoughness: 0.04
};

export const HIGH_PRESET: RenderQualityPreset = {
  id: 'high',
  label: 'High',
  description: 'Soft shadows and crisper reflections.',
  shadows: { enabled: true, filter: 'pcfsoft', mapSize: 2048 },
  anisotropy: 8,
  envMapRoughness: 0.02
};

export const ULTRA_PRESET: RenderQualityPreset = {
  id: 'ultra',
  label: 'Ultra',
  description: 'Maximum detail. Hardest on your GPU.',
  shadows: { enabled: true, filter: 'pcfsoft', mapSize: 4096 },
  anisotropy: 16,
  envMapRoughness: 0.005
};

export const RENDER_QUALITY_PRESETS: readonly RenderQualityPreset[] = [
  LOW_PRESET,
  MEDIUM_PRESET,
  HIGH_PRESET,
  ULTRA_PRESET
];

const BY_ID: Record<RenderQuality, RenderQualityPreset> = {
  low: LOW_PRESET,
  medium: MEDIUM_PRESET,
  high: HIGH_PRESET,
  ultra: ULTRA_PRESET
};

export function getRenderQualityPreset(id: RenderQuality): RenderQualityPreset {
  // Fall back to Low for unknown ids — prefs are hand-editable JSON, and an
  // unrecognized value would otherwise crash the viewer on every file.
  return BY_ID[id] ?? LOW_PRESET;
}

export function isRenderQuality(value: unknown): value is RenderQuality {
  return typeof value === 'string' && (RENDER_QUALITY_IDS as readonly string[]).includes(value);
}
