import * as THREE from 'three';

/**
 * Position the camera so the entire object fits in the viewport with a touch
 * of padding. View direction is a 3/4 angle that looks good for most models.
 */
export function frameObject(camera: THREE.PerspectiveCamera, object: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = size.length() / 2;
  if (radius === 0) return;
  // A corrupt mesh (NaN vertices) yields a NaN box that passes isEmpty();
  // framing to it would wedge the camera and controls on NaN forever.
  if (!Number.isFinite(radius) || !Number.isFinite(center.x + center.y + center.z)) return;

  const fov = (camera.fov * Math.PI) / 180;
  const distance = (radius / Math.sin(fov / 2)) * 1.15;

  const direction = new THREE.Vector3(1, 0.65, 1).normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.lookAt(center);
  camera.near = Math.max(distance / 1000, 0.001);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
}

/** Bounding-sphere center for an object (used by orbit controls target). */
export function objectCenter(object: THREE.Object3D): THREE.Vector3 {
  return new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
}
