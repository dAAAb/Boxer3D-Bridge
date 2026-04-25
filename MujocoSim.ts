/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/


import * as THREE from 'three';
import { DragStateManager } from './DragStateManager';
import { IkSystem } from './IkSystem';
import { RenderSystem } from './RenderSystem';
import { RobotLoader } from './RobotLoader';
import { SceneReport, STREAM_BODY_REGEX, computeStreamPoses, streamBodyName } from './SceneReport';
import { SelectionManager } from './SelectionManager';
import { SequenceAnimator } from './SequenceAnimator';
import type { PrimitiveStep } from './actionLibrary';
import { MujocoData, MujocoModel, MujocoModule } from './types';
import { getName } from './utils/StringUtils';

/**
 * MujocoSim: The Central Orchestrator.
 * Manages the connection between the MuJoCo WASM engine and the Three.js visualization.
 */
export class MujocoSim {
    mujoco: MujocoModule;      
    mjModel: MujocoModel | null = null;     
    mjData: MujocoData | null = null;      
    mjvOption: InstanceType<MujocoModule['MjvOption']>;   

    renderSys: RenderSystem;
    ikSys: IkSystem;
    dragStateManager: DragStateManager;
    selectionManager: SelectionManager;
    sequenceAnimator: SequenceAnimator;

    frameId: number | null = null;
    paused = false;
    gripperActuatorId = -1;
    speedMultiplier = 1;

    private currentRobotId = 'franka_emika_panda';
    private currentSceneFile = 'scene.xml';

    /// Name → bodyId lookup populated after reloadWithScene. Used by
    /// applyStreamUpdate to teleport bodies 10 Hz without walking the
    /// entire body list each tick.
    private streamBodyMap = new Map<string, number>();
    /// Latest stream report. Re-applied on EVERY sim step (not just on
    /// stream tick) so gravity and contact impulses can't push bodies
    /// between updates — this is what kills the otherwise visible 10 Hz
    /// flicker when the stream is slower than the physics step.
    private latestStreamReport: SceneReport | null = null;
    
    private userIkEnabled = false; 
    private firstIkEnable = true; // Track first enable to enforce default rotation

    // Gizmo Interpolation State
    private gizmoAnim = {
        active: false,
        startPos: new THREE.Vector3(),
        endPos: new THREE.Vector3(),
        startRot: new THREE.Quaternion(),
        endRot: new THREE.Quaternion(),
        startTime: 0,
        duration: 1000
    };

    constructor(container: HTMLElement, mujocoInstance: MujocoModule) {
        this.mujoco = mujocoInstance;
        this.mjvOption = new this.mujoco.MjvOption();
        
        this.renderSys = new RenderSystem(container, this.mujoco);
        
        this.dragStateManager = new DragStateManager(this.renderSys.scene, this.renderSys.renderer, this.renderSys.camera, container, this.renderSys.controls);
        this.selectionManager = new SelectionManager(this.renderSys.scene, this.renderSys.renderer, this.renderSys.camera, container);
        
        this.ikSys = new IkSystem(this.mujoco, this.renderSys.camera, this.renderSys.renderer.domElement, this.renderSys.controls);
        this.renderSys.simGroup.add(this.ikSys.target);
        // three.js ≥ r169 split TransformControls into a Controls subclass +
        // a separate visual helper. `.getHelper()` returns the addable
        // Object3D — adding the controls instance directly triggered the
        // 'object not an instance of THREE.Object3D' console error.
        this.renderSys.scene.add(this.ikSys.control.getHelper());
        
        this.sequenceAnimator = new SequenceAnimator();
        
        this.renderSys.initLights(this.dragStateManager);
    }

