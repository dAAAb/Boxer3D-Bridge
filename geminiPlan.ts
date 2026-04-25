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

/// Stage-2 Gemini call. Given the user's task description and the objects
/// currently in the sim (from the live SceneReport, with track UUIDs and
/// world positions), ask the LLM for a JSON action sequence.
///
/// Important: we send only the structured object list, not an image —
/// Gemini already saw the iPhone frame in Stage 1 (Detect). Stage 2 is
/// pure planning over symbolic state, so it's image-free, faster, and
/// cheaper.
export async function planActions(
  apiKey: string,
  modelId: string,
  task: string,
  objects: SceneObject[],
  opts: { temperature?: number; thinking?: boolean } = {},
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
    `User task: "${task}"`,
    '',
    'Output the JSON array of function calls now. No explanation, just the array.',
  ].join('\n');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: any = {
    temperature: opts.temperature ?? 0.1,
    responseMimeType: 'application/json',
  };
  if (opts.thinking === false) config.thinkingConfig = { thinkingBudget: 0 };

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: modelId,
    contents: { parts: [{ text: prompt }] },
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
