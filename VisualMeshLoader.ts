/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { RenderSystem } from './RenderSystem';
import { MujocoModel } from './types';
import { getName } from './utils/StringUtils';

/**
 * VisualMeshLoader
 * Loads the PiPER's OBJ visual meshes that mujoco-js WASM cannot handle,
 * and attaches them to the correct RenderSystem body groups so they
 * automatically follow MuJoCo physics transforms each frame.
 *
 * Strategy:
 *   1. Fetch the original piper.xml from GitHub to build body → OBJ mappings.
 *   2. Walk <worldbody>, tracking the current body context as we descend.
 *   3. For each <geom class="visual"> referencing an OBJ mesh, fetch and parse
 *      the OBJ (using THREE.OBJLoader), then add a clone to renderSys.bodies[bodyId].
 *   4. The body groups are already auto-updated from mjData.xpos/xquat each frame,
 *      so the visual meshes ride along for free.
 */
export class VisualMeshLoader {
    private renderSys: RenderSystem;
    private baseUrl: string;

    constructor(renderSys: RenderSystem, robotId: string) {
        this.renderSys = renderSys;
        this.baseUrl = `/robots/${robotId}/`;
    }

    async load(mjModel: MujocoModel, onProgress?: (msg: string) => void): Promise<void> {
        // ── 1. Fetch and parse piper.xml ─────────────────────────────────────
        if (onProgress) onProgress('Fetching OBJ visual mesh map...');
        let xmlText: string;
        try {
            const res = await fetch(this.baseUrl + 'piper.xml');
            if (!res.ok) { console.warn('VisualMeshLoader: failed to fetch piper.xml'); return; }
            xmlText = await res.text();
        } catch (e) {
            console.warn('VisualMeshLoader: network error fetching piper.xml', e);
            return;
        }

        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'text/xml');

        // ── 2. Get meshdir prefix from <compiler> ─────────────────────────────
        const compiler = doc.querySelector('compiler');
        const meshdir   = compiler?.getAttribute('meshdir') ?? '';

