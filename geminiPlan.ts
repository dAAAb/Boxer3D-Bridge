/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from '@google/genai';
import { FUNCTION_LIBRARY_DOCS, RobotFunctionCall } from './actionLibrary';
import { SceneObject } from './SceneReport';

export interface PlanResult {
  calls: RobotFunctionCall[];
  rawText: string;
  warnings: string[];
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
  } = {},
): Promise<PlanResult> {
  const objectList = objects
    .map((o) => {
      const [x, y, z] = o.center_world;
      const [w, h, d] = o.size_m;
      return `  - track_id="${o.id}" label="${o.label}" pos=(${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}) size=(${w.toFixed(3)}, ${h.toFixed(3)}, ${d.toFixed(3)})`;
    })
    .join('\n');

  const prompt = [
    FUNCTION_LIBRARY_DOCS,
    '',
    'Detected objects (current scene):',
    objectList || '  (none)',
    '',
    opts.image
      ? 'The attached image is the iPhone RGB view of the scene above. Use it to disambiguate visual qualifiers in the task (colour, branding, position) — every object in the list has a visible counterpart in the image. Match by spatial location.'
      : '',
    `User task: "${task}"`,
    '',
    'Output the JSON array of function calls now. No explanation, just the array.',
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
