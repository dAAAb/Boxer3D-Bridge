"""
Bridge relay server for the Boxer3D → Gemini MVP.

Pure pub/sub relay. Any message received from any connected client
is broadcast to every other connected client as-is. No schema
validation, no history replay — latest-wins by design (new subscribers
see nothing until the next publish).

Topology:
  iPhone Boxer3D (publisher)  ─┐
  tools/fake_publisher.py      ├──► ws://host:8787 ──► browser Vite sim
                               ┘                   ──► any other subscriber

Usage:
  pip install "websockets>=12"
  python tools/bridge_server.py [--host 0.0.0.0 --port 8787]
"""

from __future__ import annotations

import argparse
import asyncio
import logging

import websockets

log = logging.getLogger("bridge")


async def _handler(ws, clients: set):
    peer = getattr(ws, "remote_address", "?")
    clients.add(ws)
    log.info("connect peer=%s total=%d", peer, len(clients))
    try:
        async for message in ws:
            dead = []
            for client in clients:
                if client is ws:
                    continue
                try:
                    await client.send(message)
                except websockets.ConnectionClosed:
                    dead.append(client)
            for d in dead:
                clients.discard(d)
    finally:
        clients.discard(ws)
        log.info("disconnect peer=%s total=%d", peer, len(clients))


async def main(host: str, port: int):
    clients: set = set()

    async def handler(ws):
        await _handler(ws, clients)

    async with websockets.serve(handler, host, port):
        log.info("serving ws://%s:%d (relay all-to-all)", host, port)
        await asyncio.Future()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="[bridge] %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8787)
    args = ap.parse_args()
    asyncio.run(main(args.host, args.port))
