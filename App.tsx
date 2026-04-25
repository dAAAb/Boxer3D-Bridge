/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { GoogleGenAI } from "@google/genai";
import { AlertCircle, Loader2, X } from 'lucide-react';
import loadMujoco from 'mujoco_wasm';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { v4 as uuidv4 } from 'uuid';
import { MujocoSim } from './MujocoSim';
import { SceneObject, SceneReport, streamBodyName } from './SceneReport';
import { SceneReportClient } from './SceneReportClient';
import { RobotFunctionCall, expandPlan, predictPlanFinalPositions } from './actionLibrary';
import { planActions } from './geminiPlan';
import { mujocoToArkit, worldToGemini1000 } from './projection';
import { RobotSelector } from './components/RobotSelector';
import { Toolbar } from './components/Toolbar';
import { UnifiedSidebar } from './components/UnifiedSidebar';
import { DetectedItem, DetectType, LogEntry, MujocoModule } from './types';

const SCENE_REPORT_WS_URL = 'ws://localhost:8787';

/**
 * Default prompt parts for different detection types.
 */
export const defaultPromptParts = {
  '2D bounding boxes': [
    'Detect',
    'items',
    ', with no more than 25 items. DO NOT detect items that only match the description partially. Output a json list where each entry contains the 2D bounding box in "box_2d" and a text label in "label".',
  ],
  'Segmentation masks': [
    `Give the segmentation masks for`,
    'all objects',
    `. Output a JSON list of segmentation masks where each entry contains the 2D bounding box in the key "box_2d", the segmentation mask in key "mask", and the text label in the key "label". Use descriptive labels."`,
  ],
  'Points': [
    'Identify ',
    'items',
    ' in the scene and mark them with points. DO NOT mark items that only match the description partially. Follow the JSON format: [{"point": [y, x], "label": "label"}, ...]. The points are in [y, x] format normalized to 0-1000.',
  ],
};

interface LogOverlayProps {
  log: LogEntry;
}

/**
 * LogOverlay
 * Draws Gemini detection results (boxes/points) over an image.
 * Uses a normalized 1000x1000 coordinate system.
 */
export function LogOverlay({ log }: LogOverlayProps) {
  if (!log.result || !Array.isArray(log.result)) return null;

  const results = log.result as DetectedItem[];
  const shapes = results.map((item, idx) => {
    if (Array.isArray(item?.box_2d) && item.box_2d.length === 4) {
      const [ymin, xmin, ymax, xmax] = item.box_2d;
      return (
        <rect 
          key={idx} x={xmin} y={ymin} width={xmax - xmin} height={ymax - ymin} 
          fill="rgba(79, 70, 229, 0.15)" stroke="#4f46e5" strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      );
    } else if (Array.isArray(item?.point) && item.point.length === 2) {
      const [y, x] = item.point;
      // Using vector-effect="non-scaling-stroke" ensures the circle border is visible even in small miniatures.
      // cx/cy are normalized 0-1000.
      return <circle key={idx} cx={x} cy={y} r="10" fill="#4f46e5" stroke="white" strokeWidth="2" vectorEffect="non-scaling-stroke" />;
    }
    return null;
  });

  return (
    <svg 
      viewBox="0 0 1000 1000" 
      preserveAspectRatio="none" 
      className="absolute inset-0 pointer-events-none w-full h-full z-10"
    >
      {shapes}
    </svg>
  );
}

/**
 * Main Application Component
 */
