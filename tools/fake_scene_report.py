"""
Fake SceneReport producer — Step 1 MVP of the Boxer3D → Gemini bridge.

Runs as a WebSocket server on ws://0.0.0.0:8787. Broadcasts a fixed
3-object scene (cup / bottle / laptop) in MuJoCo world coordinates
every 1 second to every connected client.

Coordinate convention (matches MuJoCo world):
  +X forward (out from Franka base), +Y left, +Z up, meters.
  Franka base sits at origin. Tabletop at z=0.

Usage:
  pip install "websockets>=12"
  python tools/fake_scene_report.py
"""

from __future__ import annotations

import asyncio
import json
import time

import websockets

SCENE = {
    "version": 1,
    "coordinate_frame": "mujoco_world",
    "objects": [
        {
            "id": "cup_1",
            "label": "cup",
            "center_world": [0.45, -0.15, 0.05],
            "size_m": [0.05, 0.05, 0.10],
            "yaw_rad": 0.0,
            "confidence": 0.92,
        },
        {
            "id": "bottle_1",
            "label": "bottle",
            "center_world": [0.55, 0.10, 0.09],
            "size_m": [0.045, 0.045, 0.18],
            "yaw_rad": 0.3,
            "confidence": 0.88,
        },
        {
            "id": "laptop_1",
            "label": "laptop",
            "center_world": [0.40, 0.32, 0.015],
            "size_m": [0.32, 0.22, 0.03],
            "yaw_rad": -0.15,
            "confidence": 0.75,
        },
    ],
}


async def _handler(ws):
    peer = getattr(ws, "remote_address", "?")
    print(f"[fake_scene] client connected: {peer}")
    try:
        while True:
            payload = {**SCENE, "timestamp": time.time()}
            await ws.send(json.dumps(payload))
            await asyncio.sleep(1.0)
    except websockets.ConnectionClosed:
        print(f"[fake_scene] client disconnected: {peer}")


async def main():
    async with websockets.serve(_handler, "0.0.0.0", 8787):
        print("[fake_scene] serving on ws://0.0.0.0:8787")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