    async init(robotId = 'franka_emika_panda', sceneFile = 'scene.xml', onProgress?: (msg: string) => void) {
        this.currentRobotId = robotId;
        this.currentSceneFile = sceneFile;
        const loader = new RobotLoader(this.mujoco);
        const { isDouble, isStacking } = await loader.load(robotId, sceneFile, onProgress);

        try {
            this.mjModel = this.mujoco.MjModel.loadFromXML(`/working/${sceneFile}`);
            this.mjData = new this.mujoco.MjData(this.mjModel);
        } catch (e: unknown) { 
            throw new Error(`Failed to load model: ${(e as Error).message}`); 
        }

        if (this.mjModel) {
            this.ikSys.gripperSiteId = -1; 
            this.gripperActuatorId = -1;
            for (let i = 0; i < this.mjModel.nsite; i++) {
                 if (getName(this.mjModel, this.mjModel.name_siteadr[i]).includes('tcp')) { 
                     this.ikSys.gripperSiteId = i; break; 
                 }
            }
            for (let i = 0; i < this.mjModel.nu; i++) {
                 if (getName(this.mjModel, this.mjModel.name_actuatoradr[i]).includes('gripper')) { 
                     this.gripperActuatorId = i; break; 
                 }
            }

            // Set Initial Pose
            this.setInitialPose();

            this.mujoco.mj_forward(this.mjModel, this.mjData!);
            this.renderSys.initScene(this.mjModel);
            this.ikSys.init(this.mjModel, isDouble);
            this.ikSys.syncToSite(this.mjData!);
            
            this.ikSys.target.quaternion.setFromEuler(new THREE.Euler(Math.PI, 0, 0));
            this.ikSys.target.position.set(0, 0, 0.45);

            this.firstIkEnable = true;
            
            this.sequenceAnimator.init(this.mjModel, isStacking, (addr) => getName(this.mjModel!, addr));
            
            this.startLoop();
        }
    }
    
    private setInitialPose() {
        if (!this.mjModel || !this.mjData) return;
        const initVals = [1.707, -1.754, 0.003, -2.702, 0.003, 0.951, 2.490, 0.000];
        
        for (let i = 0; i < Math.min(initVals.length, this.mjModel.nu); i++) {
            this.mjData.ctrl[i] = initVals[i];
            if (this.mjModel.actuator_trnid[2 * i + 1] === 1) {
                const jointId = this.mjModel.actuator_trnid[2 * i];
                if (jointId >= 0 && jointId < this.mjModel.njnt) {
                    const qposAdr = this.mjModel.jnt_qposadr[jointId];
                    this.mjData.qpos[qposAdr] = initVals[i];
                }
            }
        }
    }

    private randomizeCubes() {
        if (!this.mjModel || !this.mjData) return;
        const positions: Array<{x: number, y: number}> = [];
        
        for (let i = 0; i < this.mjModel.nbody; i++) {
            const name = getName(this.mjModel, this.mjModel.name_bodyadr[i]);
            if (name.startsWith('cube')) {
                let x = 0;
                let y = 0;
                let valid = false;
                let attempts = 0;
                while (!valid && attempts < 100) {
                    const minR = 0.35;
                    const maxR = 0.8;
                    const r = Math.sqrt(Math.random() * (maxR*maxR - minR*minR) + minR*minR);
                    const theta = Math.random() * 2 * Math.PI;
                    x = r * Math.cos(theta);
                    y = r * Math.sin(theta);
                    valid = true;
                    const distStack = Math.sqrt((x - 0.6)**2 + (y - 0)**2);
                    if (distStack < 0.35) valid = false;
                    if (valid) {
                        for (const p of positions) {
                            if ((p.x - x)**2 + (p.y - y)**2 < 0.004) { valid = false; break; }
                        }
                    }
                    attempts++;
                }
                if (valid) {
                    positions.push({x, y});
                    
                    // Assuming body_jntadr exists in the model wrapper or bindings
                    // Standard MuJoCo has body_jntadr.
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const jntIdVal = (this.mjModel as any).body_jntadr[i];
                    if (jntIdVal >= 0) {
                        const qp = this.mjModel.jnt_qposadr[jntIdVal];
                        this.mjData.qpos[qp] = x;
                        this.mjData.qpos[qp + 1] = y;
                        this.mjData.qpos[qp + 2] = 0.02;
                        // Orientation (Identity)
                        this.mjData.qpos[qp + 3] = 1;
                        this.mjData.qpos[qp + 4] = 0;
                        this.mjData.qpos[qp + 5] = 0;
                        this.mjData.qpos[qp + 6] = 0;
                    }
                }
            }
        }
    }

