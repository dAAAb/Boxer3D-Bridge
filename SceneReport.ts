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

export interface SceneReport {
  version?: number;
  timestamp: number;
  coordinate_frame?: string;
  objects: SceneObject[];
}

const LABEL_COLORS: Record<string, string> = {
  cup: '0.85 0.20 0.20 1',
  bottle: '0.15 0.35 0.85 1',
  laptop: '0.15 0.70 0.20 1',
  keyboard: '0.85 0.75 0.15 1',
  bowl: '0.70 0.40 0.15 1',
  phone: '0.50 0.20 0.75 1',
  default: '0.55 0.55 0.55 1',
};

export function sceneReportToMjcf(scene: SceneReport): string {
  const parts: string[] = [];
  scene.objects.forEach((obj) => {
    const [x, y, z] = obj.center_world;
    const [w, h, d] = obj.size_m;
    const hx = (w / 2).toFixed(4);
    const hy = (h / 2).toFixed(4);
    const hz = (d / 2).toFixed(4);
    const color = LABEL_COLORS[obj.label] ?? LABEL_COLORS.default;
    const safeName = `obj_${obj.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    parts.push(
      `<body name="${safeName}" pos="${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}" euler="0 0 ${obj.yaw_rad.toFixed(4)}">` +
      `<freejoint/>` +
      `<geom type="box" size="${hx} ${hy} ${hz}" rgba="${color}" mass="0.05" friction="1.5 0.3 0.1" solref="0.01 1" solimp="0.95 0.99 0.001 0.5 2" condim="4"/>` +
      `</body>`
    );
  });
  parts.push(`<body name="stack_base" pos="0.6 0 0.0"><geom type="box" size="0.1 0.1 0.005" rgba="0.3 0.3 0.3 1"/></body>`);
  return parts.join('');
}
