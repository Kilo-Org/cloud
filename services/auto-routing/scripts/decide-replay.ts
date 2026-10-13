import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import {
  detectRequiredInputModalities,
  estimateRoutingTokens,
  MirrorPayloadSchema,
  normalizeClassifierInput,
  type MirrorPayload,
} from '@kilocode/auto-routing-contracts';
import {
  CLASSIFIER_CASES,
  type ClassifierCase,
} from '../../auto-routing-benchmark/src/datasets/classifier-cases';
import type { Dist, ReplayMetrics } from '../../auto-routing-benchmark/src/scoreboard/schema';

type ChatBody = {
  model: string;
  stream: boolean;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  tools?: {
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: { type: 'object'; properties: { path: { type: 'string' } }; required: string[] };
    };
  }[];
};

type Scenario = keyof ReplayMetrics['scenarios'];
type Samples = { durations: number[]; errors: number };

function positiveInteger(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return number;
}

function chatBody(testCase: ClassifierCase): ChatBody {
  const { input } = testCase;
  if (!input.userPromptPrefix) throw new Error('Golden case is missing a user prompt');
  return {
    model: 'kilo-auto/efficient',
    stream: input.stream,
    messages: [
      ...(input.systemPromptPrefix
        ? [{ role: 'system' as const, content: input.systemPromptPrefix }]
        : []),
      { role: 'user', content: input.userPromptPrefix },
    ],
    ...(input.hasTools
      ? {
          tools: [
            {
              type: 'function' as const,
              function: {
                name: 'read_file',
                description: 'Read a file in the workspace',
                parameters: {
                  type: 'object' as const,
                  properties: { path: { type: 'string' as const } },
                  required: ['path'],
                },
              },
            },
          ],
        }
      : {}),
  };
}

function decidePayload(
  body: ChatBody,
  identity: { userId: string; sessionId: string; machineId: string }
): MirrorPayload {
  const input = normalizeClassifierInput('chat_completions', body, {
    requestedModel: body.model,
    providerHints: { provider: null, providerOptions: null },
  });
  if (!input) throw new Error('Could not normalize the synthetic request');
  const requiredInputModalities = detectRequiredInputModalities(body);
  const promptTokensEstimate = estimateRoutingTokens(body);
  return MirrorPayloadSchema.parse({
    input,
    ...identity,
    organizationId: null,
    clientRequestId: null,
    mode: null,
    userAgent: 'auto-routing-decide-replay',
    bodyBytes: Buffer.byteLength(JSON.stringify(body)),
    ...(requiredInputModalities.length > 0 || promptTokensEstimate > 0
      ? {
          constraints: {
            ...(requiredInputModalities.length > 0 ? { requiredInputModalities } : {}),
            ...(promptTokensEstimate > 0 ? { promptTokensEstimate } : {}),
          },
        }
      : {}),
  });
}

function distribution(durations: number[]): Dist {
  const sorted = durations.toSorted((a, b) => a - b);
  const percentile = (fraction: number): number | null =>
    sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
  return { n: sorted.length, p50: percentile(0.5), p90: percentile(0.9), p99: percentile(0.99) };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'http://localhost:8810' },
      sessions: { type: 'string', default: '36' },
      concurrency: { type: 'string', default: '3' },
      out: { type: 'string', default: 'replay.json' },
      'user-id': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: pnpm --filter auto-routing replay --user-id <dev-user-id> [--url http://localhost:8810] [--sessions 36] [--concurrency 3] [--out replay.json]\n' +
        'Set INTERNAL_API_SECRET in the environment. Each session sends cold, warm_new_turn, and exact_repeat requests in order. Requests time out after 30 seconds. Percentiles use nearest rank over all attempts, including errors.'
    );
    return;
  }
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) throw new Error('INTERNAL_API_SECRET must be set');
  const userId = values['user-id']?.trim();
  if (!userId) throw new Error('--user-id is required; pass a seeded local user ID');
  const sessions = positiveInteger(values.sessions, '--sessions');
  const concurrency = positiveInteger(values.concurrency, '--concurrency');
  const url = new URL(values.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('--url must be an HTTP(S) worker URL without credentials');
  }
  if (url.search || url.hash) throw new Error('--url must not contain a query or fragment');
  const target = url.toString().replace(/\/+$/, '');
  const startedAt = new Date().toISOString();
  const samples: Record<Scenario, Samples> = {
    cold: { durations: [], errors: 0 },
    warm_new_turn: { durations: [], errors: 0 },
    exact_repeat: { durations: [], errors: 0 },
  };

  async function measure(scenario: Scenario, payload: string): Promise<void> {
    const started = performance.now();
    let failed = false;
    try {
      const response = await fetch(`${target}/decide`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
      failed = !response.ok;
      await response.arrayBuffer();
    } catch {
      failed = true;
    }
    samples[scenario].durations.push(performance.now() - started);
    if (failed) samples[scenario].errors += 1;
  }

  async function replaySession(index: number): Promise<void> {
    const caseIndex = Math.floor((index * CLASSIFIER_CASES.length) / sessions);
    const firstCase = CLASSIFIER_CASES[caseIndex];
    const nextCase = CLASSIFIER_CASES[(caseIndex + 1) % CLASSIFIER_CASES.length];
    if (!firstCase || !nextCase?.input.userPromptPrefix) {
      throw new Error('Golden cases must contain at least two user prompts');
    }
    const identity = { userId, sessionId: randomUUID(), machineId: randomUUID() };
    const body = chatBody(firstCase);
    await measure('cold', JSON.stringify(decidePayload(body, identity)));
    body.messages.push(
      { role: 'assistant', content: 'The requested work is complete. What should I work on next?' },
      { role: 'user', content: nextCase.input.userPromptPrefix }
    );
    const warmPayload = JSON.stringify(decidePayload(body, identity));
    await measure('warm_new_turn', warmPayload);
    await measure('exact_repeat', warmPayload);
  }

  let nextSession = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, sessions) }, async () => {
      while (nextSession < sessions) {
        await replaySession(nextSession++);
      }
    })
  );
  const scenarioMetrics = (scenario: Scenario) => ({
    ...distribution(samples[scenario].durations),
    errors: samples[scenario].errors,
  });
  const result: ReplayMetrics = {
    kind: 'replay',
    target,
    startedAt,
    sessions,
    scenarios: {
      cold: scenarioMetrics('cold'),
      warm_new_turn: scenarioMetrics('warm_new_turn'),
      exact_repeat: scenarioMetrics('exact_repeat'),
    },
  };
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Wrote replay metrics to ${values.out}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Replay failed');
  process.exitCode = 1;
});
