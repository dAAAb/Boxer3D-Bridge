/**
 * NumericalIK.ts
 * 6-DOF damped least squares IK using finite-difference Jacobian.
 * Designed for the AgileX PiPER arm (6 revolute joints).
 *
 * Note: mj_jacSite is not usable in this WASM build (no memory allocation
 * API exported). DH analytical Jacobian was also tried but diverged due to
 * θ_offset mismatch with the MuJoCo model. FD remains the reliable baseline.
 */

import * as THREE from 'three';
import { MujocoData, MujocoModel, MujocoModule } from './types';

export const NUM_ARM_JOINTS = 6;

// PiPER joint limits [min, max] in radians
const JOINT_LIMITS: [number, number][] = [
    [-2.618, 2.618],
    [0,      3.14 ],
    [-2.697, 0    ],
    [-1.832, 1.832],
    [-1.22,  1.22 ],
    [-3.14,  3.14 ],
];

/** Preferred resting configuration (arm extended forward, ready for table work) */
export const NEUTRAL_Q = [0, 1.2, -1.5, 0, 0, 0];

// ─── Math helpers ────────────────────────────────────────────────────────────

/** Solve Ax = b via Gaussian elimination with partial pivoting. Returns null if singular. */
function gaussSolve(A: number[][], b: number[]): number[] | null {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);

    for (let col = 0; col < n; col++) {
        let maxRow = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
        }
        [M[col], M[maxRow]] = [M[maxRow], M[col]];
        if (Math.abs(M[col][col]) < 1e-10) return null;
        for (let row = col + 1; row < n; row++) {
            const f = M[row][col] / M[col][col];
            for (let k = col; k <= n; k++) M[row][k] -= f * M[col][k];
        }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
        x[i] = M[i][n];
        for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j];
        x[i] /= M[i][i];
    }
    return x;
}

/** Convert MuJoCo row-major 3×3 rotation matrix to THREE.Quaternion */
function rotMatToQuat(mat: ArrayLike<number>): THREE.Quaternion {
    const m = new THREE.Matrix4().set(
        mat[0], mat[1], mat[2], 0,
        mat[3], mat[4], mat[5], 0,
        mat[6], mat[7], mat[8], 0,
        0,      0,      0,      1,
    );
    return new THREE.Quaternion().setFromRotationMatrix(m);
}

// ─── Core IK solver ──────────────────────────────────────────────────────────

export interface IKOptions {
    /** Levenberg-Marquardt damping. Default 0.010 (interactive); use 0.001 near workspace boundary. */
    lambda?: number;
    /** Pull toward NEUTRAL_Q. Default 0.002. */
    regWeight?: number;
    /** Pull toward currentQ (prevents wrist flip during transport). Default 0.08; set 0 for approach. */
    contWeight?: number;
}

/**
 * Solve 6-DOF IK for the PiPER arm.
 *
 * Algorithm: iterative damped least squares (Levenberg–Marquardt style)
 *   (J^T J + (λ + α + β)I) Δq = J^T e + α(q_neutral − q) + β(q_current − q)
 *
 * The regularisation term α pulls toward NEUTRAL_Q; β (contWeight) prevents
 * wrist flips between steps by pulling toward the current joint config.
 * For approach steps (arm empty, large workspace moves) set contWeight=0 and
 * lambda=0.001 for aggressive convergence.  For transport (holding can) set
 * contWeight=0.08 to suppress joint-space jumps while J1 sweeps.
 *
 * @param siteId     - Index of the TCP site in the MuJoCo model
 * @param targetPos  - Desired TCP world position
 * @param targetQuat - Desired TCP world orientation
 * @param currentQ   - Current arm joint angles (6 values)
 * @param options    - Optional per-call tuning overrides
 * @returns 6 joint angles, or null on failure
 */
