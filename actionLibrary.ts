/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { SceneObject } from './SceneReport';

// ─── What Gemini returns ────────────────────────────────────────────────
//
// High-level "verbs" the planner LLM emits. Mixed granularity by design:
// pick / place_above / place_at cover ~90% of natural-language tasks; the
// low-level move_to_pose / open_gripper / close_gripper / wait are escape
// hatches when the high-level vocabulary doesn't fit.

export type RobotFunctionCall =
  | { function: 'pick';           args: { track_id: string } }
  | { function: 'place_above';    args: { track_id: string; height_m: number } }
  | { function: 'place_at';       args: { x: number; y: number; z: number } }
  | { function: 'open_gripper';   args?: Record<string, never> }
  | { function: 'close_gripper';  args?: Record<string, never> }
  | { function: 'move_to_pose';   args: { x: number; y: number; z: number; yaw_rad?: number } }
  | { function: 'wait';           args: { seconds: number } };

// ─── What SequenceAnimator consumes ─────────────────────────────────────
//
// Flat primitive steps. Each step = one IK target + duration. The animator
// just plays them back-to-back; no nested logic. `expandPlan` below
// translates a high-level call list into this primitive sequence.

export type PrimitiveStep =
  | { kind: 'move_to_pose'; pos: THREE.Vector3; quat?: THREE.Quaternion; duration_s: number }
  | { kind: 'open_gripper';  duration_s?: number }
  | { kind: 'close_gripper'; duration_s?: number }
  | { kind: 'wait';          duration_s: number };

// ─── Function-library docs for the Gemini Stage-2 prompt ────────────────

export const FUNCTION_LIBRARY_DOCS = `
You are a planning agent for a Franka Panda robot arm in a sim.
Given a list of detected objects (each with track_id, label, world position
in meters) and a user task, output a JSON array of robot function calls
that accomplish the task.

Coordinate frame: +X forward from arm base, +Y left, +Z up. Meters.
The arm reach is ~30 cm to ~80 cm from base in +X.

Available functions (each entry: {"function": "name", "args": {...}}):

- pick({track_id}): Hover above the object, lower, close gripper, lift.
  Use a track_id from the detected list.
- place_above({track_id, height_m}): Move ~height_m above the named object
  and release. Use to stack: place_above(target_id, target.size_z + 0.02).
- place_at({x, y, z}): Move to absolute coords, open gripper, lift.
- open_gripper(): Open without moving.
- close_gripper(): Close without moving.
- move_to_pose({x, y, z, yaw_rad?}): Move TCP to coords; yaw_rad is rotation
  around +Z, defaults to gripper-pointing-down.
- wait({seconds}): Pause.

Output format: JSON array, no prose. Example for "stack the two cups":
[
  {"function": "pick", "args": {"track_id": "<id_of_cup_a>"}},
  {"function": "place_above", "args": {"track_id": "<id_of_cup_b>", "height_m": 0.13}},
  {"function": "open_gripper"}
]

Be conservative: prefer pick + place_above over manual move_to_pose
chains. Do not output explanations.
`.trim();

// ─── Expansion from high-level calls to primitive steps ─────────────────

/// 20 cm above target — enough clearance for most tabletop objects.
const HOVER_HEIGHT = 0.20;
/// Z offset above object centre when descending to top-grasp. Conservative
/// — wraps gripper around the upper portion of the object body.
const GRASP_Z_OFFSET = 0.02;
/// Margin under the OBB top edge when top-edge-grasping a flat object —
/// fingers need to be slightly below the top to wrap around.
const TOP_EDGE_MARGIN = 0.005;
/// Default gripper-pointing-down quaternion.
const downQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0));

// ─── Per-label grasp policy (Step 3.6) ──────────────────────────────
//
// `pick` expansion looks up the policy by label and chooses where the
// TCP descends + which orientation it uses. Without this every grasp
// would be top-down to the OBB centre, which works for cups/bottles but
// stabs the keyboard on flat objects whose centre sits near the table.

