/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from '@google/genai';
import { FUNCTION_LIBRARY_DOCS, RobotFunctionCall } from './actionLibrary';
import { buildPlannerSystemPrompt, PLANNER_PROMPT_VERSION } from './prompts/planner.system';
import { SceneObject } from './SceneReport';
import type { ExpectFailure } from './SequenceAnimator';

export { PLANNER_PROMPT_VERSION };

export interface PlanResult {
  calls: RobotFunctionCall[];
  rawText: string;
  warnings: string[];
}

/// Render the prior plan + failure into a "## Prior attempt failed"
/// block that gets appended to the user-side prompt on replan calls.
/// The planner reads this and emits a corrective plan instead of
/// repeating the doomed sequence verbatim. (Step 4B)
function buildFailureBlock(plan: RobotFunctionCall[], f: ExpectFailure): string {
  const planLines = plan.map((c, i) => {
    const args = c.args && Object.keys(c.args).length > 0 ? ` ${JSON.stringify(c.args)}` : '';
    return `  ${i + 1}. ${c.function}${args}`;
  }).join('\n');
  const obs = f.observed;
  const obsParts: string[] = [];
  if (obs.tcp) obsParts.push(`tcp=(${obs.tcp.map((v) => v.toFixed(3)).join(', ')})`);
  if (obs.body) obsParts.push(`body=(${obs.body.map((v) => v.toFixed(3)).join(', ')})`);
  if (obs.gripperCtrl !== undefined) obsParts.push(`gripperCtrl=${obs.gripperCtrl.toFixed(0)}`);
  const observedLine = obsParts.length > 0 ? `Observed: ${obsParts.join(', ')}.` : '';
  return [
    '## Prior attempt failed',
    'Plan attempted (last):',
    planLines,
    `Failed: ${f.kind}(${f.track_id}) — ${f.message}`,
    observedLine,
    'Reasons (machine-readable): [' + f.reasons.join(', ') + ']',
    '',
    'Output a corrective plan. You may retry with adjustments (different',
    'approach height, different track, ask_user, or [] if you believe the',
    'task is now impossible). Do NOT emit the same plan verbatim — the',
    'runtime detects duplicate failure signatures and aborts.',
    '',
  ].filter(Boolean).join('\n');
}

/// Stage-2 Gemini call. Given the user's task description, the objects
/// currently in the sim (from the live SceneReport, with track UUIDs
/// and world positions), and OPTIONALLY the iPhone JPEG that Stage 1
/// saw, ask the LLM for a JSON action sequence.
///
/// Stage 1 and Stage 2 are independent API calls — Gemini has no memory
/// across them. So if the user's task references visual qualifiers
/// BoxerNet labels can't capture (colour, brand, "the dirty one"),
/// Stage 2 needs to see the image too. Pass image when you have one;
/// skip it when you don't (synthetic scene, sim-canvas fallback).
export async function planActions(
  apiKey: string,
  modelId: string,
  task: string,
  objects: SceneObject[],
  opts: {
    temperature?: number;
    thinking?: boolean;
    image?: { mime: string; base64: string };
    /// 4B replan context. When the previous Execute attempt rejected
    /// with an ExpectFailure, the caller passes the plan it tried and
    /// the structured failure here so the planner can read the
    /// observed-vs-expected delta and emit a corrective plan instead
    /// of repeating the doomed sequence.
    priorPlan?: RobotFunctionCall[];
    priorFailure?: ExpectFailure;
  } = {},
): Promise<PlanResult> {
  const objectList = objects
    .map((o) => {
      const [x, y, z] = o.center_world;
      const [w, h, d] = o.size_m;
      return `  - track_id="${o.id}" label="${o.label}" pos=(${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}) size=(${w.toFixed(3)}, ${h.toFixed(3)}, ${d.toFixed(3)})`;
    })
    .join('\n');

  const failureBlock = (opts.priorPlan && opts.priorFailure)
    ? buildFailureBlock(opts.priorPlan, opts.priorFailure)
    : '';

  const systemPrompt = buildPlannerSystemPrompt(FUNCTION_LIBRARY_DOCS);
  const prompt = [
    systemPrompt,
    '',
    '## Current scene',
    'Detected objects:',
    objectList || '  (none)',
    '',
    opts.image
      ? 'An iPhone RGB image of this scene is attached above. Use it for visual qualifiers per the rules.'
      : 'No image available — reason from labels and positions only.',
    '',
    failureBlock,
    `## User task\n"${task}"`,
    '',
    'Output the JSON array now.',
  ].filter(Boolean).join('\n');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: any = {
    temperature: opts.temperature ?? 0.1,
    responseMimeType: 'application/json',
  };
  if (opts.thinking === false) config.thinkingConfig = { thinkingBudget: 0 };

  const parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] = [];
  if (opts.image) {
    parts.push({ inlineData: { mimeType: opts.image.mime, data: opts.image.base64 } });
  }
  parts.push({ text: prompt });

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: modelId,
    contents: { parts },
    config,
  });

  const text = response.text ?? '';
  if (!text.trim()) {
    return { calls: [], rawText: '', warnings: ['Empty response from Gemini Stage-2 plan call.'] };
  }

  // Strip code-fence and trim around the first/last bracket — same shape
  // as the Stage-1 detect parser.
  let jsonText = text.replace(/```json|```/g, '').trim();
  const first = jsonText.indexOf('[');
  const last = jsonText.lastIndexOf(']');
  if (first !== -1 && last !== -1) jsonText = jsonText.substring(first, last + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return {
      calls: [],
      rawText: text,
      warnings: [`Stage-2 JSON parse failed: ${(e as Error).message}`],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      calls: [],
      rawText: text,
      warnings: [`Stage-2 returned non-array: ${typeof parsed}`],
    };
  }

  const calls: RobotFunctionCall[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i] as Partial<RobotFunctionCall>;
    if (typeof item?.function !== 'string') {
      warnings.push(`Step ${i}: missing function field, skipping.`);
      continue;
    }
    calls.push(item as RobotFunctionCall);
  }
  return { calls, rawText: text, warnings };
}
