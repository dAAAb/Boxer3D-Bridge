/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SceneObject {
  id: string;
  label: string;
  center_world: [number, number, number];
  size_m: [number, number, number];
  yaw_rad: number;
  confidence: number;
}

export interface CameraIntrinsics {
  /// [fx, fy, cx, cy] in NATIVE camera pixel space — same dimensions as
  /// `image_size_native`. Lets the browser project 3D OBBs back into the
  /// same image Gemini saw, so 2D detections can be matched to track UUIDs
  /// by closest-pixel distance in the canonical 0–1000 normalized space.
  fxfycxcy: [number, number, number, number];
  image_size_native: [number, number];
}

export interface SceneImage {
  /// JPEG bytes, base64 (no `data:` prefix).
  base64: string;
  mime: string;
  width: number;
  height: number;
}

export interface SceneReport {
  version?: number;
  timestamp: number;
  coordinate_frame?: string;
  objects: SceneObject[];
  /// Camera pose (4×4 column-major in `camera.pose_world`) is sent every
  /// tick. Intrinsics are also sent every tick (cheap, 4 floats); image
  /// is only attached when the browser explicitly requested a frame —
  /// otherwise this stays undefined to keep regular ticks tiny.
  camera_intrinsics?: CameraIntrinsics;
  image?: SceneImage;
}

/// Body name convention for bridge-injected OBBs: `stream_{label}_{trackId}`.
/// The trackId is the BoxerNet MOT track UUID (hyphens → underscores) so
/// live updates match by stable identity even when Boxer3D's detection
/// array reorders on track-reap.
export const STREAM_BODY_PREFIX = 'stream_';
export const STREAM_BODY_REGEX = /^stream_([a-zA-Z0-9]+)_([a-zA-Z0-9_]+)$/;

/// Collision geometry colour for stream-injected bodies. White because the
/// mesh overlay is the intended visual; this is only visible for labels
/// that have no registered USDZ.
const STREAM_BOX_COLOR = '1 1 1 1';

/// Push every injected body forward (in Franka's +X) by this much, so that
/// objects detected while holding the iPhone too close to the arm don't
/// spawn inside Franka's collision hull — which the physics engine tries
/// to resolve by violently flinging the object across the floor.
const FRANKA_FORWARD_OFFSET = 0.15;

/// Lift the ground plane by this much after self-calibration so the lowest
/// box bottom floats just above MuJoCo z=0 instead of resting exactly on
/// the floor. Avoids the occasional penetration contact that solimp
/// interprets as an impulse.
const GROUND_EPSILON = 0.005;

export interface StreamPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/// The shared transform used at injection time (sceneReportToMjcf) and at
/// every live update (MujocoSim.applyStreamUpdate). Ensures that the pose
/// a body receives on "Reload" matches the pose it'll receive on the next
/// 10 Hz stream tick — otherwise the body would jump the moment live
/// updates started.
export function computeStreamPoses(scene: SceneReport): StreamPose[] {
  const bottoms = scene.objects.map((o) => o.center_world[2] - o.size_m[2] / 2);
  const groundZ = bottoms.length > 0 ? Math.min(...bottoms) : 0;
  // Lowest object's bottom → floor. Every other object's vertical offset
  // is honoured as BoxerNet reported it, so genuinely stacked objects (cup
  // on laptop) and legit-floating detections (transparent cup whose OBB
  // locks onto the rim, missing the base) both read truthfully in sim.
  return scene.objects.map((obj) => ({
    x: obj.center_world[0] + FRANKA_FORWARD_OFFSET,
    y: obj.center_world[1],
    z: obj.center_world[2] - groundZ + GROUND_EPSILON,
    yaw: obj.yaw_rad,
  }));
}

export function streamBodyName(label: string, trackId: string): string {
  const safeLabel = (label || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
  const safeId = (trackId || '').replace(/[^a-zA-Z0-9]/g, '_') || 'x';
  return `${STREAM_BODY_PREFIX}${safeLabel}_${safeId}`;
}

export function sceneReportToMjcf(scene: SceneReport): string {
  const parts: string[] = [];
  const poses = computeStreamPoses(scene);

  scene.objects.forEach((obj, i) => {
    const p = poses[i];
    const [w, h, d] = obj.size_m;
    const hx = (w / 2).toFixed(4);
    const hy = (h / 2).toFixed(4);
    const hz = (d / 2).toFixed(4);
    const bodyName = streamBodyName(obj.label, obj.id);
    const { x, y, z } = p;
    // freejoint + pickup-friendly contact params (same recipe as the
    // original demo's random cubes). Bodies start resting on the floor
    // thanks to the groundZ shift; the live stream loop re-writes qpos
    // each tick anyway, so physics mostly acts during pickup sequences.
    parts.push(
      `<body name="${bodyName}" pos="${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}" euler="0 0 ${p.yaw.toFixed(4)}">` +
      `<freejoint/>` +
      `<geom type="box" size="${hx} ${hy} ${hz}" rgba="${STREAM_BOX_COLOR}" mass="0.05" friction="1.5 0.3 0.1" solref="0.01 1" solimp="0.95 0.99 0.001 0.5 2" condim="4"/>` +
      `</body>`
    );
  });
  parts.push(`<body name="stack_base" pos="0.6 0 0.0"><geom type="box" size="0.1 0.1 0.005" rgba="0.3 0.3 0.3 1"/></body>`);
  return parts.join('');
}
