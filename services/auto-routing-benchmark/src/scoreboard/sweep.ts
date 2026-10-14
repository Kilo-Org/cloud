import { setTimeout as delay } from 'node:timers/promises';
import * as z from 'zod';
import { DECIDER_CASES, FRONTIER_CASES } from '../datasets/decider-cases';
import type { OfflineSweep } from './schema';

type SweepResult = OfflineSweep['pairs'][number]['results'][number];

export function selectSweepCases(suite: 'efficient' | 'frontier' = 'efficient') {
  return suite === 'frontier' ? FRONTIER_CASES : DECIDER_CASES;
}

const streamChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            reasoning: z.string().nullish(),
            reasoning_content: z.string().nullish(),
            reasoning_details: z.array(z.unknown()).nullish(),
          })
          .optional(),
      })
    )
    .optional(),
  usage: z.object({ cost: z.number().nonnegative().nullish() }).nullish(),
  error: z.unknown().optional(),
});

export async function readSweepCompletion(
  response: Response,
  startedAt: number,
  now: () => number = () => performance.now()
): Promise<{ output: string; costUsd: number | null; ttftMs: number | null }> {
  if (!response.body) throw new Error('OpenRouter response has no stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let output = '';
  let costUsd: number | null = null;
  let ttftMs: number | null = null;
  let done = false;
  const consumeEvent = () => {
    if (data.length === 0) return;
    const payload = data.join('\n');
    data = [];
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    const chunk = streamChunkSchema.parse(JSON.parse(payload));
    if (chunk.error !== undefined) throw new Error('OpenRouter stream returned an error');
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (!delta) continue;
      if (
        ttftMs === null &&
        (delta.content ||
          delta.reasoning ||
          delta.reasoning_content ||
          (delta.reasoning_details?.length ?? 0) > 0)
      ) {
        ttftMs = Math.max(0, now() - startedAt);
      }
      output += delta.content ?? '';
    }
    if (chunk.usage?.cost != null) costUsd = chunk.usage.cost;
  };
  const consumeLine = (line: string) => {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (normalized === '') consumeEvent();
    else if (normalized.startsWith('data:')) data.push(normalized.slice(5).replace(/^ /, ''));
  };
  try {
    while (true) {
      const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (chunk.done) break;
    }
    if (buffer) consumeLine(buffer);
    consumeEvent();
    if (!done) throw new Error('OpenRouter stream ended before [DONE]');
    return { output, costUsd, ttftMs };
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function requestDirectSweepCompletion(input: {
  model: string;
  fragment: Record<string, unknown>;
  systemPrompt: string;
  userPrompt: string;
  apiKey: string;
  attributionHeaders: Record<string, string>;
  budgetAvailable: () => boolean;
  fetchImpl?: typeof fetch;
}): Promise<{
  output: string | null;
  costUsd: number | null;
  ttftMs: number | null;
  latencyMs: number;
  error: string | null;
}> {
  const body = JSON.stringify({
    ...input.fragment,
    model: input.model,
    messages: [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userPrompt },
    ],
    stream: true,
    usage: { include: true },
  });
  const started = performance.now();
  let error: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!input.budgetAvailable()) {
      error = 'Sweep budget exhausted before request';
      break;
    }
    let retry = false;
    try {
      const response = await (input.fetchImpl ?? fetch)(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            ...input.attributionHeaders,
            Authorization: `Bearer ${input.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(170_000),
        }
      );
      if (!response.ok) {
        await response.body?.cancel();
        error = `OpenRouter returned HTTP ${response.status}`;
        retry = response.status === 429 || response.status >= 500;
      } else {
        const result = await readSweepCompletion(response, started);
        return {
          ...result,
          latencyMs: performance.now() - started,
          error:
            result.output.length === 0
              ? 'OpenRouter response is missing answer content'
              : result.costUsd === null
                ? 'usage_missing'
                : null,
        };
      }
    } catch {
      error = 'OpenRouter transport or body read failed';
      retry = true;
    }
    if (!retry || attempt === 2) break;
    await delay(1_000 * 2 ** attempt);
  }
  return {
    output: null,
    costUsd: null,
    ttftMs: null,
    latencyMs: performance.now() - started,
    error,
  };
}

const timedEventSchema = z.object({
  type: z.string(),
  timestamp: z.number().optional(),
  text: z.string().optional(),
  time: z.object({ start: z.number().optional() }).optional(),
  part: z
    .object({
      text: z.string().optional(),
      time: z.object({ start: z.number().optional() }).optional(),
    })
    .optional(),
});

export function containerTtftMs(lines: string[], startedAt: number): number | null {
  for (const line of lines) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = timedEventSchema.safeParse(json);
    if (!parsed.success) continue;
    const event = parsed.data;
    if (event.type !== 'text' || !(event.part?.text ?? event.text)) continue;
    const timestamp = event.timestamp ?? event.part?.time?.start ?? event.time?.start;
    return timestamp !== undefined && timestamp >= startedAt ? timestamp - startedAt : null;
  }
  return null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
}

export function isGradedSweepResult(
  result: SweepResult
): result is SweepResult & { score: number } {
  return (
    result.score !== null &&
    (result.error === null ||
      result.error === 'usage_missing' ||
      result.error === 'OpenRouter response is missing answer content' ||
      result.error === 'Container response is missing answer content')
  );
}

export function summarizeSweep(pairs: OfflineSweep['pairs']): OfflineSweep['summaries'] {
  return pairs.flatMap(pair => {
    const groups = new Map<string, SweepResult[]>();
    for (const result of pair.results) {
      const key = JSON.stringify([result.routeKey, result.split]);
      const group = groups.get(key);
      if (group) group.push(result);
      else groups.set(key, [result]);
    }
    return [...groups.values()].map(results => {
      const graded = results.filter(isGradedSweepResult);
      const costs = graded.flatMap(result => (result.costUsd === null ? [] : [result.costUsd]));
      const latencies = graded.map(result => result.latencyMs);
      const ttfts = graded.flatMap(result => (result.ttftMs == null ? [] : [result.ttftMs]));
      return {
        model: pair.model,
        variant: pair.variant,
        routeKey: results[0].routeKey,
        split: results[0].split,
        accuracy:
          graded.length > 0
            ? graded.reduce((sum, result) => sum + result.score, 0) / graded.length
            : null,
        cases: graded.length,
        errors: results.length - graded.length,
        avgCostUsd:
          costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length : null,
        p50LatencyMs: median(latencies),
        p50TtftMs: median(ttfts),
      };
    });
  });
}
