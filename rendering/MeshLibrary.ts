/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
// USDZLoader was deprecated in favour of USDLoader in recent three.js. USDLoader
// handles both plain USD/USDA and the zipped USDZ container (which is the
// format the Boxer3D iPhone ships).
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js';

/// Label → URL mapping. Keep in sync with public/meshes/ contents.
const LABEL_MESH_URLS: Record<string, string> = {
  cup: '/meshes/cup.usdz',
  bottle: '/meshes/bottle.usdz',
  laptop: '/meshes/laptop.usdz',
  keyboard: '/meshes/keyboard.usdz',
};

const WHITE_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.65,
  metalness: 0.02,
});

/**
 * Loads and caches the Boxer3D iPhone USDZ meshes for overlay rendering on
 * MuJoCo stream bodies. USDZ sources are authored in real-world metres with
 * +Y up (Blender / SceneKit convention); we rotate to +Z up to match the
 * MuJoCo world. Materials are replaced with a single white MeshStandardMaterial
 * so the overlay reads as "Tesla canonical white mesh" regardless of any
 * baked textures in the USDZ.
 */
export class MeshLibrary {
  private loader = new USDLoader();
  private cache = new Map<string, THREE.Group>();
  private loading = new Map<string, Promise<THREE.Group | null>>();

  /** Return a fresh clone of the loaded mesh, or null if the label has none. */
  async get(label: string): Promise<THREE.Group | null> {
    const template = await this.ensureLoaded(label);
    if (!template) return null;
    return template.clone(true);
  }

  /** Preload meshes for a list of labels in parallel. */
  async prefetch(labels: string[]): Promise<void> {
    const unique = Array.from(new Set(labels));
    await Promise.all(unique.map((l) => this.ensureLoaded(l)));
  }

  private ensureLoaded(label: string): Promise<THREE.Group | null> {
    const cached = this.cache.get(label);
    if (cached) return Promise.resolve(cached);
    const inFlight = this.loading.get(label);
    if (inFlight) return inFlight;
    const url = LABEL_MESH_URLS[label];
    if (!url) return Promise.resolve(null);
    const p = this.loadFromUrl(label, url);
    this.loading.set(label, p);
    return p;
  }

  private async loadFromUrl(label: string, url: string): Promise<THREE.Group | null> {
    try {
      const group = await this.loader.loadAsync(url);
      // Boxer3D USDZs are authored Z-up (Blender export, verified via
      // `upAxis = "Z"` in the USDA header), which already matches the
      // MuJoCo world. No axis swap needed — rotating +90° around X was
      // tipping the meshes onto their side.
      const wrapper = new THREE.Group();
      wrapper.add(group);
      wrapper.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.isMesh) {
          m.material = WHITE_MATERIAL;
          m.castShadow = true;
          m.receiveShadow = false;
        }
      });
      this.cache.set(label, wrapper);
      return wrapper;
    } catch (err) {
      console.warn(`[MeshLibrary] failed to load ${label} (${url}):`, err);
      return null;
    }
  }
}