        // ── 2b. Parse <material> declarations → name → THREE color hex ───
        // PiPER's piper.xml defines a per-link palette (red_mat, gray_mat,
        // dark_gray_mat, white_mat, ...). Without this every visual mesh
        // got a single shared grey-steel default and the arm rendered
        // uniformly dark. Parse rgba="r g b a" into a 0xRRGGBB integer.
        //
        // Cosmetic re-map: PiPER MJCF over-paints body sections with
        // dark_gray_mat / darker_gray_mat / black_mat (vents, screw heads,
        // sticker decals) so the body comes out noticeably darker than the
        // STL-rendered base / wrist (which use gray_mat). User preference
        // is uniform medium gray matching the AGILEX product photos, so
        // collapse the gray-spectrum materials into a single neutral.
        // Coloured accents (red_mat, white_mat, light_blue) pass through.
        const grayCollapse = new Set([
            'gray_mat', 'dark_gray_mat', 'darker_gray_mat',
            'light_gray_mat', 'light_medium_gray_mat', 'black_mat',
        ]);
        const NEUTRAL_GRAY = 0x969696; // gray_mat 0.59 → 150
        const materialMap = new Map<string, number>();
        doc.querySelectorAll('material').forEach((el) => {
            const name = el.getAttribute('name');
            const rgba = el.getAttribute('rgba');
            if (!name || !rgba) return;
            if (grayCollapse.has(name)) {
                materialMap.set(name, NEUTRAL_GRAY);
                return;
            }
            const parts = rgba.trim().split(/\s+/).map(Number);
            if (parts.length < 3) return;
            const r = Math.max(0, Math.min(1, parts[0]));
            const g = Math.max(0, Math.min(1, parts[1]));
            const b = Math.max(0, Math.min(1, parts[2]));
            const hex = (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
            materialMap.set(name, hex);
        });

        // ── 3. Build meshName → resolved file path map (OBJ only) ────────────
        // piper.xml declares meshes WITHOUT a name= attribute, e.g. <mesh file="link2_0.obj"/>
        // MuJoCo infers the name from the filename minus extension in that case.
        const meshFileMap = new Map<string, string>();
        doc.querySelectorAll('mesh').forEach(el => {
            const file = el.getAttribute('file');
            if (!file || !file.toLowerCase().endsWith('.obj')) return;
            const explicit = el.getAttribute('name');
            const basename = file.split('/').pop()!;
            const name = explicit ?? basename.replace(/\.[^.]+$/, '');
            meshFileMap.set(name, meshdir ? `${meshdir}/${file}` : file);
        });

        if (meshFileMap.size === 0) {
            console.log('VisualMeshLoader: no OBJ meshes declared in piper.xml');
            return;
        }

        // ── 4. Build bodyName → MuJoCo body ID map ────────────────────────────
        const bodyNameToId = new Map<string, number>();
        for (let i = 0; i < mjModel.nbody; i++) {
            bodyNameToId.set(getName(mjModel, mjModel.name_bodyadr[i]), i);
        }

        // ── 5. Walk <worldbody> to collect geom entries ───────────────────────
        interface GeomEntry {
            bodyName: string;
            meshName: string;
            materialName: string | null;
            pos:  [number, number, number];
            quat: [number, number, number, number]; // MuJoCo [w, x, y, z]
        }
        const geomEntries: GeomEntry[] = [];

        const splitNums = (attr: string | null): number[] =>
            attr ? attr.trim().split(/\s+/).map(Number) : [];

        const walk = (el: Element, bodyName: string) => {
            for (const child of Array.from(el.children)) {
                const tag = child.tagName.toLowerCase();
                if (tag === 'body') {
                    walk(child, child.getAttribute('name') ?? bodyName);
                } else if (tag === 'geom') {
                    const cls      = child.getAttribute('class');
                    const meshName = child.getAttribute('mesh');
                    if (cls === 'visual' && meshName && meshFileMap.has(meshName)) {
                        const p = splitNums(child.getAttribute('pos'));
                        const q = splitNums(child.getAttribute('quat'));
                        geomEntries.push({
                            bodyName,
                            meshName,
                            materialName: child.getAttribute('material'),
                            pos:  [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0],
                            quat: q.length >= 4
                                ? [q[0], q[1], q[2], q[3]]
                                : [1, 0, 0, 0],
                        });
                    }
                }
            }
        };

        const worldbody = doc.querySelector('worldbody');
        if (worldbody) walk(worldbody, 'world');

        if (geomEntries.length === 0) {
            console.log('VisualMeshLoader: no OBJ visual geoms found in worldbody');
            return;
        }

        if (onProgress) onProgress(`Loading ${geomEntries.length} OBJ visual meshes...`);

        // ── 6. Load OBJ files, clone, and attach to body groups ───────────────
        const objLoader = new OBJLoader();
        const cache     = new Map<string, THREE.Group>();

        // Per-material cache (one MeshStandardMaterial per unique XML
        // material name). Falls back to a shared steel-grey when the
        // geom has no `material=` attribute or the name isn't declared.
        const materialCache = new Map<string, THREE.MeshStandardMaterial>();
        // Match GeomBuilder.ts (roughness 0.6, metalness 0.2) so OBJ
        // link2-5 shade identically to the STL base/wrist that mujoco-js
        // renders directly. Earlier mismatch (0.45/0.3) made the body
        // look noticeably darker than the gripper under the same light.
        const fallbackMat = new THREE.MeshStandardMaterial({
            color: NEUTRAL_GRAY, roughness: 0.6, metalness: 0.2,
        });
        const getMat = (name: string | null): THREE.MeshStandardMaterial => {
            if (!name) return fallbackMat;
            const cached = materialCache.get(name);
            if (cached) return cached;
            const hex = materialMap.get(name);
            if (hex === undefined) return fallbackMat;
            const m = new THREE.MeshStandardMaterial({
                color: hex,
                roughness: 0.6,
                metalness: 0.2,
            });
            materialCache.set(name, m);
            return m;
        };

        for (const entry of geomEntries) {
            const bodyId = bodyNameToId.get(entry.bodyName);
            if (bodyId === undefined || !this.renderSys.bodies[bodyId]) {
                console.warn(`VisualMeshLoader: body "${entry.bodyName}" not found in renderSys`);
                continue;
            }

            const filePath = meshFileMap.get(entry.meshName)!;

            // Load once, cache by path. Material is applied per-clone
            // below (because two geoms may reuse the same OBJ file but
            // need different materials, e.g. red vs gray plates on link2).
            if (!cache.has(filePath)) {
                try {
                    const r = await fetch(this.baseUrl + filePath);
                    if (!r.ok) {
                        console.warn(`VisualMeshLoader: 404 ${filePath}`);
                        cache.set(filePath, new THREE.Group()); // placeholder so we don't retry
                        continue;
                    }
                    const objText = await r.text();
                    const parsed  = objLoader.parse(objText);
                    cache.set(filePath, parsed);
                    if (onProgress) onProgress(`OBJ loaded: ${filePath}`);
                } catch (e) {
                    console.warn(`VisualMeshLoader: error parsing ${filePath}`, e);
                    cache.set(filePath, new THREE.Group());
                    continue;
                }
            }

            const src   = cache.get(filePath)!;
            const clone = src.clone(true);

            // Apply per-geom material (looked up by the XML material name).
            const mat = getMat(entry.materialName);
            clone.traverse((c) => {
                if ((c as THREE.Mesh).isMesh) {
                    (c as THREE.Mesh).material = mat;
                    c.castShadow = true;
                    c.receiveShadow = true;
                }
            });

            // Apply the geom-local offset declared in MJCF (usually zero for PiPER)
            clone.position.set(...entry.pos);
            // MuJoCo quat is [w,x,y,z]; THREE.Quaternion takes (x,y,z,w)
            clone.quaternion.set(entry.quat[1], entry.quat[2], entry.quat[3], entry.quat[0]);

            this.renderSys.bodies[bodyId].add(clone);
        }

        if (onProgress) onProgress('OBJ visual meshes ready.');
    }
}