type GraspPolicy =
  | 'top_grasp'        // descend to OBB centre, gripper-down. Default.
  | 'top_edge_grasp';  // descend to OBB top edge, gripper-down. For flat-
                       // ish objects (open laptop, book) where the
                       // graspable feature is the upper rim.

const LABEL_POLICY: Record<string, GraspPolicy> = {
  cup:      'top_grasp',
  bottle:   'top_grasp',
  can:      'top_grasp',
  glass:    'top_grasp',
  laptop:   'top_edge_grasp',
  keyboard: 'top_edge_grasp',
  book:     'top_edge_grasp',
  plate:    'top_edge_grasp',
};

/// Compute the descent Z (world-frame) for the TCP based on label policy.
/// Returns a Z value relative to the OBB centre, NOT the floor.
function descendZ(centerZ: number, halfHeight: number, policy: GraspPolicy): number {
  switch (policy) {
    case 'top_edge_grasp':
      // TCP at (centre + halfH - margin) → fingers wrap around the OBB
      // top rim. For an open laptop (size_z ~21 cm) the top is ~20 cm
      // above floor, plenty of clearance for the ~5 cm fingers.
      return centerZ + halfHeight - TOP_EDGE_MARGIN;
    case 'top_grasp':
    default:
      // TCP slightly above centre → fingers wrap around upper body.
      return centerZ + GRASP_Z_OFFSET;
  }
}

/// Resolves a track UUID to a current world position. Caller (App.tsx)
/// wires this to MujocoSim.getStreamBodyPosition so we always grasp where
/// the body actually IS in sim, not stale SceneReport coords.
export type PosLookup = (trackId: string) => THREE.Vector3 | null;

export interface ExpandResult {
  steps: PrimitiveStep[];
  warnings: string[];
}

export function expandPlan(
  calls: RobotFunctionCall[],
  lookupPos: PosLookup,
  scene: { objects: SceneObject[] },
): ExpandResult {
  const steps: PrimitiveStep[] = [];
  const warnings: string[] = [];

  const labelOf = (trackId: string): string | null =>
    scene.objects.find((o) => o.id === trackId)?.label ?? null;

  for (const call of calls) {
    switch (call.function) {
      case 'pick': {
        const id = call.args.track_id;
        const pos = lookupPos(id);
        if (!pos) {
          warnings.push(`pick: track_id "${id}" not in current sim. Skipping.`);
          continue;
        }
        const obj = scene.objects.find((o) => o.id === id);
        const policy: GraspPolicy = obj ? (LABEL_POLICY[obj.label] ?? 'top_grasp') : 'top_grasp';
        const halfH = (obj?.size_m[2] ?? 0) / 2;
        const graspZ = descendZ(pos.z, halfH, policy);
        const grasp = new THREE.Vector3(pos.x, pos.y, graspZ);
        const above = new THREE.Vector3(pos.x, pos.y, graspZ + HOVER_HEIGHT);
        steps.push(
          { kind: 'move_to_pose',  pos: above, quat: downQuat.clone(), duration_s: 2.0 },
          { kind: 'open_gripper',   duration_s: 0.5 },
          { kind: 'move_to_pose',  pos: grasp, quat: downQuat.clone(), duration_s: 2.0 },
          { kind: 'wait',           duration_s: 0.3 },
          { kind: 'close_gripper',  duration_s: 0.5 },
          { kind: 'wait',           duration_s: 0.3 },
          { kind: 'move_to_pose',  pos: above, quat: downQuat.clone(), duration_s: 2.0 },
        );
        break;
      }
      case 'place_above': {
        const id = call.args.track_id;
        const pos = lookupPos(id);
        if (!pos) {
          warnings.push(`place_above: track_id "${id}" (${labelOf(id) ?? 'unknown'}) not in sim.`);
          continue;
        }
        const drop = pos.clone(); drop.z += call.args.height_m;
        const above = drop.clone(); above.z += 0.10;
        steps.push(
          { kind: 'move_to_pose', pos: above, quat: downQuat.clone(), duration_s: 2.5 },
          { kind: 'move_to_pose', pos: drop,  quat: downQuat.clone(), duration_s: 1.5 },
          { kind: 'wait',          duration_s: 0.3 },
          { kind: 'open_gripper',  duration_s: 0.5 },
          { kind: 'wait',          duration_s: 0.3 },
          { kind: 'move_to_pose', pos: above, quat: downQuat.clone(), duration_s: 1.5 },
        );
        break;
      }
      case 'place_at': {
        const drop = new THREE.Vector3(call.args.x, call.args.y, call.args.z);
        const above = drop.clone(); above.z += 0.10;
        steps.push(
          { kind: 'move_to_pose', pos: above, quat: downQuat.clone(), duration_s: 2.5 },
          { kind: 'move_to_pose', pos: drop,  quat: downQuat.clone(), duration_s: 1.5 },
          { kind: 'wait',          duration_s: 0.3 },
          { kind: 'open_gripper',  duration_s: 0.5 },
          { kind: 'wait',          duration_s: 0.3 },
          { kind: 'move_to_pose', pos: above, quat: downQuat.clone(), duration_s: 1.5 },
        );
        break;
      }
      case 'open_gripper':
        steps.push({ kind: 'open_gripper', duration_s: 0.5 });
        break;
      case 'close_gripper':
        steps.push({ kind: 'close_gripper', duration_s: 0.5 });
        break;
      case 'move_to_pose': {
        const pos = new THREE.Vector3(call.args.x, call.args.y, call.args.z);
        const yaw = call.args.yaw_rad ?? 0;
        const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, yaw));
        steps.push({ kind: 'move_to_pose', pos, quat, duration_s: 2.0 });
        break;
      }
      case 'wait':
        steps.push({ kind: 'wait', duration_s: call.args.seconds });
        break;
      default: {
        // Type system ensures exhaustive — runtime guard for malformed
        // Gemini output that slipped past JSON parsing.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = call as any;
        warnings.push(`Unknown function: ${c?.function ?? 'undefined'}. Skipping.`);
      }
    }
  }
  return { steps, warnings };
}