export function App() {
  const containerRef = useRef<HTMLDivElement>(null); 
  const simRef = useRef<MujocoSim | null>(null);      
  const isMounted = useRef(true);                     
  const mujocoModuleRef = useRef<MujocoModule | null>(null);          

  const [isLoading, setIsLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState("Initializing Spatial Engine...");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mujocoReady, setMujocoReady] = useState(false); 
  
  const [isPaused, setIsPaused] = useState(false);
  // Initialize sidebar based on screen width (hidden on mobile by default)
  const [showSidebar, setShowSidebar] = useState(() => window.innerWidth >= 660); 
  const [isDarkMode, setIsDarkMode] = useState(false);
  
  const [erLoading, setErLoading] = useState(false);
  const [logs, setLogs] = useState<Array<LogEntry>>([]);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [flash, setFlash] = useState(false); 
  const detectedTargets = useRef<Array<{pos: THREE.Vector3, markerId: number}>>([]); 
  const [detectedCount, setDetectedCount] = useState(0); 
  
  const [isPickingUp, setIsPickingUp] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  const [gizmoStats, setGizmoStats] = useState<{pos: string, rot: string} | null>(null);

  const sceneClientRef = useRef<SceneReportClient | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [hasStreamScene, setHasStreamScene] = useState(false);
  const [streamLabels, setStreamLabels] = useState<string[]>([]);
  const [streamObjects, setStreamObjects] = useState<{ label: string; id: string }[]>([]);
  /// Goes true when the stream has track UUIDs that don't exist in the
  /// sim's current streamBodyMap — i.e. BoxerNet has surfaced a new or
  /// respawned track since the last Radio sync. Surfaced as a pulsing
  /// amber dot on the toolbar nudging the user to re-sync.
  const [streamStale, setStreamStale] = useState(false);
  /// Prompt text lives in App.tsx (not the sidebar) so the Radio-click
  /// handler can auto-fill it with the first detected label when the
  /// user hasn't yet typed a custom query. Lets a fresh-launch demo
  /// reload directly into a sensible 'cup' / 'laptop' rather than the
  /// hardcoded 'red cubes' that has nothing to do with the user's
  /// real-world scene.
  const [prompt, setPrompt] = useState('red cubes');

  // ─── Step 3.5 pipeline state ──────────────────────────────────────
  // 3 user-facing stages: Detect (locate) → Plan (LLM action sequence)
  // → Execute (run on sim arm). The B+ UX is: pressing any later
  // stage's button auto-cascades all prerequisite stages first. Status
  // chips show ✓ done / ⟳ in-progress / • pending. Failure at any
  // stage resets the whole pipeline to Idle and surfaces the error.
  type PipelineStage = 'detect' | 'plan' | 'execute';
  type PipelineStatus = 'pending' | 'running' | 'done' | 'failed';
  const [pipelineStatus, setPipelineStatus] = useState<Record<PipelineStage, PipelineStatus>>({
    detect: 'pending',
    plan: 'pending',
    execute: 'pending',
  });
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [pipelinePlan, setPipelinePlan] = useState<RobotFunctionCall[]>([]);
  const pipelineRunning = useRef(false);
  // The SceneReport that was used by the most recent Detect — Stage 2
  // looks up track positions in its `objects[]` to expand the plan.
  const lastDetectScene = useRef<SceneReport | null>(null);

  // Deriving activeLog directly from the latest logs state ensures UI reactivity
  const activeLog = expandedLogId ? logs.find(l => l.id === expandedLogId) : null;

  useEffect(() => {
    isMounted.current = true;
    loadMujoco({
      locateFile: (path: string) => path.endsWith('.wasm') ? "https://unpkg.com/mujoco-js@0.0.7/dist/mujoco_wasm.wasm" : path,
      printErr: (text: string) => { 
        if (text.includes("Aborted") && isMounted.current) {
            setLoadError(prev => prev ? prev : "Simulation crashed. Reload page."); 
        }
      }
    }).then((inst: unknown) => { 
      if (isMounted.current) { 
        mujocoModuleRef.current = inst as MujocoModule; 
        setMujocoReady(true); 
      } 
    }).catch((err: Error) => { 
      if (isMounted.current) { 
        setLoadError(err.message || "Failed to init spatial simulation"); 
        setIsLoading(false); 
      } 
    });
    return () => { isMounted.current = false; simRef.current?.dispose(); };
  }, []);

  useEffect(() => {
      if (!mujocoReady || !containerRef.current || !mujocoModuleRef.current) return;
      setIsLoading(true); 
      setLoadError(null); 
      setIsPaused(false);
      
      simRef.current?.dispose();
      
      try {
          simRef.current = new MujocoSim(containerRef.current, mujocoModuleRef.current);
          simRef.current.renderSys.setDarkMode(isDarkMode);
          
          simRef.current.init("franka_panda_stack", "scene.xml", (msg) => {
             if (isMounted.current) setLoadingStatus(msg);
          })
             .then(() => {
                 if (isMounted.current) {
                     simRef.current?.setIkEnabled(false);
                     setIsLoading(false);
                 }
             })
             .catch(err => { 
                 if (isMounted.current) { 
                     setLoadError(err.message); 
                     setIsLoading(false); 
                 } 
             });
             
      } catch (err: unknown) { 
          if (isMounted.current) { setLoadError((err as Error).message); setIsLoading(false); } 
      }
  }, [mujocoReady]);

  // Effect to move camera when sidebar toggles
  useEffect(() => {
    if (isLoading || !simRef.current || erLoading) return;
    
    // Standard view when sidebar is closed
    const standardPos = new THREE.Vector3(2.2, -1.2, 2.2);
    const standardTarget = new THREE.Vector3(0, 0, 0);
    
    // Offset view to shift robot left when sidebar is open
    const offsetPos = new THREE.Vector3(2.35, -0.7, 2.2);
    const offsetTarget = new THREE.Vector3(0.15, 0.4, 0.05);
    
    // Only offset camera on desktop/tablet (width >= 660px). On mobile, keep centered.
    if (showSidebar && window.innerWidth >= 660) {
      simRef.current.renderSys.moveCameraTo(offsetPos, offsetTarget, 1000);
    } else {
      simRef.current.renderSys.moveCameraTo(standardPos, standardTarget, 1000);
    }
  }, [showSidebar, isLoading, erLoading]);

  useEffect(() => {
      if (isLoading) return;
      let animId: number;
      const uiLoop = () => {
          if (simRef.current) {
              const s = simRef.current.getGizmoStats();
              setGizmoStats(s ? { 
                  pos: `X: ${s.pos.x.toFixed(2)}, Y: ${s.pos.y.toFixed(2)}, Z: ${s.pos.z.toFixed(2)}`, 
                  rot: `X: ${s.rot.x.toFixed(2)}, Y: ${s.rot.y.toFixed(2)}, Z: ${s.rot.z.toFixed(2)}` 
              } : null);
          }
          animId = requestAnimationFrame(uiLoop);
      };
      uiLoop();
      return () => cancelAnimationFrame(animId);
  }, [isLoading]);

  useEffect(() => {
    const client = new SceneReportClient(SCENE_REPORT_WS_URL);
    sceneClientRef.current = client;
    client.start();
    // Live teleport stream bodies to match iPhone's latest OBBs. No-op
    // until the user clicks Radio and MujocoSim has registered the
    // current scene's bodies in its stream map.
    const offUpdate = client.onUpdate((report) => {
      simRef.current?.applyStreamUpdate(report);
    });
    const poll = window.setInterval(() => {
      setStreamConnected(client.connected);
      setHasStreamScene(client.latest !== null);
      const rawObjs = client.latest?.objects ?? [];
      const objs = rawObjs.map((o) => ({ label: o.label, id: o.id }));
      const unique = Array.from(new Set(objs.map((o) => o.label))).sort();
      setStreamLabels((prev) =>
        prev.length === unique.length && prev.every((l, i) => l === unique[i]) ? prev : unique
      );
      setStreamObjects((prev) => {
        if (prev.length !== objs.length) return objs;
        for (let i = 0; i < prev.length; i++) {
          if (prev[i].id !== objs[i].id || prev[i].label !== objs[i].label) return objs;
        }
        return prev;
      });
      // Stale check: any track UUID in the stream that the sim doesn't
      // know about? We only flag stale once Radio has been pressed at
      // least once (sim's streamBodyMap non-empty) — pre-Radio is the
      // normal "ready to first-sync" state, not staleness.
      const simKeys = simRef.current?.getStreamBodyKeys();
      let stale = false;
      if (simKeys && simKeys.size > 0 && objs.length > 0) {
        for (const o of objs) {
          if (!simKeys.has(streamBodyName(o.label, o.id))) { stale = true; break; }
        }
      }
      setStreamStale(stale);
    }, 500);
    return () => {
      window.clearInterval(poll);
      offUpdate();
      client.dispose();
      sceneClientRef.current = null;
    };
  }, []);

  const handleReloadFromStream = async () => {
    const scene = sceneClientRef.current?.latest;
    if (!scene || !simRef.current) return;
    setIsLoading(true);
    setLoadingStatus('Reloading sim from SceneReport...');
    setLogs([]);
    setDetectedCount(0);
    setIsPickingUp(false);
    setPlaybackSpeed(1);
    detectedTargets.current = [];
    try {
      await simRef.current.reloadWithScene(scene, (msg) => {
        if (isMounted.current) setLoadingStatus(msg);
      });
      if (isMounted.current) {
        simRef.current.setIkEnabled(false);
        setIsLoading(false);
        // Auto-fill the prompt with the first detected label only when
        // the user hasn't typed anything custom — i.e. it's still the
        // hardcoded 'red cubes' demo seed or empty. Once the user has
        // typed something else we leave their text alone, even on
        // subsequent Radio clicks.
        const firstLabel = scene.objects[0]?.label;
        if (firstLabel && (prompt === 'red cubes' || prompt.trim() === '')) {
          setPrompt(firstLabel);
        }
      }
    } catch (err: unknown) {
      if (isMounted.current) {
        setLoadError((err as Error).message);
        setIsLoading(false);
      }
    }
  };

  /// Reset all pipeline chips to Idle. Used at the top of every fresh
  /// pipeline run AND on failure to give the user a clean slate.
  const resetPipeline = () => {
    setPipelineStatus({ detect: 'pending', plan: 'pending', execute: 'pending' });
    setPipelineError(null);
    setPipelinePlan([]);
    pipelineRunning.current = false;
    simRef.current?.renderSys.clearPlanPreview();
  };

  /// Direct-pickup path: bypass Gemini and target a specific tracked body
  /// by its Boxer3D UUID. Cleaner than routing a unique instance through a
  /// VLM that can't distinguish identical-looking meshes.
  const handleDirectPick = (label: string, trackId: string) => {
    if (!simRef.current) return;
    const pos = simRef.current.getStreamBodyPosition(label, trackId);
    if (!pos) return;
    simRef.current.renderSys.clearErMarkers();
    detectedTargets.current = [];
    setIsPickingUp(false);
    setPlaybackSpeed(1);
    const markerId = Date.now() + Math.random();
    simRef.current.renderSys.addErMarker(pos, label, markerId);
    detectedTargets.current.push({ pos, markerId });
    setDetectedCount(1);
  };

  const toggleDarkMode = () => {
    const next = !isDarkMode;
    setIsDarkMode(next);
    simRef.current?.renderSys.setDarkMode(next);
  };

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
        if (simRef.current && !isLoading && !erLoading) {
            const markerPos = simRef.current.renderSys.checkMarkerClick(e.clientX, e.clientY);
            if (markerPos) {
                simRef.current.moveIkTargetTo(markerPos, 2000);
                simRef.current.setIkEnabled(true);
            }
        }
    };
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, [isLoading, erLoading]);

  /// Returns the SceneReport that was active during the last Detect — used
  /// by Plan stage to expand high-level RobotFunctionCalls into primitive
  /// steps with current track positions.
  const lookupTrackPos = (trackId: string): THREE.Vector3 | null => {
    const scene = lastDetectScene.current;
    if (!scene) return null;
    const obj = scene.objects.find((o) => o.id === trackId);
    if (!obj) return null;
    // Try stream lookup first (works when track_id is a UUID and a
    // stream body was injected). Fall back to direct body-name lookup
    // for synthetic scenes built from MuJoCo bodies (track_id IS the
    // body name there, e.g. "cube0").
    return (
      simRef.current?.getStreamBodyPosition(obj.label, trackId) ??
      simRef.current?.getBodyPositionByName(trackId) ??
      null
    );
  };

  /// B+ pipeline: each stage is independently runnable and auto-cascades
  /// any prerequisite stages. Pressing Detect runs only Detect; pressing
  /// Plan runs Detect (if pending) then Plan; pressing Execute runs all
  /// three. State is stored in pipelineStatus so the chips reflect
  /// progress; a failure at any stage resets the whole pipeline to Idle
  /// and surfaces the error message.
  const runPipeline = async (
    stopAt: PipelineStage,
    prompt: string,
    type: DetectType,
    temperature: number,
    enableThinking: boolean,
    modelId: string,
  ) => {
    if (pipelineRunning.current) return;
    pipelineRunning.current = true;
    setPipelineError(null);

    try {
      // ── Stage 1 — Detect ──
      if (pipelineStatus.detect !== 'done') {
        setPipelineStatus((s) => ({ ...s, detect: 'running' }));
        await runDetectStage(prompt, type, temperature, enableThinking, modelId);
        setPipelineStatus((s) => ({ ...s, detect: 'done' }));
      }
      if (stopAt === 'detect') return;

      // ── Stage 2 — Plan ──
      if (pipelineStatus.plan !== 'done') {
        setPipelineStatus((s) => ({ ...s, plan: 'running' }));
        const calls = await runPlanStage(prompt, temperature, enableThinking, modelId);
        setPipelinePlan(calls);
        setPipelineStatus((s) => ({ ...s, plan: 'done' }));
      }
      if (stopAt === 'plan') return;

      // ── Stage 3 — Execute ──
      setPipelineStatus((s) => ({ ...s, execute: 'running' }));
      await runExecuteStage();
      setPipelineStatus((s) => ({ ...s, execute: 'done' }));
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error('[pipeline] failed:', err);
      setPipelineError(msg);
      // Mark whichever stage was running as failed; reset the rest.
      setPipelineStatus((s) => ({
        detect:  s.detect  === 'running' ? 'failed' : s.detect,
        plan:    s.plan    === 'running' ? 'failed' : s.plan,
        execute: s.execute === 'running' ? 'failed' : s.execute,
      }));
      // Auto-clear chips after a moment so the next run starts clean.
      window.setTimeout(() => resetPipeline(), 4000);
    } finally {
      pipelineRunning.current = false;
    }
  };

  const runPlanStage = async (
    task: string,
    temperature: number,
    enableThinking: boolean,
    modelId: string,
  ): Promise<RobotFunctionCall[]> => {
    const scene = lastDetectScene.current;
    if (!scene) throw new Error('Plan: no scene from Detect stage');
    const apiKey = process.env.API_KEY ?? '';
    const result = await planActions(apiKey, modelId, task, scene.objects, {
      temperature,
      thinking: enableThinking,
    });
    if (result.calls.length === 0) {
      throw new Error(
        `Plan: Gemini returned no actionable calls. ${result.warnings.join('; ') || result.rawText.slice(0, 200)}`,
      );
    }
    // Visual feedback: drop a blue ER cone on every track_id the plan
    // references so the user can see at a glance which objects Franka
    // is about to touch. Mirrors the cones that used to appear during
    // VLM Detect — the semantic moves from 'what Gemini saw' to 'what
    // the plan picked', which is more useful anyway.
    const referenced = new Set<string>();
    for (const call of result.calls) {
      const args = (call as { args?: { track_id?: string } }).args;
      if (args?.track_id) referenced.add(args.track_id);
    }
    if (referenced.size > 0 && simRef.current) {
      simRef.current.renderSys.clearErMarkers();
      detectedTargets.current = [];
      for (const trackId of referenced) {
        const pos = lookupTrackPos(trackId);
        if (!pos) continue;
        const markerId = Date.now() + Math.random();
        simRef.current.renderSys.addErMarker(pos, trackId, markerId);
        detectedTargets.current.push({ pos, markerId });
      }
      setDetectedCount(detectedTargets.current.length);
    }

    // Tesla-FSD-style ghost overlay: translucent boxes at each cube's
    // predicted final position + arrows from current → predicted. Lets
    // the user SEE what the plan intends to do before pressing Execute,
    // and (during Execute) see real cubes catch up to ghosts. Cleared
    // on Execute completion / new Detect / reset.
    if (simRef.current && scene.objects.length > 0) {
      const predictions = predictPlanFinalPositions(result.calls, lookupTrackPos);
      const items: { trackId: string; currentPos: THREE.Vector3; finalPos: THREE.Vector3; size: [number, number, number]; label?: string }[] = [];
      for (const [trackId, finalPos] of predictions) {
        const obj = scene.objects.find((o) => o.id === trackId);
        if (!obj) continue;
        const currentPos = lookupTrackPos(trackId);
        if (!currentPos) continue;
        items.push({
          trackId,
          currentPos,
          finalPos,
          size: obj.size_m,
          label: obj.label,
        });
      }
      simRef.current.renderSys.setPlanPreview(items);
    }
    // Append a planning-stage entry to the API Call History so user can
    // see the structured plan even when they cascaded through Execute.
    const logId = uuidv4();
    setLogs((prev) => [
      {
        id: logId,
        timestamp: new Date(),
        imageSrc: '',
        prompt: task,
        fullPrompt: '[Plan stage]',
        type: 'Points' as DetectType,
        result: result.calls as unknown as DetectedItem[],
        requestData: { stage: 'plan', warnings: result.warnings },
      },
      ...prev,
    ]);
    return result.calls;
  };

  const runExecuteStage = async (): Promise<void> => {
    const scene = lastDetectScene.current;
    if (!scene) throw new Error('Execute: no scene available');
    if (!simRef.current) throw new Error('Execute: sim not ready');
    const expansion = expandPlan(pipelinePlan, lookupTrackPos, scene);
    if (expansion.warnings.length > 0) {
      console.warn('[execute] expansion warnings:', expansion.warnings);
    }
    if (expansion.steps.length === 0) {
      throw new Error('Execute: plan expanded to zero primitives. ' + expansion.warnings.join('; '));
    }
    setIsPickingUp(true);
    await new Promise<void>((resolve) => {
      simRef.current!.executePlan(expansion.steps, () => resolve());
    });
    setIsPickingUp(false);
    // Clear the Tesla ghost overlay — real cubes now occupy where the
    // ghosts were, no need to keep the comparison overlay around.
    simRef.current.renderSys.clearPlanPreview();
  };

  // Stage 1 of the pipeline. Always runs the full cinematic VLM flow
  // (camera-down, flash, sim snapshot, Gemini call, place blue cones)
  // so the user sees what's happening on every Detect press.
  //
  // For sim-only scenes (no iPhone Radio'd in) we ALSO synthesise a
  // SceneReport from MuJoCo bodies up-front and stash it as
  // lastDetectScene. Plan stage uses this rich symbolic state — every
  // cube's track_id and exact world position — instead of trying to
  // reconstruct it from Gemini's 2D output. So even if Gemini's
  // detection is noisy or slow, Plan still has ground truth.
  const runDetectStage = async (
    prompt: string,
    type: DetectType,
    temperature: number,
    enableThinking: boolean,
    modelId: string,
  ): Promise<void> => {
    if (!simRef.current) throw new Error('Detect: sim not ready');

    // Pre-populate synthetic scene when we have no stream bodies — gives
    // Plan stage rich track_id info regardless of VLM outcome.
    const hasStreamBodies = (simRef.current.getStreamBodyKeys().size ?? 0) > 0;
    if (!hasStreamBodies) {
      const synthetic = simRef.current.synthesizeSceneFromBodies();
      if (synthetic) lastDetectScene.current = synthetic;
    }

    setErLoading(true);
    try {
      await detectImpl(prompt, type, temperature, enableThinking, modelId);
    } finally {
      setErLoading(false);
    }
  };

  const detectImpl = async (prompt: string, type: DetectType, temperature: number, enableThinking: boolean, modelId: string) => {
      if (!simRef.current) return;
      simRef.current.renderSys.clearErMarkers();
      // Re-running Detect invalidates any prior plan preview — wipe.
      simRef.current.renderSys.clearPlanPreview();
      detectedTargets.current = [];
      setDetectedCount(0);
      setIsPickingUp(false);
      setPlaybackSpeed(1);

      // Source the input image from the iPhone Boxer3D stream when available.
      // Falls back to the top-down sim canvas snapshot when the stream is
      // disconnected or the request times out.
      const sceneClient = sceneClientRef.current;
      let frameReport: SceneReport | null = null;
      if (sceneClient && streamConnected) {
          try {
              frameReport = await sceneClient.requestFrame(2500);
          } catch (err) {
              console.warn('[handleErSend] iPhone frame request failed, falling back to sim canvas:', err);
              frameReport = null;
          }
      }
      const useIphoneImage = frameReport?.image != null;
      // Stash for Plan / Execute stages — they need this scene's track
      // UUIDs and positions, NOT a re-fetched live one (which may have
      // a different track set if BoxerNet's MOT churned).
      lastDetectScene.current = frameReport ?? lastDetectScene.current;

      let imageBase64: string;
      let base64Data: string;
      let imageMimeType: string;
      // Saved camera state only needs restoring when we actually moved it.
      let savedCameraState: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
      const topPos = new THREE.Vector3(0, -0.01, 2.0);
      const fallbackTarget = new THREE.Vector3(0, 0, 0);

      if (useIphoneImage && frameReport!.image) {
          // iPhone real-RGB path: use the JPEG ARFrame straight, leave the
          // sim camera alone (Gemini sees the iPhone's view, sim camera is
          // for the operator).
          const img = frameReport!.image;
          base64Data = img.base64;
          imageMimeType = img.mime;
          imageBase64 = `data:${img.mime};base64,${img.base64}`;
      } else {
          // Sim-canvas fallback: the original demo path, top-down PNG snapshot.
          savedCameraState = simRef.current.renderSys.getCameraState();
          await simRef.current.renderSys.moveCameraTo(topPos, fallbackTarget, 1500);
          await new Promise(r => setTimeout(r, 100));
          setFlash(true);
          setTimeout(() => setFlash(false), 100);
          const canvas = simRef.current.renderSys.renderer.domElement;
          const w = canvas.width;
          const h = canvas.height;
          const sf = Math.min(640 / w, 640 / h);
          imageBase64 = simRef.current.renderSys.getCanvasSnapshot(Math.floor(w * sf), Math.floor(h * sf), 'image/png');
          base64Data = imageBase64.replace('data:image/png;base64,', '');
          imageMimeType = 'image/png';
      }

      const parts = defaultPromptParts[type];
      const subject = prompt.trim() || parts[1];
      const textPrompt = `${parts[0]} ${subject}${parts[2]}`;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config: any = {
          temperature,
          responseMimeType: "application/json",
      };
      if (!enableThinking) config.thinkingConfig = { thinkingBudget: 0 };

      const requestLogData = {
          model: modelId,
          contents: {
              parts: [
                  { inlineData: { data: "<IMAGE>", mimeType: imageMimeType } },
                  { text: textPrompt }
              ]
          },
          config,
      };

      const logId = uuidv4();
      const newLog: LogEntry = {
          id: logId,
          timestamp: new Date(),
          imageSrc: imageBase64,
          prompt,
          fullPrompt: textPrompt,
          type,
          result: null,
          requestData: requestLogData,
      };
      setLogs(prev => [newLog, ...prev]);

      if (savedCameraState) {
          await simRef.current.renderSys.moveCameraTo(savedCameraState.position, savedCameraState.target, 1500);
      }

      try {
          const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
          const response = await ai.models.generateContent({
              model: modelId,
              contents: {
                  parts: [
                      { inlineData: { mimeType: imageMimeType, data: base64Data } },
                      { text: textPrompt }
                  ]
              },
              // tslint:disable-next-line:no-any
              config: config,
          });

          const text = response.text;
          if (!text) throw new Error("No response text returned.");

          let jsonText = text.replace(/```json|```/g, '').trim();
          const firstBracket = jsonText.indexOf('[');
          const lastBracket = jsonText.lastIndexOf(']');
          if (firstBracket !== -1 && lastBracket !== -1) {
              jsonText = jsonText.substring(firstBracket, lastBracket + 1);
          }

          let result;
          try { result = JSON.parse(jsonText); } catch (e) { result = []; }

          if (Array.isArray(result)) {
              const seen = new Set();
              result = result.filter((item: unknown) => {
                  const serialized = JSON.stringify(item);
                  if (seen.has(serialized)) return false;
                  seen.add(serialized);
                  return true;
              });
          }

          setLogs(prev => prev.map(l => l.id === logId ? { ...l, result } : l));

          // Pre-project all OBBs into Gemini's 0-1000 image space, ONCE per
          // Detect call (vs. per-result iteration). Only meaningful on the
          // iPhone path — sim canvas raycast doesn't need projection.
          let obbProjections: { obj: SceneObject; gx: number; gy: number }[] | null = null;
          if (useIphoneImage && frameReport!.camera_intrinsics && frameReport!.camera?.pose_world) {
              const intr = frameReport!.camera_intrinsics.fxfycxcy;
              const imgSize = frameReport!.camera_intrinsics.image_size_native;
              const camPose = frameReport!.camera.pose_world;
              const yawDeg = frameReport!.world_yaw_deg ?? 0;
              obbProjections = [];
              for (const obj of frameReport!.objects) {
                  // Objects come in MuJoCo frame; camera pose is ARKit frame.
                  // Invert the swap to put both in the same frame.
                  const arkitPoint = mujocoToArkit(obj.center_world, yawDeg);
                  const proj = worldToGemini1000(arkitPoint, camPose, intr, imgSize);
                  if (proj) obbProjections.push({ obj, gx: proj.gx, gy: proj.gy });
              }
          }

          if (Array.isArray(result)) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              result.forEach((item: any) => {
                  let center2d: {x: number, y: number} | null = null;
                  if (Array.isArray(item?.box_2d) && item.box_2d.length === 4) {
                      const [ymin, xmin, ymax, xmax] = item.box_2d;
                      center2d = { x: (xmin + xmax) / 2, y: (ymin + ymax) / 2 };
                  } else if (Array.isArray(item?.point) && item.point.length === 2) {
                      const [y, x] = item.point;
                      center2d = { x, y };
                  }
                  if (!center2d) return;

                  // Path 1 — iPhone projection match: find the OBB whose
                  // pre-projected gx/gy is closest to Gemini's detection.
                  // Threshold 80 in 0-1000 space ≈ 8% of image side; beyond
                  // that we assume Gemini saw something we don't track.
                  if (obbProjections && obbProjections.length > 0) {
                      let best: { obj: SceneObject; dist: number } | null = null;
                      for (const p of obbProjections) {
                          const d = Math.hypot(p.gx - center2d.x, p.gy - center2d.y);
                          if (!best || d < best.dist) best = { obj: p.obj, dist: d };
                      }
                      if (best && best.dist < 80) {
                          const pos = simRef.current?.getStreamBodyPosition(best.obj.label, best.obj.id);
                          if (pos) {
                              const markerId = Date.now() + Math.random();
                              simRef.current?.renderSys.addErMarker(pos, best.obj.label, markerId);
                              detectedTargets.current.push({ pos, markerId });
                              return;
                          }
                      }
                  }

                  // Path 2 — sim-canvas raycast fallback (existing demo logic).
                  // Only meaningful when Gemini saw the sim canvas, not when
                  // it saw the iPhone image — projecting the iPhone-frame
                  // pixel through a top-down sim camera doesn't recover the
                  // original 3D point. We still try, because it's better than
                  // nothing if projection match found nothing.
                  const projection = simRef.current?.renderSys.project2DTo3D(center2d.x, center2d.y, topPos, fallbackTarget);
                  if (projection) {
                      const markerId = Date.now() + Math.random();
                      simRef.current?.renderSys.addErMarker(projection.point, item.label, markerId);
                      detectedTargets.current.push({ pos: projection.point, markerId });
                  }
              });
              setDetectedCount(detectedTargets.current.length);
          }
      } catch (error: unknown) {
          console.error("Gemini API Error", error);
          const errorMsg = (error as Error).message || "Unknown error";
          setLogs(prev => prev.map(l => l.id === logId && l.result === null ? { ...l, result: { error: errorMsg } } : l));
      } finally {
          setErLoading(false);
      }
  };

  const handlePickup = () => {
    if (simRef.current) {
        // If already picking up, this button acts as a speed toggle
        if (isPickingUp) {
            let nextSpeed = 1;
            if (playbackSpeed === 1) nextSpeed = 2;
            else if (playbackSpeed === 2) nextSpeed = 5;
            else if (playbackSpeed === 5) nextSpeed = 10;
            else if (playbackSpeed === 10) nextSpeed = 20;
            else if (playbackSpeed === 20) nextSpeed = 2; // Cycle back to 2x for continuous fast forward feeling
            
            setPlaybackSpeed(nextSpeed);
            simRef.current.setSpeedMultiplier(nextSpeed);
            return;
        }

        // Otherwise start the pickup sequence
        if (detectedTargets.current.length > 0) {
            setIsPickingUp(true);
            setPlaybackSpeed(1);
            const positions = detectedTargets.current.map(t => t.pos);
            const markerIds = detectedTargets.current.map(t => t.markerId);
            
            simRef.current.pickupItems(positions, markerIds, () => {
                // On Finished
                setIsPickingUp(false);
                setPlaybackSpeed(1);
                setDetectedCount(0); // Deactivates the button
                detectedTargets.current = [];
                simRef.current?.setSpeedMultiplier(1);
            });
        }
    }
  };

  const handleReset = () => {
    simRef.current?.reset();
    setLogs([]);
    setDetectedCount(0);
    setIsPickingUp(false);
    setPlaybackSpeed(1);
    detectedTargets.current = [];
  };

  return (
    <div className={`w-full h-full relative overflow-hidden font-sans transition-colors duration-500 ${isDarkMode ? 'bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-800'}`}>
      {/* 3D Container */}
      <div ref={containerRef} className="w-full h-full absolute inset-0 bg-slate-200" />
      
      {/* Robot Info Overlay */}
      {!loadError && <RobotSelector gizmoStats={gizmoStats} isDarkMode={isDarkMode} />}
      
      {/* Loading Screen */}
      {isLoading && (
          <div className={`absolute inset-0 flex flex-col items-center justify-center z-50 backdrop-blur-md px-6 ${isDarkMode ? 'bg-slate-950/40' : 'bg-slate-50/20'}`}>
              <div className="flex flex-col min-[660px]:flex-row gap-8 max-w-4xl w-full items-stretch">
                  <div className={`glass-panel p-12 rounded-[3rem] flex-1 flex flex-col justify-center shadow-2xl transition-colors ${isDarkMode ? 'bg-slate-900/70 border-white/10' : 'bg-white/70 border-white/80'}`}>
                    <h3 className={`text-sm font-bold uppercase tracking-widest mb-4 ${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'}`}>System Overview</h3>
                    <p className={`text-sm leading-relaxed mb-6 ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>
                      This demo showcases spatial reasoning for robotics. Using <strong>Gemini Robotics Embodied Reasoning 1.6</strong>, the system analyzes a 2D image to identify objects and calculate manipulation coordinates.
                    </p>
                    <ul className={`text-[13px] space-y-3 list-disc list-inside ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                        <li>Real-time MuJoCo physics simulation</li>
                        <li>Analytical Inverse Kinematics for Franka Panda</li>
                        <li>Call Gemini Robotics Embodied Reasoning 1.6 for detection</li>
                    </ul>
                  </div>

                  <div className={`glass-panel p-10 rounded-[3rem] flex flex-col items-center justify-center shrink-0 min-[660px]:w-[260px] shadow-2xl transition-colors ${isDarkMode ? 'bg-slate-900/70 border-white/10' : 'bg-white/70 border-white/80'}`}>
                      <div className="w-16 h-16 rounded-2xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-100/20 animate-pulse-soft mb-6">
                        <Loader2 className="w-8 h-8 text-white animate-spin" />
                      </div>
                      <h2 className={`text-base font-bold text-center px-2 ${isDarkMode ? 'text-slate-100' : 'text-slate-800'}`}>{loadingStatus}</h2>
                  </div>
              </div>
          </div>
      )}
      
      {/* Flash Effect */}
      {flash && <div className="absolute inset-0 bg-white z-[60] pointer-events-none opacity-50" />}
      
      {/* Error State */}
      {loadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/40 backdrop-blur-xl z-50">
              <div className="glass-panel p-10 rounded-[2.5rem] border-red-100 max-w-md text-center">
                  <div className="w-16 h-16 bg-red-50 text-red-600 rounded-full flex items-center justify-center mx-auto mb-6">
                    <AlertCircle className="w-8 h-8" />
                  </div>
                  <h3 className="text-2xl text-slate-800 font-bold mb-2">Simulation Halted</h3>
                  <p className="text-slate-500 mb-8 leading-relaxed">{loadError}</p>
                  <button 
                    onClick={() => window.location.reload()} 
                    className="w-full py-4 bg-slate-900 text-white rounded-2xl font-bold hover:bg-black transition-all shadow-xl active:scale-95"
                  >
                    Restart System
                  </button>
              </div>
          </div>
      )}
      
      {/* Main UI Controls */}
      {!isLoading && !loadError && (
        <>
          <Toolbar
            isPaused={isPaused}
            togglePause={() => setIsPaused(simRef.current?.togglePause() ?? false)}
            onReset={handleReset}
            showSidebar={showSidebar}
            toggleSidebar={() => setShowSidebar(!showSidebar)}
            isDarkMode={isDarkMode}
            toggleDarkMode={toggleDarkMode}
            onReloadFromStream={handleReloadFromStream}
            streamConnected={streamConnected}
            hasStreamScene={hasStreamScene}
            streamStale={streamStale}
          />
          
          <UnifiedSidebar
            isOpen={showSidebar}
            onClose={() => setShowSidebar(false)}
            onDetect={(prompt, type, temperature, enableThinking, modelId) =>
              runPipeline('detect', prompt, type, temperature, enableThinking, modelId)
            }
            onPlan={(prompt, type, temperature, enableThinking, modelId) =>
              runPipeline('plan', prompt, type, temperature, enableThinking, modelId)
            }
            onExecute={(prompt, type, temperature, enableThinking, modelId) =>
              runPipeline('execute', prompt, type, temperature, enableThinking, modelId)
            }
            onPickup={handlePickup}
            isLoading={erLoading || pipelineRunning.current}
            hasDetectedItems={detectedCount > 0}
            logs={logs}
            onOpenLog={(log) => setExpandedLogId(log.id)}
            isDarkMode={isDarkMode}
            isPickingUp={isPickingUp}
            playbackSpeed={playbackSpeed}
            streamLabels={streamLabels}
            streamObjects={streamObjects}
            onDirectPick={handleDirectPick}
            pipelineStatus={pipelineStatus}
            pipelineError={pipelineError}
            pipelinePlan={pipelinePlan}
            onPipelineReset={resetPipeline}
            prompt={prompt}
            onPromptChange={setPrompt}
          />

          {/* Expanded View Modal - Overlay everything */}
          {activeLog && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center min-[660px]:p-10 bg-slate-950/20 backdrop-blur-xl animate-in fade-in" onClick={() => setExpandedLogId(null)}>
              <div className={`glass-panel overflow-hidden flex flex-col shadow-2xl transition-colors fixed top-4 bottom-4 left-4 right-4 rounded-[2.5rem] min-[660px]:relative min-[660px]:inset-auto min-[660px]:w-full min-[660px]:max-w-4xl min-[660px]:max-h-[85vh] ${isDarkMode ? 'bg-slate-900 border-white/10 text-slate-100' : 'bg-white border-white/80 text-slate-800'}`} onClick={e => e.stopPropagation()}>
                 <div className={`p-6 border-b flex justify-between items-center shrink-0 ${isDarkMode ? 'border-white/5 bg-white/5' : 'border-slate-100 bg-white/40'}`}>
                    <div>
                      <h3 className="text-xl font-bold">API Call</h3>
                      <p className={`text-xs font-medium ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{activeLog.timestamp.toLocaleString()}</p>
                    </div>
                    <button onClick={() => setExpandedLogId(null)} className={`w-10 h-10 flex items-center justify-center rounded-full shadow-sm border transition-colors ${isDarkMode ? 'bg-slate-800 border-white/10 text-slate-400 hover:text-slate-200' : 'bg-white border-slate-100 text-slate-400 hover:text-slate-600'}`}>
                      <X className="w-5 h-5" />
                    </button>
                 </div>
                 <div className="flex-1 flex max-[659px]:flex-col max-[659px]:overflow-y-auto custom-scrollbar min-[660px]:flex-row min-[660px]:overflow-hidden">
                    <div className={`flex items-center justify-center border-b min-[660px]:border-b-0 min-[660px]:border-r min-[660px]:flex-1 min-[660px]:p-6 min-[660px]:overflow-hidden max-[659px]:shrink-0 max-[659px]:p-6 ${isDarkMode ? 'bg-slate-950/50 border-white/5' : 'bg-slate-50/30 border-slate-100'}`}>
                       <div className={`relative rounded-2xl overflow-hidden shadow-lg border-2 flex items-center justify-center min-[660px]:w-auto min-[660px]:h-auto min-[660px]:max-w-full min-[660px]:max-h-full max-[659px]:w-full max-[659px]:h-auto ${isDarkMode ? 'border-white/10 bg-black/20' : 'border-white bg-black/5'}`}>
                          <img src={activeLog.imageSrc} className={`block w-full h-auto min-[660px]:max-w-full min-[660px]:max-h-full`} alt="Detailed log" />
                          <LogOverlay log={activeLog} />
                       </div>
                    </div>
                    <div className={`min-[660px]:w-[320px] p-6 flex flex-col gap-5 min-[660px]:overflow-y-auto min-[660px]:custom-scrollbar ${isDarkMode ? 'bg-white/5' : 'bg-white/20'}`}>
                       <div className="space-y-1">
                          <h4 className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">User Prompt</h4>
                          <p className="text-sm font-bold leading-tight">{activeLog.prompt}</p>
                       </div>
                       <div className="space-y-1">
                          <h4 className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Full Prompt</h4>
                          <p className={`text-[10px] font-mono p-3 rounded-xl leading-relaxed border whitespace-pre-wrap ${isDarkMode ? 'bg-slate-950 border-white/5 text-slate-400' : 'bg-slate-50 border-slate-200/50 text-slate-500'}`}>{activeLog.fullPrompt}</p>
                       </div>
                       <div className="space-y-3 flex flex-col min-[660px]:flex-1 min-[660px]:min-h-0">
                          <h4 className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">API Call Results</h4>
                          <div className={`p-3 rounded-xl font-mono text-[10px] border overflow-y-auto shadow-inner min-[660px]:flex-1 max-[659px]:h-96 ${isDarkMode ? 'bg-slate-950 border-white/5 text-indigo-400' : 'bg-slate-50/50 border-slate-100 text-indigo-600'}`}>
                            {activeLog.result === null ? (
                                <div className="h-full flex flex-col items-center justify-center gap-3 text-indigo-400 animate-pulse">
                                    <Loader2 className="w-6 h-6 animate-spin" />
                                    <span className="font-sans font-bold text-[8px] uppercase tracking-widest">Processing...</span>
                                </div>
                            ) : (
                                <pre className="whitespace-pre-wrap break-all leading-relaxed">{JSON.stringify(activeLog.result, null, 2)}</pre>
                            )}
                          </div>
                       </div>
                       <div className="min-[660px]:hidden h-8 shrink-0" />
                    </div>
                 </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}