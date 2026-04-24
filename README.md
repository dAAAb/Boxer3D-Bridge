# Boxer3D-Bridge

Vite + MuJoCo browser sim that receives a live `SceneReport` from the
[Boxer3D](https://github.com/dAAAb/Boxer3D) iPhone app and plans robot
actions through [Gemini Robotics-ER 1.6](https://ai.google.dev/gemini-api/docs).

Forked from Google AI Studio's
[Robotics Pick and Place](https://ai.studio/apps/bundled/robotics_franka_pick_and_place)
demo — added a WebSocket bridge so the Franka in the sim mirrors real-world
objects observed by the iPhone's ARKit + BoxerNet.

**Status:** MVP demo. Tracking is live; specific instances can be picked up
by track UUID without going through the VLM. AprilTag calibration and real-arm
(ROS 2) integration are planned but not shipped — see the `## Roadmap`
section.

**License notice:** this repo embeds USDZ meshes originally authored for
[dAAAb/Boxer3D](https://github.com/dAAAb/Boxer3D), which derives from
[BoxerNet (Meta, CC-BY-NC-4.0)](https://facebookresearch.github.io/boxer/).
**Non-commercial use only.** Replace the meshes (or swap the perception
backbone) before any commercial deployment.

## Architecture

```
 iPhone (Boxer3D app)            Mac / host                  Browser
 ┌──────────────────┐           ┌──────────────┐           ┌────────────────┐
 │ ARKit + LiDAR    │           │              │           │                │
 │ + BoxerNet       │──ws://───►│ bridge_server│──ws://───►│ Vite + React   │
 │ SceneReport 10 Hz│  :8787    │   (relay)    │  :8787    │ MuJoCo (WASM)  │
 │  label / OBB /   │           │              │           │ three.js       │
 │  trackUUID / yaw │           │              │           │ Gemini-ER call │
 └──────────────────┘           └──────────────┘           └────────────────┘
                                                                    │
                                                                    ▼
                                                           Franka sim arm
                                                           plans + picks
```

`SceneReport` schema: see [SceneReport.ts](./SceneReport.ts). Coordinate
convention is `mujoco_world` (+X forward from arm base, +Z up, meters),
produced by a fixed ARKit→MuJoCo axis swap in
[BridgeTypes.swift](https://github.com/dAAAb/Boxer3D/blob/main/boxer/bridge/BridgeTypes.swift)
on the iPhone side.

## Setup

### Prerequisites

- **Node.js** 20+ and npm
- **Python** 3.10+ (for the bridge relay server)
- **macOS** — some of the dev tooling assumes it; cross-platform contributions
  welcome
- **Gemini API key** from [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- **iPhone 15 Pro / Pro Max** running the Boxer3D app (for real-world input —
  you can run end-to-end with the fake publisher without an iPhone)
- **Same LAN** between the Mac and the iPhone (or a virtual LAN over Tailscale,
  etc.)

### 1. Clone and install

```bash
git clone https://github.com/dAAAb/Boxer3D-Bridge.git
cd Boxer3D-Bridge
npm install
```

### 2. Configure your Gemini API key

```bash
cp .env.local.example .env.local
# then edit .env.local and paste your key
```

Vite reads `.env.local` on startup; it is gitignored so your key never leaves
your machine. **Restart the dev server after editing**, because Vite only
reads the file once per run.

### 3. Start the relay server

```bash
pip install -r tools/requirements.txt     # first time only
python tools/bridge_server.py             # listens on ws://0.0.0.0:8787
```

Leave it running. If you're on macOS with the Application Firewall enabled,
you may be prompted to allow Python to accept incoming connections — click
**Allow**.

### 4. (Optional) Run without a real iPhone

If you don't have the iPhone app running yet, the fake publisher pretends
to be Boxer3D and streams a fixed 3-object scene (cup / bottle / laptop):

```bash
python tools/fake_publisher.py
```

### 5. Start the Vite app

```bash
npm run dev
# → http://localhost:3000/
# → Network: http://<your-mac-ip>:3000/   ← use this URL on your iPhone's
#   Safari if you want to sanity-check LAN reachability
```

### 6. Connect from the iPhone

Install the Boxer3D app on a LiDAR iPhone (see the
[Boxer3D README](https://github.com/dAAAb/Boxer3D)). In the app:

1. Tap the **bridge icon** (top-right toolbar, next to FSD/stream toggles)
2. Turn **Stream detections** on
3. Grant the **Local Network** permission iOS asks for
4. Set the **WebSocket URL** to `ws://<your-mac-ip>:8787` — find your Mac's
   LAN IP with `ipconfig getifaddr en0` (Wi-Fi) or `ipconfig getifaddr en1`
   (Ethernet)
5. If the sim's object positions appear rotated, flip the **World yaw**
   picker (0° / 90° / 180° / 270°) until the scene matches reality

### 7. Use the sim

- Click the **Radio icon** in the browser's toolbar to snapshot the current
  stream into the sim scene (subsequent motion tracks live)
- Move a real object in front of the iPhone — the corresponding mesh in the
  browser sim moves with it
- Use the **label dropdown** in the sidebar:
  - **All of type (Gemini)** — semantic selection via the VLM: Gemini finds
    the matching object by looking at the sim canvas
  - **Specific track (direct)** — deterministic selection by MOT track UUID:
    skips Gemini, directly marks the body for pickup
- Click **Pickup** to run the Franka arm animation

## Project layout

```
.
├── App.tsx                     # React root — wires everything together
├── MujocoSim.ts                # MuJoCo orchestrator — load, step, stream injection
├── RenderSystem.ts             # three.js scene graph + stream overlays
├── RobotLoader.ts              # MJCF patching (injects stream bodies)
├── SceneReport.ts              # Wire format + ground calibration
├── SceneReportClient.ts        # Browser WS client (reconnects, Blob/ArrayBuffer safe)
├── components/
│   ├── UnifiedSidebar.tsx      # Prompt + track dropdown + Detect/Pickup
│   ├── Toolbar.tsx             # Play/pause/reset + Radio (stream reload)
│   └── RobotSelector.tsx       # Robot model switcher
├── rendering/
│   ├── GeomBuilder.ts          # MuJoCo geom → three.js Mesh
│   └── MeshLibrary.ts          # USDZ loader + white-material override + cache
├── public/meshes/              # USDZ canonical meshes (cup, bottle, laptop, keyboard)
├── tools/
│   ├── bridge_server.py        # All-to-all WS relay
│   ├── fake_publisher.py       # Offline SceneReport generator
│   └── requirements.txt
└── Info.plist                  # (unused on the web side; historical leftover)
```

## Roadmap

- [x] Step 0 — Run reference demo (Franka pick-and-place, Gemini-ER)
- [x] Step 1 — Fake `SceneReport` → sim injection
- [x] Step 2a–d — Host relay, iOS streamer, live tracking end-to-end
- [x] Polish — white USDZ meshes, label sprites, R/G/B axes, crash-proof
      parse, forward offset, min-ground calibration, UUID body naming,
      track-level dropdown with direct pickup
- [ ] **Step 2e** — AprilTag calibration (replaces the manual yaw picker)
- [ ] **Step 3** — Feed iPhone's actual RGB keyframe to Gemini-ER (currently
      Gemini sees the sim canvas snapshot)
- [ ] **Step 4** — Swap Franka MJCF for PiPER (my target arm)
- [ ] **Step 5** — Sim-to-real via ROS 2 / PiPER SDK

## Known limitations

- **ARKit world forward is session-start-dependent.** Until AprilTag
  calibration, the sim's +X direction is whichever way the iPhone was facing
  when the app launched. The World yaw picker compensates in 90° increments.
- **USDZ overlay size is authored, not per-instance.** The cup mesh renders
  at 10.5 cm regardless of the detected OBB size. Accurate for typical
  instances; wrong when users use atypical sizes.
- **BoxerNet has ~3 cm vertical noise.** Objects can float or sink a few
  centimetres from frame to frame. This is ground truth being noisy, not a
  sim bug. Opaque objects are detected more cleanly than transparent ones
  (whose OBB tends to lock onto the rim and miss the base — cup then
  genuinely floats in the stream).

## Acknowledgements

- Base demo: Google AI Studio's
  [Robotics Pick and Place](https://ai.studio/apps/bundled/robotics_franka_pick_and_place)
  (Apache-2.0).
- Perception: [Boxer3D](https://github.com/dAAAb/Boxer3D) / BoxerNet by Meta
  Reality Labs (CC-BY-NC-4.0).
- Sim: [MuJoCo](https://mujoco.org/) via
  [mujoco-js](https://www.npmjs.com/package/mujoco-js),
  [mujoco_menagerie](https://github.com/google-deepmind/mujoco_menagerie)
  (Franka Panda MJCF).
- Planning: [Gemini Robotics-ER 1.6-preview](https://ai.google.dev/gemini-api/docs/gemini).
