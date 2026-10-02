import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { LightingStyle } from '@shared/lighting-types';
import {
  DEFAULT_RENDER_QUALITY,
  getRenderQualityPreset,
  type RenderQuality,
  type RenderQualityPreset
} from '@shared/render-quality';
import { getLightingPreset, type LightingPresetDefinition } from './lighting-presets';

export { DEFAULT_LIGHTING_STYLE, type LightingStyle } from '@shared/lighting-types';
export { LIGHTING_PRESETS, type LightingPresetDefinition } from './lighting-presets';

/**
 * Generic applier of LightingPresetDefinitions. Knows nothing about specific
 * presets; tweaks happen in `lighting-presets.ts` as pure data.
 *
 * Lights live under a single Group so swapping presets is a clear/re-add of
 * one subtree; the PMREM-generated env map is owned here too so it gets
 * disposed alongside.
 *
 * Quality-tier-aware: when the active `RenderQualityPreset` enables shadows,
 * the FIRST directional in the lighting preset becomes the shadow caster.
 * `fitToModel(box)` must be called after loading a model so the shadow
 * camera + light distance match the model's actual scale — without that
 * step, shadows would be wildly miscalibrated for non-unit-sized geometry.
 */
export class LightingRig {
  private group = new THREE.Group();
  private envMap: THREE.Texture | null = null;
  private currentStyle: LightingStyle | null = null;
  private currentQualityId: RenderQuality | null = null;
  private readonly pmrem: THREE.PMREMGenerator;
  /** Set by applyDefinition; consumed by fitToModel to scale shadow camera. */
  private shadowKey: THREE.DirectionalLight | null = null;
  private quality: RenderQualityPreset = getRenderQualityPreset(DEFAULT_RENDER_QUALITY);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer
  ) {
    this.group.name = 'wh3d-lighting';
    scene.add(this.group);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    // fromScene renders a cubemap, so precompile the cubemap variant (the
    // equirectangular one is for fromEquirectangular and never runs here).
    this.pmrem.compileCubemapShader();
    // ACES Filmic globally — preset intensities below are tuned against it.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
  }

  apply(style: LightingStyle, quality?: RenderQualityPreset): void {
    const nextQuality = quality ?? this.quality;
    if (this.currentStyle === style && this.currentQualityId === nextQuality.id) return;
    this.currentStyle = style;
    this.currentQualityId = nextQuality.id;
    this.quality = nextQuality;
    this.applyDefinition(getLightingPreset(style));
  }

  /**
   * Apply a definition directly. Useful for live-tweaking presets in dev or
   * for tests that don't want to register a new ID just to try a variant.
   */
  applyDefinition(def: LightingPresetDefinition): void {
    this.clear();
    this.renderer.toneMappingExposure = def.exposure;
    this.scene.background = null;

    if (def.environmentIntensity > 0) {
      const room = new RoomEnvironment();
      this.envMap = this.pmrem.fromScene(room, this.quality.envMapRoughness).texture;
      // The bake copies what it needs into the PMREM texture; the room scene's
      // own geometries/materials must be freed or they pile up per bake.
      room.dispose();
      this.scene.environment = this.envMap;
      this.scene.environmentIntensity = def.environmentIntensity;
    }

    if (def.ambient) {
      this.group.add(new THREE.AmbientLight(def.ambient.color, def.ambient.intensity));
    }
    if (def.hemisphere) {
      this.group.add(
        new THREE.HemisphereLight(
          def.hemisphere.skyColor,
          def.hemisphere.groundColor,
          def.hemisphere.intensity
        )
      );
    }
    if (def.directionals) {
      def.directionals.forEach((d, i) => {
        const light = new THREE.DirectionalLight(d.color, d.intensity);
        light.position.set(d.position[0], d.position[1], d.position[2]);
        // First directional becomes the shadow caster when quality permits.
        if (i === 0 && this.quality.shadows.enabled) {
          light.castShadow = true;
          light.shadow.mapSize.set(this.quality.shadows.mapSize, this.quality.shadows.mapSize);
          // Defaults — overwritten in fitToModel once we know the model size.
          light.shadow.camera.near = 0.1;
          light.shadow.camera.far = 50;
          light.shadow.bias = -0.0005;
          light.shadow.normalBias = 0.02;
          // Target must be in the scene graph for OrbitControls-driven moves
          // to take effect; we re-aim it at the model in fitToModel.
          this.scene.add(light.target);
          this.shadowKey = light;
        }
        this.group.add(light);
      });
    }
  }

  /**
   * Re-anchor the shadow caster to the model's bounding sphere so shadows
   * render correctly regardless of model scale.
   *   - Light direction is preserved (visual character of the preset stays).
   *   - Light distance is set proportional to model radius so the light sits
   *     outside the model.
   *   - Shadow ortho camera is sized to enclose the model with padding.
   *   - Target moves to the model center so directional lighting hits
   *     correctly even for off-origin models.
   */
  fitToModel(box: THREE.Box3): void {
    if (!this.shadowKey || box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    if (sphere.radius === 0) return;

    const light = this.shadowKey;
    // Keep the preset's directional angle; only adjust magnitude + offset.
    const dir = light.position.clone().normalize();
    if (dir.lengthSq() === 0) dir.set(0, 1, 0);
    const distance = sphere.radius * 3;
    light.position.copy(sphere.center).addScaledVector(dir, distance);
    light.target.position.copy(sphere.center);
    light.target.updateMatrixWorld();

    const cam = light.shadow.camera as THREE.OrthographicCamera;
    const r = sphere.radius * 1.25;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = Math.max(0.01, distance - sphere.radius * 2);
    cam.far = distance + sphere.radius * 3;
    cam.updateProjectionMatrix();

    // bias is in normalized depth units and the ortho camera's depth range
    // already scales with the model, so it stays constant — scaling it too
    // visibly detaches shadows on large models. normalBias is in world units
    // and does need to track model size.
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = 0.02 * Math.max(1, sphere.radius);
    light.shadow.needsUpdate = true;
  }

  /** Free GPU resources owned by the rig. Idempotent. */
  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
    this.pmrem.dispose();
  }

  private clear(): void {
    while (this.group.children.length > 0) {
      const child = this.group.children[0];
      this.group.remove(child);
      // Lights own GPU state (the shadow caster holds a shadow-map render
      // target); dropping them without dispose() leaks VRAM on every preset
      // switch.
      if ((child as THREE.Light).isLight) (child as THREE.Light).dispose();
    }
    if (this.envMap) {
      this.envMap.dispose();
      this.envMap = null;
    }
    if (this.shadowKey) {
      this.scene.remove(this.shadowKey.target);
      this.shadowKey = null;
    }
    this.scene.environment = null;
    this.scene.environmentIntensity = 1.0;
  }
}