    private startLoop() {
        if (this.frameId) cancelAnimationFrame(this.frameId);

        const loop = () => {
            if (!this.mjModel || !this.mjData) {
                 this.frameId = requestAnimationFrame(loop);
                 return;
            }

            this.dragStateManager.update();
            if (this.draggedBodyId() !== null) this.mjData.xfrc_applied.fill(0);
            if (this.dragStateManager.active && this.dragStateManager.physicsObject) {
                this.applyDragForce();
            }
            
            if (this.gizmoAnim.active) {
                const now = performance.now();
                const elapsed = now - this.gizmoAnim.startTime;
                const t = Math.min(elapsed / this.gizmoAnim.duration, 1.0);
                const ease = 1 - Math.pow(1 - t, 3);
                
                this.ikSys.target.position.lerpVectors(this.gizmoAnim.startPos, this.gizmoAnim.endPos, ease);
                this.ikSys.target.quaternion.slerpQuaternions(this.gizmoAnim.startRot, this.gizmoAnim.endRot, ease);
                
                if (t >= 1.0) {
                    this.gizmoAnim.active = false;
                }
            }

            if (!this.paused) {
                if (this.sequenceAnimator.running) {
                    this.sequenceAnimator.update((1/60) * this.speedMultiplier, this.ikSys.target, this.mjData, this.gripperActuatorId, this.ikSys);
                    this.setIkEnabled(false);
                } else {
                     this.syncIkState();
                     this.ikSys.update(this.mjModel, this.mjData);
                }

                const startSimTime = this.mjData.time;
                // Allow simulation to run faster than real-time based on speedMultiplier
                while (this.mjData.time - startSimTime < (1.0 / 60.0) * this.speedMultiplier) {
                    // Re-impose stream target just before each physics step
                    // so integrated gravity / contact forces don't drift the
                    // body between 10 Hz stream updates.
                    this.applyLatestStreamPoses();
                    this.mujoco.mj_step(this.mjModel, this.mjData);
                }
            }

            this.renderSys.update(this.mjData, this.renderSys.contactMarkers.visible);
            this.frameId = requestAnimationFrame(loop);
        };
        this.frameId = requestAnimationFrame(loop);
    }

    private draggedBodyId(): number | null { 
        return this.dragStateManager.active && this.dragStateManager.physicsObject ? this.dragStateManager.physicsObject.userData.bodyID : null; 
    }

    private applyDragForce() {
        if (!this.mjData) return;
        const bodyId = this.draggedBodyId()!;
        const force = new THREE.Vector3().subVectors(this.dragStateManager.currentWorld, this.dragStateManager.worldHit).multiplyScalar(1.5);
        if (force.lengthSq() > 25) force.setLength(5.0); 
        
        const bodyPos = new THREE.Vector3().fromArray(this.mjData.xpos, bodyId * 3);
        const leverArm = new THREE.Vector3().subVectors(this.dragStateManager.worldHit, bodyPos);
        const torque = leverArm.cross(force);

        this.mjData.xfrc_applied.set([force.x, force.y, force.z, torque.x, torque.y, torque.z], bodyId * 6);
    }
    
    private syncIkState() {
        const shouldCalculate = this.userIkEnabled;
        const shouldShowGizmo = this.userIkEnabled && !this.gizmoAnim.active && !this.sequenceAnimator.running; 
        
        this.ikSys.setCalculating(shouldCalculate);
        this.ikSys.setGizmoVisible(shouldShowGizmo);
        
        if (this.sequenceAnimator.running) {
            this.ikSys.setTargetVisible(true);
        } else if(shouldCalculate) {
            this.ikSys.setTargetVisible(true);
        }
    }

