"""
Fake SceneReport publisher — connects to bridge_server.py as a client
and publishes a static 3-object scene (cup / bottle / laptop) every
second. Used to exercise the MVP loop without a real iPhone.

Coordinates: MuJoCo world (+X forward from Franka base, +Y left, +Z up),
meters. Objects sized to fit within Franka gripper (~8 cm max opening).

Usage:
  pip install "websockets>=12"
  # Terminal 1:
  python tools/bridge_server.py
  # Terminal 2:
  python tools/fake_publisher.py [--url ws://localhost:8787]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import time

import websockets

log = logging.getLogger("fake_publisher")

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
            "center_world": [0.30, 0.35, 0.015],
            "size_m": [0.28, 0.20, 0.03],
            "yaw_rad": -0.15,
            "confidence": 0.75,
        },
    ],
}


async def run(url: str, rate_hz: float):
    period = 1.0 / rate_hz
    while True:
        try:
            async with websockets.connect(url) as ws:
                log.info("connected to %s", url)
                while True:
                    payload = {**SCENE, "timestamp": time.time()}
                    await ws.send(json.dumps(payload))
                    await asyncio.sleep(period)
        except (OSError, websockets.WebSocketException) as e:
            log.warning("disconnected (%s) — retrying in 2 s", e)
            await asyncio.sleep(2.0)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="[fake_publisher] %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://localhost:8787")
    ap.add_argument("--rate", type=float, default=1.0, help="publish rate in Hz")
    args = ap.parse_args()
    asyncio.run(run(args.url, args.rate))