// ─── Plan preview (Step 3.7 — ghost overlay) ───────────────────────────

export interface PlanPreviewItem {
  trackId: string;
  label: string;
  currentPos: THREE.Vector3;
  finalPos: THREE.Vector3;
  /// Full extents (w, h, d) — passed straight from SceneObject.size_m so
  /// the ghost mesh matches the real OBB size.
  size: [number, number, number];
}

/// Pure-kinematic forward simulation of a RobotFunctionCall sequence.
/// Returns a map from track UUID to its predicted final position. State
/// machine tracks which track (if any) is currently held by the gripper;
/// only RELEASED tracks (place_above / place_at / open_gripper while
/// holding) end up with a final position recorded. Used to render
/// Tesla-FSD-style ghost overlays at the moment Plan completes.
///
/// No physics — just the geometry of pick-then-place. Real Execute may
/// diverge if collisions happen, in which case the divergence is itself
/// useful diagnostic (ghost vs reality).
export function predictPlanFinalPositions(
  calls: RobotFunctionCall[],
  lookupPos: PosLookup,
): Map<string, THREE.Vector3> {
  const result = new Map<string, THREE.Vector3>();
  let held: string | null = null;

  const currentPosOf = (id: string): THREE.Vector3 | null => {
    if (result.has(id)) return result.get(id)!.clone();
    return lookupPos(id);
  };

  for (const call of calls) {
    switch (call.function) {
      case 'pick':
        held = call.args.track_id;
        // No final position written — picked cube moves with the
        // gripper until the next place_*. If never released, we leave
        // it out of the preview map (no ghost for in-flight cubes).
        break;
      case 'place_above': {
        if (!held) break;
        const targetPos = currentPosOf(call.args.track_id);
        if (!targetPos) break;
        const finalPos = targetPos.clone();
        finalPos.z += call.args.height_m;
        result.set(held, finalPos);
        held = null;
        break;
      }
      case 'place_at':
        if (!held) break;
        result.set(held, new THREE.Vector3(call.args.x, call.args.y, call.args.z));
        held = null;
        break;
      case 'open_gripper':
        held = null;
        break;
      // close_gripper, move_to_pose, wait — no cube state change.
      default:
        break;
    }
  }
  return result;
}
