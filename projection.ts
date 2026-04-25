/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';

/**
 * Project a 3D world point through the iPhone camera, returning the pixel
 * the point would land on in the camera's native image. Returns null if
 * the point is behind the camera (or extremely close to the principal
 * plane — wouldn't project meaningfully).
 *
 * ARKit camera local frame: -Z forward, +Y up, +X right. Pinhole standard:
 * +Z forward, +Y down. The conversion is folded into the formula here so
 * the caller can pass world coords + intrinsics directly without juggling
 * sign flips:
 *
 *   p_cam   = inv(camera_pose_world) · p_world
 *   u_pixel = -fx · p_cam.x / p_cam.z + cx     (z is negative for points
 *   v_pixel =  fy · p_cam.y / p_cam.z + cy      in front, so the divisions
 *                                                end up positive)
 */
export function worldToImagePixel(
  pWorld: THREE.Vector3 | [number, number, number],
  cameraPoseWorldColMajor: number[],
  intrinsics: [number, number, number, number],
): { u: number; v: number; depth: number } | null {
  const camToWorld = new THREE.Matrix4().fromArray(cameraPoseWorldColMajor);
  const worldToCam = camToWorld.clone().invert();
  const pVec = pWorld instanceof THREE.Vector3
    ? pWorld.clone()
    : new THREE.Vector3(pWorld[0], pWorld[1], pWorld[2]);
  const pCam = pVec.applyMatrix4(worldToCam);
  if (pCam.z >= -1e-3) return null;
  const [fx, fy, cx, cy] = intrinsics;
  return {
    u: -fx * pCam.x / pCam.z + cx,
    v:  fy * pCam.y / pCam.z + cy,
    depth: -pCam.z,
  };
}

/**
 * Convert a pixel coord in a NATIVE-resolution image to the same 0–1000
 * normalized space Gemini-ER uses for `box_2d` and `point` outputs. Both
 * Gemini's output and our projection then live in the same coordinate
 * system regardless of any JPEG downscaling — as long as aspect ratio is
 * preserved, the 0–1000 normalization is invariant to resolution.
 */
export function pixelToGemini1000(
  u: number,
  v: number,
  imageSizeNative: [number, number],
): { gx: number; gy: number } {
  const [w, h] = imageSizeNative;
  return { gx: (u / w) * 1000, gy: (v / h) * 1000 };
}

/**
 * Convenience wrapper: project a world point straight to Gemini's 0–1000
 * space, returning null if it falls behind the camera. Matching against
 * Gemini's 2D detections then reduces to a Euclidean distance compare in
 * the [0, 1000] × [0, 1000] grid.
 */
export function worldToGemini1000(
  pWorld: THREE.Vector3 | [number, number, number],
  cameraPoseWorldColMajor: number[],
  intrinsics: [number, number, number, number],
  imageSizeNative: [number, number],
): { gx: number; gy: number; depth: number } | null {
  const px = worldToImagePixel(pWorld, cameraPoseWorldColMajor, intrinsics);
  if (!px) return null;
  const { gx, gy } = pixelToGemini1000(px.u, px.v, imageSizeNative);
  return { gx, gy, depth: px.depth };
}