export function solveIK(
    mujoco: MujocoModule,
    model: MujocoModel,
    data: MujocoData,
    siteId: number,
    targetPos: THREE.Vector3,
    targetQuat: THREE.Quaternion,
    currentQ: number[],
    options?: IKOptions,
): number[] | null {
    const n = NUM_ARM_JOINTS;

    // Tuning knobs (overridable via options)
    // lambda=0.001: workspace-boundary convergence. 0.010 was too conservative near reach limit.
    // contWeight=0: continuity pull prevents convergence for large moves (standoff → can, 12 cm).
    //   Transport steps can re-enable via options.contWeight if wrist-flip is observed.
    const lambda      = options?.lambda     ?? 0.001;
    const regWeight   = options?.regWeight  ?? 0.002;  // Pull toward NEUTRAL_Q
    const contWeight  = options?.contWeight ?? 0.0;
    const posWeight   = 1.0;
    const oriWeight   = 0.1;    // Low: sideQuat col2=[1,0,0] not achievable at z=0.061 (arm tilts 32°);
                              // position dominates. col1=[0,1,0] maintained naturally when J4≈0.
    const eps         = 3e-4;   // Finite-difference step
    const maxIter     = 60;     // Sufficient with lambda=0.001; increase if convergence is slow
    const maxStep     = 0.20;   // Max joint change per iteration (rad) – suppresses wrist flip
    const posTol      = 3e-3;   // 3 mm convergence
    const oriTol      = 0.06;

    // Save and restore qpos so FK probing doesn't corrupt the live simulation
    const savedQpos = Array.from(data.qpos.slice(0, n));
    const q = currentQ.slice(0, n);
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

    for (let iter = 0; iter < maxIter; iter++) {
        // ── Forward kinematics at current q ──────────────────────────────
        for (let i = 0; i < n; i++) data.qpos[i] = q[i];
        mujoco.mj_forward(model, data);

        const posBase = Array.from(data.site_xpos.slice(siteId * 3, siteId * 3 + 3));
        const matBase = Array.from(data.site_xmat.slice(siteId * 9, siteId * 9 + 9));
        const qBase   = rotMatToQuat(matBase);

        // ── 6D error [pos(3) × posW, ori(3) × oriW] ──────────────────────
        const ePos = [
            posWeight * (targetPos.x - posBase[0]),
            posWeight * (targetPos.y - posBase[1]),
            posWeight * (targetPos.z - posBase[2]),
        ];
        const qErr = targetQuat.clone().multiply(qBase.clone().invert()).normalize();
        // Hemisphere check: ensure shorter-arc rotation (w ≥ 0).
        // Without this, when the needed rotation > 180° the error vector points the
        // "long way round", giving a massive gradient that destabilises the solver.
        if (qErr.w < 0) qErr.set(-qErr.x, -qErr.y, -qErr.z, -qErr.w);
        const eOri = [
            oriWeight * 2 * qErr.x,
            oriWeight * 2 * qErr.y,
            oriWeight * 2 * qErr.z,
        ];
        const e = [...ePos, ...eOri];

        if (Math.sqrt(ePos[0]**2+ePos[1]**2+ePos[2]**2) < posTol &&
            Math.sqrt(eOri[0]**2+eOri[1]**2+eOri[2]**2) < oriTol) break;

        // ── Finite-difference Jacobian (6 × n) ───────────────────────────
        const J: number[][] = Array.from({length: 6}, () => new Array(n).fill(0));

        for (let j = 0; j < n; j++) {
            data.qpos[j] = q[j] + eps;
            mujoco.mj_forward(model, data);

            const posP = data.site_xpos.slice(siteId * 3, siteId * 3 + 3);
            const matP = data.site_xmat.slice(siteId * 9, siteId * 9 + 9);

            J[0][j] = posWeight * (posP[0] - posBase[0]) / eps;
            J[1][j] = posWeight * (posP[1] - posBase[1]) / eps;
            J[2][j] = posWeight * (posP[2] - posBase[2]) / eps;

            const qP  = rotMatToQuat(matP);
            const dq  = qP.clone().multiply(qBase.clone().invert()).normalize();
            if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);  // hemisphere consistency with qBase
            J[3][j] = oriWeight * 2 * dq.x / eps;
            J[4][j] = oriWeight * 2 * dq.y / eps;
            J[5][j] = oriWeight * 2 * dq.z / eps;

            data.qpos[j] = q[j]; // restore
        }

        // ── Damped least squares: A Δq = b ───────────────────────────────
        // A = J^T J + (λ + regWeight + contWeight)I
        const totalDamp = lambda + regWeight + contWeight;
        const A: number[][] = Array.from({length: n}, (_, i) =>
            Array.from({length: n}, (_, j) => {
                let sum = 0;
                for (let k = 0; k < 6; k++) sum += J[k][i] * J[k][j];
                return sum + (i === j ? totalDamp : 0);
            })
        );
        // b = J^T e + regWeight*(q_neutral − q) + contWeight*(q_init − q)
        const b: number[] = Array.from({length: n}, (_, i) => {
            let sum = 0;
            for (let k = 0; k < 6; k++) sum += J[k][i] * e[k];
            sum += regWeight  * (NEUTRAL_Q[i]  - q[i]);
            sum += contWeight * (currentQ[i]   - q[i]);  // pull toward initial pose → prevents wrist flip
            return sum;
        });

        const dq = gaussSolve(A, b);
        if (!dq) break;

        for (let i = 0; i < n; i++) {
            // Clamp per-iteration step to suppress wrist-flip jumps
            const step = Math.max(-maxStep, Math.min(maxStep, dq[i]));
            q[i] = clamp(q[i] + step, JOINT_LIMITS[i][0], JOINT_LIMITS[i][1]);
        }
    }

    // Restore simulation state
    for (let i = 0; i < n; i++) data.qpos[i] = savedQpos[i];
    mujoco.mj_forward(model, data);

    return q;
}