    moveIkTargetTo(pos: THREE.Vector3, duration = 0) {
        if (!this.userIkEnabled) {
            this.setIkEnabled(true);
        }
        
        const targetPos = new THREE.Vector3(pos.x, pos.y, pos.z + 0.05);
        const targetRot = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0));

        if (duration > 0) {
            this.gizmoAnim.active = true;
            this.gizmoAnim.startPos.copy(this.ikSys.target.position);
            this.gizmoAnim.endPos.copy(targetPos);
            this.gizmoAnim.startRot.copy(this.ikSys.target.quaternion);
            this.gizmoAnim.endRot.copy(targetRot);
            this.gizmoAnim.startTime = performance.now();
            this.gizmoAnim.duration = duration;
        } else {
            this.gizmoAnim.active = false;
            this.ikSys.target.position.copy(targetPos);
            this.ikSys.target.quaternion.copy(targetRot);
        }
    }

    pickupItems(positions: THREE.Vector3[], markerIds: number[], onFinished?: () => void) {
        if (this.sequenceAnimator && this.mjData) {
            this.ikSys.syncToSite(this.mjData);
            this.sequenceAnimator.start(
                this.ikSys.target, 
                this.mjData, 
                this.ikSys, 
                { positions, markerIds }, 
                (markerId) => {
                    this.renderSys.removeMarkerById(markerId);
                },
                onFinished
            );
            this.setIkEnabled(false);
        }
    }

    async reloadWithScene(sceneReport: SceneReport, onProgress?: (msg: string) => void) {
        if (this.frameId !== null) {
            cancelAnimationFrame(this.frameId);
            this.frameId = null;
        }
        this.sequenceAnimator.reset();
        this.renderSys.clearErMarkers();

        for (const b of this.renderSys.bodies) this.renderSys.simGroup.remove(b);
        this.renderSys.bodies = [];

        if (this.mjData) { this.mjData.delete(); this.mjData = null; }
        if (this.mjModel) { this.mjModel.delete(); this.mjModel = null; }

        const loader = new RobotLoader(this.mujoco);
        const { isDouble, isStacking } = await loader.load(this.currentRobotId, this.currentSceneFile, onProgress, sceneReport);

        try {
            this.mjModel = this.mujoco.MjModel.loadFromXML(`/working/${this.currentSceneFile}`);
            this.mjData = new this.mujoco.MjData(this.mjModel);
        } catch (e: unknown) {
            throw new Error(`Failed to reload with scene: ${(e as Error).message}`);
        }

        this.ikSys.gripperSiteId = -1;
        this.gripperActuatorId = -1;
        for (let i = 0; i < this.mjModel.nsite; i++) {
            if (getName(this.mjModel, this.mjModel.name_siteadr[i]).includes('tcp')) {
                this.ikSys.gripperSiteId = i; break;
            }
        }
        for (let i = 0; i < this.mjModel.nu; i++) {
            if (getName(this.mjModel, this.mjModel.name_actuatoradr[i]).includes('gripper')) {
                this.gripperActuatorId = i; break;
            }
        }

        this.setInitialPose();
        this.mujoco.mj_forward(this.mjModel, this.mjData!);
        this.renderSys.initScene(this.mjModel);
        this.ikSys.init(this.mjModel, isDouble);
        this.ikSys.syncToSite(this.mjData!);

        this.ikSys.target.quaternion.setFromEuler(new THREE.Euler(Math.PI, 0, 0));
        this.ikSys.target.position.set(0, 0, 0.45);
        this.firstIkEnable = true;

        this.sequenceAnimator.init(this.mjModel, isStacking, (addr) => getName(this.mjModel!, addr));

        // Attach USDZ mesh overlays for stream-injected bodies, and cache
        // the name → bodyId lookup so the live-update path doesn't need to
        // scan all bodies every 10 Hz tick.
        this.streamBodyMap.clear();
        this.latestStreamReport = null;
        const streamEntries: { bodyId: number; label: string; trackId: string }[] = [];
        for (let i = 0; i < this.mjModel.nbody; i++) {
            const name = getName(this.mjModel, this.mjModel.name_bodyadr[i]);
            const match = name.match(STREAM_BODY_REGEX);
            if (match) {
                streamEntries.push({ bodyId: i, label: match[1], trackId: match[2] });
                this.streamBodyMap.set(name, i);
            }
        }
        if (streamEntries.length > 0) {
            this.renderSys.attachStreamMeshes(streamEntries);
        }

        this.startLoop();
    }

    /// Stash the latest stream snapshot. Actual qpos writes happen in the
    /// main sim loop (see `applyLatestStreamPoses`) so the teleport runs
    /// at physics rate, not just at 10 Hz — otherwise bodies visibly drift
    /// under gravity between stream ticks and then snap back.
    applyStreamUpdate(scene: SceneReport) {
        this.latestStreamReport = scene;
    }

    private applyLatestStreamPoses() {
        const scene = this.latestStreamReport;
        if (!scene || !this.mjModel || !this.mjData) return;
        if (this.streamBodyMap.size === 0) return;
        // Pause during pickup sequences so the gripper can actually carry
        // a body without being yanked back to its streamed pose every step.
        if (this.sequenceAnimator.running) return;

        const poses = computeStreamPoses(scene);
        for (let i = 0; i < scene.objects.length; i++) {
            const o = scene.objects[i];
            const name = streamBodyName(o.label, o.id);
            const bodyId = this.streamBodyMap.get(name);
            if (bodyId === undefined) continue;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const jntAdr = (this.mjModel as any).body_jntadr[bodyId];
            if (jntAdr < 0) continue;
            const qp = this.mjModel.jnt_qposadr[jntAdr];
            const p = poses[i];
            this.mjData.qpos[qp + 0] = p.x;
            this.mjData.qpos[qp + 1] = p.y;
            this.mjData.qpos[qp + 2] = p.z;
            const half = p.yaw / 2;
            this.mjData.qpos[qp + 3] = Math.cos(half);
            this.mjData.qpos[qp + 4] = 0;
            this.mjData.qpos[qp + 5] = 0;
            this.mjData.qpos[qp + 6] = Math.sin(half);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const dofAdr = (this.mjModel as any).jnt_dofadr?.[jntAdr];
            if (dofAdr !== undefined) {
                for (let k = 0; k < 6; k++) this.mjData.qvel[dofAdr + k] = 0;
            }
        }
    }

    /// Build a SceneReport from the current MuJoCo bodies (no iPhone stream
    /// needed). Used when the user wants to Plan/Execute against the
    /// default demo scene (20 random cubes) before pressing Radio. Each
    /// cube body becomes a SceneObject with body name as track_id and a
    /// colour-based label so Gemini can plan "find two red cubes and
    /// stack them" without ever calling a VLM detector.
    synthesizeSceneFromBodies(): SceneReport | null {
        if (!this.mjModel || !this.mjData) return null;
        // Matches the cube colour order in RobotLoader.patchSingleRobot.
        const COLORS = ['red', 'cyan', 'green', 'yellow'];
        const objects: { id: string; label: string; center_world: [number, number, number]; size_m: [number, number, number]; yaw_rad: number; confidence: number; }[] = [];
        for (let i = 0; i < this.mjModel.nbody; i++) {
            const name = getName(this.mjModel, this.mjModel.name_bodyadr[i]);
            const m = name.match(/^cube(\d+)$/);
            if (!m) continue;
            const idx = parseInt(m[1], 10);
            const px = this.mjData.xpos[i * 3];
            const py = this.mjData.xpos[i * 3 + 1];
            const pz = this.mjData.xpos[i * 3 + 2];
            objects.push({
                id: name,
                label: `${COLORS[idx % 4]} cube`,
                center_world: [px, py, pz],
                size_m: [0.04, 0.04, 0.04],
                yaw_rad: 0,
                confidence: 1.0,
            });
        }
        if (objects.length === 0) return null;
        return {
            version: 1,
            coordinate_frame: 'mujoco_world',
            timestamp: Date.now() / 1000,
            objects,
        };
    }

    /// Direct world-position lookup by MuJoCo body name. Stream bodies use
    /// `stream_{label}_{UUID}` names so getStreamBodyPosition is the right
    /// call there; this is the corresponding lookup for synthetic scenes
    /// where track_id == body name (e.g. "cube0", "cube12").
    getBodyPositionByName(name: string): THREE.Vector3 | null {
        if (!this.mjModel) return null;
        for (let i = 0; i < this.mjModel.nbody; i++) {
            if (getName(this.mjModel, this.mjModel.name_bodyadr[i]) === name) {
                return this.renderSys.bodies[i]?.position.clone() ?? null;
            }
        }
        return null;
    }

    /// Snapshot of the body names currently injected from the stream.
    /// Used by App.tsx to decide whether the "sync" toolbar dot should
    /// pulse — when the stream has track UUIDs the sim doesn't know
    /// about (e.g. BoxerNet's MOT reaped + respawned a track), we want
    /// to nudge the user to press Radio.
    getStreamBodyKeys(): Set<string> {
        return new Set(this.streamBodyMap.keys());
    }

    /// Step-3.5 entry point: hand the SequenceAnimator a flat queue of
    /// primitive action steps and run them in order. Mirrors pickupItems
    /// for the action-plan flow.
    executePlan(steps: PrimitiveStep[], onFinished?: () => void) {
        if (!this.mjData) {
            onFinished?.();
            return;
        }
        this.ikSys.syncToSite(this.mjData);
        this.sequenceAnimator.executeActions(
            steps,
            this.ikSys.target,
            this.mjData,
            this.ikSys,
            onFinished,
        );
        this.setIkEnabled(false);
    }

    /// Look up the current world position of a stream-injected body by its
    /// label + track UUID. Returns null if the track isn't in the current
    /// scene — caller should fall back to Gemini or prompt a reload. Used
    /// by the "direct pickup" UI path that bypasses Gemini for objects
    /// whose identity we already know from the Boxer3D stream.
    getStreamBodyPosition(label: string, trackId: string): THREE.Vector3 | null {
        const name = streamBodyName(label, trackId);
        const bodyId = this.streamBodyMap.get(name);
        if (bodyId === undefined) return null;
        return this.renderSys.bodies[bodyId]?.position.clone() ?? null;
    }

    reset() {
        if (!this.mjModel || !this.mjData) return;
        this.renderSys.clearErMarkers();
        this.gizmoAnim.active = false;
        this.sequenceAnimator.reset(); 
        this.mujoco.mj_resetData(this.mjModel, this.mjData);
        this.setInitialPose();
        this.randomizeCubes(); 
        this.mujoco.mj_forward(this.mjModel, this.mjData); 
        this.ikSys.syncToSite(this.mjData);
        
        this.ikSys.target.quaternion.setFromEuler(new THREE.Euler(Math.PI, 0, 0));
        this.ikSys.target.position.set(0, 0, 0.45);
        this.firstIkEnable = true;
    }
    
    togglePause() { return this.paused = !this.paused; }
    
    setIkEnabled(enabled: boolean) {
        this.userIkEnabled = enabled;
        this.syncIkState();
        if (enabled && this.mjData && !this.gizmoAnim.active && !this.sequenceAnimator.running) {
            if (this.firstIkEnable) {
                this.ikSys.target.quaternion.setFromEuler(new THREE.Euler(Math.PI, 0, 0));
                this.ikSys.target.position.set(0, 0, 0.45);
                this.firstIkEnable = false;
            } else {
                this.ikSys.syncToSite(this.mjData);
            }
        }
    }
    
    setSpeedMultiplier(speed: number) {
        this.speedMultiplier = speed;
    }
    
    getGizmoStats() { return this.ikSys.calculating && this.ikSys.target ? { pos: this.ikSys.target.position.clone(), rot: new THREE.Euler().setFromQuaternion(this.ikSys.target.quaternion) } : null; }
    
    dispose() {
        if (this.frameId) cancelAnimationFrame(this.frameId);
        this.dragStateManager.dispose(); 
        this.selectionManager.dispose(); 
        this.renderSys.dispose(); 
        this.ikSys.dispose();
        if (this.mjvOption) this.mjvOption.delete(); 
        if (this.mjModel) this.mjModel.delete(); 
        if (this.mjData) this.mjData.delete();
        try { this.mujoco.FS.unmount('/working'); } catch (e) { /* ignore */ }
    }
}