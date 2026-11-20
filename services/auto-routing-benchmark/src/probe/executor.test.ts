import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogModel } from '../platform-models';
import {
  BenchmarkCaseCancelledError,
  isExactModelUnavailableResult,
  isUnbilledTransientProviderResult,
} from '../cli-runner';
import { BENCHMARK_CASE_HEADER, issueCaseInferenceCapability } from '../case-inference-capability';
import { gradeProbeOutput } from '../grading';
import { PROBE_CASES } from '../datasets/probe-cases';
import {
  BenchmarkProbeFamilyError,
  PROBE_TIMEOUT_MS,
  runCancellableProbeCase,
  runProbeCaseViaGateway,
} from './executor';
import { PROBE_TEMPLATES, probeTemplate } from './request';
import { probeFamily } from './family';

const probeCase = PROBE_CASES[0]!;

type Reply = {
  status: number;
  body: string;
  contentType?: string;
  delayMs?: number;
  hold?: 'before-headers' | 'after-headers';
};

type Recorded = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

const model = 'meta/muse-ember';

function catalogModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: model,
    description: 'Meta Muse Ember, captured.',
    opencode: {
      ai_sdk_provider: 'openai',
      variants: { high: { reasoning: { effort: 'high' } } },
    },
    ...overrides,
  } as CatalogModel;
}

function responsesCall(cost: number, reasoning: number): string {
  const args = JSON.stringify({ command: 'node scripts/verify.js', description: 'Verify' });
  const event = (type: string, payload: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  return [
    event('response.created', { response: { id: 'resp_1', created_at: 1, model } }),
    event('response.output_item.added', {
      output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '' },
    }),
    event('response.function_call_arguments.delta', {
      item_id: 'fc_1',
      output_index: 0,
      delta: args,
    }),
    event('response.output_item.done', {
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'bash',
        arguments: args,
      },
    }),
    event('response.completed', {
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [],
        usage: {
          input_tokens: 4000,
          output_tokens: 22,
          output_tokens_details: { reasoning_tokens: reasoning },
          cost,
        },
      },
    }),
  ].join('');
}

function responsesText(text: string, cost: number | null): string {
  const event = (type: string, payload: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  return [
    event('response.created', { response: { id: 'resp_2', created_at: 1, model } }),
    event('response.output_item.added', {
      output_index: 0,
      item: { type: 'message', id: 'msg_1' },
    }),
    event('response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: text }),
    event('response.completed', {
      response: {
        id: 'resp_2',
        status: 'completed',
        output: [],
        usage: {
          input_tokens: 5000,
          output_tokens: 30,
          ...(cost === null ? {} : { cost }),
        },
      },
    }),
  ].join('');
}

function responsesFailure(message: string, usage: Record<string, unknown> | null): string {
  const event = (type: string, payload: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  return [
    event('response.created', { response: { id: 'resp_5', created_at: 1, model } }),
    event('response.failed', {
      response: {
        id: 'resp_5',
        status: 'failed',
        error: { message },
        ...(usage === null ? {} : { usage }),
      },
    }),
  ].join('');
}

function responsesFailureAfterCall(message: string, usage: Record<string, unknown> | null): string {
  const event = (type: string, payload: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  return [
    event('response.created', { response: { id: 'resp_6', created_at: 1, model } }),
    event('response.output_item.added', {
      output_index: 0,
      item: { type: 'function_call', id: 'fc_6', call_id: 'call_6', name: 'bash', arguments: '' },
    }),
    event('response.function_call_arguments.delta', {
      item_id: 'fc_6',
      output_index: 0,
      delta: '{"command":"node scripts/ver',
    }),
    event('response.failed', {
      response: {
        id: 'resp_6',
        status: 'failed',
        error: { message },
        ...(usage === null ? {} : { usage }),
      },
    }),
  ].join('');
}

function chatToolCalls(cost: number): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl_1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return [
    chunk({ role: 'assistant', content: '' }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'bash', arguments: '{"command":"ls","description":"List"}' },
        },
      ],
    }),
    chunk({}, 'tool_calls'),
    `data: ${JSON.stringify({
      id: 'chatcmpl_1',
      object: 'chat.completion.chunk',
      choices: [],
      usage: {
        prompt_tokens: 3000,
        completion_tokens: 12,
        prompt_tokens_details: { cached_tokens: 1000 },
        completion_tokens_details: { reasoning_tokens: 0 },
        cost,
      },
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

function chatText(text: string, cost: number): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl_2',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return [
    chunk({ role: 'assistant', content: '' }),
    chunk({ content: text }),
    chunk({}, 'stop'),
    `data: ${JSON.stringify({
      id: 'chatcmpl_2',
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 3100, completion_tokens: 40, cost },
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

function anthropicEvent(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function anthropicStart(usage: Record<string, unknown>): string {
  return anthropicEvent('message_start', {
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'capture',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
}

function anthropicCall(usage: Record<string, unknown>): string {
  const args = JSON.stringify({ command: 'node scripts/verify.js', description: 'Verify' });
  return [
    anthropicStart(usage),
    anthropicEvent('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash', input: {} },
    }),
    anthropicEvent('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: args },
    }),
    anthropicEvent('content_block_stop', { index: 0 }),
    anthropicEvent('message_delta', {
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 12 },
    }),
    anthropicEvent('message_stop', {}),
  ].join('');
}

function anthropicText(text: string, usage: Record<string, unknown>): string {
  return [
    anthropicStart(usage),
    anthropicEvent('content_block_start', {
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    anthropicEvent('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text },
    }),
    anthropicEvent('content_block_stop', { index: 0 }),
    anthropicEvent('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 20 },
    }),
    anthropicEvent('message_stop', {}),
  ].join('');
}

let server: Server;
let requests: Recorded[];
let replies: Reply[];

beforeEach(async () => {
  requests = [];
  replies = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', part => chunks.push(part as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw.length > 0 ? JSON.parse(raw) : null;
      requests.push({
        url: req.url ?? '',
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([name, value]) => [name, String(value ?? '')])
        ),
        body,
      });
      const reply = replies.shift() ?? { status: 500, body: '{"error":"no reply queued"}' };
      if (reply.hold === 'before-headers') return;
      res.writeHead(reply.status, {
        'content-type': reply.contentType ?? 'text/event-stream',
      });
      res.flushHeaders();
      if (reply.hold === 'after-headers') return;
      if (reply.delayMs === undefined) res.end(reply.body);
      else setTimeout(() => res.end(reply.body), reply.delayMs);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
});

afterEach(async () => {
  server.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
});

function baseUrl(): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function withTimeout(ms: number): typeof fetch {
  return (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(ms) });
}

function run(
  overrides: {
    catalogModel?: CatalogModel;
    model?: string;
    variant?: string | null;
    fetchImpl?: typeof fetch;
    now?: number;
  } = {}
) {
  return runProbeCaseViaGateway({
    model: overrides.model ?? model,
    variant: overrides.variant === undefined ? 'high' : overrides.variant,
    benchCase: probeCase,
    catalogModel: overrides.catalogModel ?? catalogModel(),
    kiloToken: 'user-token',
    kiloApiUrl: baseUrl(),
    orgId: 'org-1',
    now: overrides.now ?? new Date('2026-11-20T09:00:00.000Z').getTime(),
    fetchImpl: overrides.fetchImpl,
  });
}

describe('probe executor — responses endpoint', () => {
  it('sends the captured template plus the history and scores a tool call as continuing', async () => {
    replies.push({ status: 200, body: responsesCall(0.0012, 7) });

    const result = await run();

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe('/api/gateway/v1/responses');
    expect(request.headers.authorization).toBe('Bearer user-token');
    expect(request.headers['x-kilocode-organizationid']).toBe('org-1');
    const template = probeTemplate(probeFamily(catalogModel()));
    if ('unsupportedReason' in template) throw new Error(template.unsupportedReason);
    expect(Object.keys(request.body).toSorted()).toEqual(
      [
        'include',
        'input',
        'max_output_tokens',
        'model',
        'reasoning',
        'store',
        'stream',
        'tool_choice',
        'tools',
      ].toSorted()
    );
    expect(request.body.model).toBe(model);
    expect(request.body.reasoning).toEqual({ effort: 'high' });
    // The CLI's own shape: `ses_`, 12 hex digits of `Date.now() * 0x1000`, 14 base62 chars.
    expect(request.headers['x-session-id']).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(request.headers['x-session-affinity']).toBe(request.headers['x-session-id']);
    expect(request.headers['x-kilocode-taskid']).toBe(request.headers['x-session-id']);
    const input = request.body.input as Record<string, unknown>[];
    expect(input[0]?.role).toBe('developer');
    expect(String(input[0]?.content)).toContain(model);
    expect(String(input[0]?.content)).toContain(new Date('2026-11-20').toDateString());
    expect(input.at(-1)?.type).toBe('function_call_output');

    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBe(0.0012);
    expect(result.inputTokens).toBe(4000);
    expect(result.outputTokens).toBe(22);
    expect(result.reasoningTokens).toBe(7);
    expect(result.tools.calls).toBe(1);
    expect(result.tools.names).toEqual(['bash']);
    expect(result.tools.finalFinishReason).toBe('tool-calls');
    expect(
      gradeProbeOutput(probeCase.check, { text: result.text, toolCalls: result.tools.calls })
    ).toBe(1);
  });

  it('scores a narration stop and a correct final answer apart', async () => {
    replies.push({ status: 200, body: responsesText("I'll inspect the data next.", 0.001) });
    const narration = await run();
    expect(narration.tools.calls).toBe(0);
    expect(narration.tools.finalFinishReason).toBe('stop');
    expect(
      gradeProbeOutput(probeCase.check, {
        text: narration.text,
        toolCalls: narration.tools.calls,
      })
    ).toBe(0);

    replies.push({
      status: 200,
      body: responsesText(JSON.stringify(probeCase.check.value), 0.001),
    });
    const answer = await run();
    expect(answer.tools.calls).toBe(0);
    expect(
      gradeProbeOutput(probeCase.check, { text: answer.text, toolCalls: answer.tools.calls })
    ).toBe(1);
  });

  it('measures latency to the end of the reply stream, not to the response headers', async () => {
    // A real delay through a real socket: only then does the header time differ from the
    // stream end, which is the elapsed time this assertion is about.
    replies.push({ status: 200, body: responsesCall(0.0012, 7), delayMs: 120 });
    const result = await run({ now: Date.now() });
    expect(result.exitCode).toBe(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(100);
  });

  it('prices an uncosted reply at the catalog rates instead of recording no cost', async () => {
    replies.push({ status: 200, body: responsesText('done', null) });
    const priced = await run({
      catalogModel: catalogModel({
        pricing: { prompt: 0.000001, completion: 0.000002, input_cache_read: 1e-7 },
      }),
    });
    expect(priced.costUsd).toBeCloseTo(5000 * 0.000001 + 30 * 0.000002, 12);

    replies.push({ status: 200, body: responsesText('done', null) });
    const unpriced = await run({ catalogModel: catalogModel({ pricing: null }) });
    expect(unpriced.costUsd).toBeNull();
  });

  it('reports a stream cut after billing as an ambiguous execution', async () => {
    replies.push({
      status: 200,
      body: `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_3","created_at":1,"model":"${model}"}}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"I will"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_3","status":"completed","usage":{"input_tokens":10,"output_tokens":3,"cost":0.0009}}}\n\n`,
    });
    await expect(run()).resolves.toMatchObject({ text: 'I will', costUsd: 0.0009 });
    replies.push({
      status: 200,
      body: `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"I will"}\n\n`,
    });
    await expect(run()).rejects.toThrow(/cut after the gateway billed/);
  });

  it('classifies a stream that ends mid-event by its stream state, not a JSON error', async () => {
    // Billed narration, then a payload cut mid-JSON: the reply is a cut-after-billing one.
    replies.push({
      status: 200,
      body: `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"I will"}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","outp`,
    });
    await expect(run()).rejects.toThrow(/cut after the gateway billed/);

    // Nothing billed and nothing produced: the same truncation is a transient failure.
    replies.push({
      status: 200,
      body: `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_7","crea`,
    });
    const unbilled = await run();
    expect(unbilled.costUsd).toBe(0);
    expect(isUnbilledTransientProviderResult(unbilled)).toBe(true);
  });
});

describe('probe executor — chat endpoint', () => {
  const chatModel = catalogModel({
    id: 'deepseek/deepseek-v4.1-flash-1017',
    opencode: { variants: { high: { reasoning: { effort: 'high' } } } },
  });

  it('sends chat completions and reads tool calls, cache and cost from the usage chunk', async () => {
    replies.push({ status: 200, body: chatToolCalls(0.0004) });
    const result = await run({ catalogModel: chatModel, model: chatModel.id });

    expect(requests[0]?.url).toBe('/api/gateway/v1/chat/completions');
    const body = requests[0]!.body;
    expect(body.messages).toBeDefined();
    const messages = body.messages as Record<string, unknown>[];
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
    expect(messages.at(-1)?.role).toBe('tool');
    expect(body.description).toBe('Meta Muse Ember, captured.');

    expect(result.tools.calls).toBe(1);
    expect(result.tools.finalFinishReason).toBe('tool-calls');
    expect(result.costUsd).toBe(0.0004);
    expect(result.inputTokens).toBe(3000);
    expect(result.cachedInputTokens).toBe(1000);
    expect(result.outputTokens).toBe(12);
    expect(
      gradeProbeOutput(probeCase.check, { text: result.text, toolCalls: result.tools.calls })
    ).toBe(1);
  });

  it('scores a plain text stop with the probe check', async () => {
    replies.push({ status: 200, body: chatText(JSON.stringify(probeCase.check.value), 0.0004) });
    const result = await run({ catalogModel: chatModel, model: chatModel.id });
    expect(result.tools.calls).toBe(0);
    expect(result.tools.finalFinishReason).toBe('stop');
    expect(
      gradeProbeOutput(probeCase.check, { text: result.text, toolCalls: result.tools.calls })
    ).toBe(1);
  });

  it('treats the [DONE] sentinel as the end of a reply that carries no finish reason', async () => {
    const chunk = (delta: Record<string, unknown>) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl_3',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`;
    replies.push({
      status: 200,
      body: [
        chunk({ role: 'assistant', content: '' }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_3',
              type: 'function',
              function: { name: 'bash', arguments: '{"command":"ls"}' },
            },
          ],
        }),
        `data: ${JSON.stringify({
          id: 'chatcmpl_3',
          choices: [],
          usage: { prompt_tokens: 2000, completion_tokens: 9, cost: 0.0003 },
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''),
    });

    const result = await run({ catalogModel: chatModel, model: chatModel.id });

    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBe(0.0003);
    expect(result.tools.calls).toBe(1);
    expect(
      gradeProbeOutput(probeCase.check, { text: result.text, toolCalls: result.tools.calls })
    ).toBe(1);
  });
});

describe('probe executor — anthropic messages endpoint', () => {
  const haiku = 'anthropic/claude-haiku-5.5';
  const model = catalogModel({
    id: haiku,
    description: 'Claude Haiku, captured.',
    opencode: {
      ai_sdk_provider: 'anthropic',
      variants: {
        high: { reasoning: { effort: 'high' } },
        none: { reasoning: { effort: 'none' } },
      },
    },
  });

  it('sends the Messages API request and scores a tool_use as continuing', async () => {
    replies.push({
      status: 200,
      body: anthropicCall({ input_tokens: 4100, output_tokens: 1, cost: 0.0007 }),
    });

    const result = await run({ catalogModel: model, model: haiku });

    const request = requests[0]!;
    expect(request.url).toBe('/api/gateway/v1/messages');
    expect(request.headers['x-api-key']).toBe('user-token');
    expect(request.headers['anthropic-version']).toBeTruthy();
    expect(request.body.model).toBe(haiku);
    expect(request.body.thinking).toEqual({ type: 'adaptive' });
    expect(request.body.output_config).toEqual({ effort: 'high' });
    const messages = request.body.messages as Record<string, unknown>[];
    expect(messages[0]?.role).toBe('user');
    const resultTurn = messages.at(-1) as { content: Record<string, unknown>[] };
    expect(resultTurn.content[0]?.type).toBe('tool_result');

    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBe(0.0007);
    expect(result.inputTokens).toBe(4100);
    expect(result.outputTokens).toBe(12);
    expect(result.tools.calls).toBe(1);
    expect(result.tools.finalFinishReason).toBe('tool-calls');
    expect(
      gradeProbeOutput(probeCase.check, { text: result.text, toolCalls: result.tools.calls })
    ).toBe(1);
  });

  it('prices an uncosted Messages reply at the catalog rates', async () => {
    replies.push({ status: 200, body: anthropicText('done', { input_tokens: 4100 }) });
    const result = await run({
      catalogModel: catalogModel({
        id: haiku,
        opencode: {
          ai_sdk_provider: 'anthropic',
          variants: { high: { reasoning: { effort: 'high' } } },
        },
        pricing: { prompt: 0.000001, completion: 0.000002, input_cache_read: null },
      }),
      model: haiku,
    });
    expect(result.costUsd).toBeCloseTo(4100 * 0.000001 + 20 * 0.000002, 12);
  });

  it('scores end_turn narration as zero and a correct final answer as one', async () => {
    replies.push({ status: 200, body: anthropicText("I'll inspect the data next.", {}) });
    const narration = await run({ catalogModel: model, model: haiku });
    expect(narration.tools.calls).toBe(0);
    expect(narration.tools.finalFinishReason).toBe('stop');
    expect(
      gradeProbeOutput(probeCase.check, {
        text: narration.text,
        toolCalls: narration.tools.calls,
      })
    ).toBe(0);

    replies.push({
      status: 200,
      body: anthropicText(JSON.stringify(probeCase.check.value), {}),
    });
    const answer = await run({ catalogModel: model, model: haiku });
    expect(
      gradeProbeOutput(probeCase.check, { text: answer.text, toolCalls: answer.tools.calls })
    ).toBe(1);
  });

  it('sends thinking disabled and no effort for the none variant', async () => {
    replies.push({ status: 200, body: anthropicCall({}) });
    await run({ catalogModel: model, model: haiku, variant: 'none' });
    const body = requests[0]!.body;
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config).toBeUndefined();
  });
});

describe('probe executor — failures keep the paid-call policy', () => {
  it('defers a 429 without scoring it', async () => {
    replies.push({ status: 429, body: '{"error":{"message":"rate limit"}}' });
    const result = await run();
    expect(result.costUsd).toBe(0);
    expect(isUnbilledTransientProviderResult(result)).toBe(true);
  });

  it('defers an unbilled 503', async () => {
    replies.push({ status: 503, body: 'upstream unavailable' });
    const result = await run();
    expect(isUnbilledTransientProviderResult(result)).toBe(true);
  });

  it('times out a request that never answered instead of failing the lane as ambiguous', async () => {
    replies.push({ status: 200, body: '', hold: 'before-headers' });
    const result = await run({ fetchImpl: withTimeout(20) });
    expect(result).toMatchObject({ timedOut: true, exitCode: 1, costUsd: 0 });
    expect(result.stderrTail).toBe(`probe request timed out after ${PROBE_TIMEOUT_MS}ms`);
    expect(result.lastEventTypes).toEqual(['error']);
  });

  it('times out a rejection whose timeout is not an Error, as the worker reports it', async () => {
    const result = await run({
      fetchImpl: () => Promise.reject({ name: 'TimeoutError' }),
    });
    expect(result).toMatchObject({ timedOut: true, exitCode: 1, costUsd: 0 });
    expect(result.stderrTail).toBe(`probe request timed out after ${PROBE_TIMEOUT_MS}ms`);
  });

  it('times out a stream that stops after the headers', async () => {
    replies.push({ status: 200, body: '', hold: 'after-headers' });
    const result = await run({ fetchImpl: withTimeout(20) });
    expect(result).toMatchObject({ timedOut: true, exitCode: 1, costUsd: 0 });
    expect(result.stderrTail).toBe(`probe request timed out after ${PROBE_TIMEOUT_MS}ms`);
  });

  it('records a terminal provider error that reported usage as a billed failure', async () => {
    replies.push({
      status: 200,
      body: responsesFailure('upstream overloaded', {
        input_tokens: 4000,
        output_tokens: 12,
        cost: 0.0008,
      }),
    });
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.costUsd).toBe(0.0008);
    expect(result.inputTokens).toBe(4000);
    expect(result.outputTokens).toBe(12);
    expect(result.stderrTail).toBe('provider error: upstream overloaded');
    expect(isUnbilledTransientProviderResult(result)).toBe(false);
  });

  it('defers a terminal provider error that reported no usage', async () => {
    replies.push({ status: 200, body: responsesFailure('service unavailable', null) });
    const result = await run();
    expect(result.costUsd).toBe(0);
    expect(result.inputTokens).toBeNull();
    expect(isUnbilledTransientProviderResult(result)).toBe(true);
  });

  it('never grades a failed generation after a partial tool call as a continuation', async () => {
    replies.push({
      status: 200,
      body: responsesFailureAfterCall('upstream overloaded', {
        input_tokens: 4000,
        output_tokens: 12,
        cost: 0.0008,
      }),
    });
    const billed = await run();
    expect(billed.exitCode).toBe(1);
    expect(billed.costUsd).toBe(0.0008);
    expect(billed.tools.calls).toBe(1);
    expect(billed.stderrTail).toBe('provider error: upstream overloaded');
    expect(isUnbilledTransientProviderResult(billed)).toBe(false);

    replies.push({ status: 200, body: responsesFailureAfterCall('service unavailable', null) });
    const unbilled = await run();
    expect(unbilled.costUsd).toBe(0);
    expect(unbilled.exitCode).toBe(1);
    expect(isUnbilledTransientProviderResult(unbilled)).toBe(true);
  });

  it('treats a rejected model as unavailable, which fails the entry permanently', async () => {
    replies.push({ status: 404, body: '{"error":{"message":"model not found"}}' });
    const result = await run();
    expect(isExactModelUnavailableResult(result, model)).toBe(true);
  });

  it('fails a family the probe cannot build instead of scoring it', async () => {
    await expect(
      run({
        catalogModel: catalogModel({ opencode: { ai_sdk_provider: 'anthropic' } }),
      })
    ).rejects.toBeInstanceOf(BenchmarkProbeFamilyError);
    await expect(
      run({
        catalogModel: catalogModel({
          id: 'arcee-ai/trinity-large-thinking',
          opencode: { ai_sdk_provider: 'openrouter' },
        }),
        model: 'arcee-ai/trinity-large-thinking',
      })
    ).rejects.toThrow(/has no captured request template/);
    expect(requests).toHaveLength(0);
  });

  it('uses the captured params rather than inventing them', async () => {
    expect(PROBE_TEMPLATES.families['meta/responses']?.tools.length).toBeGreaterThan(0);
    expect(PROBE_TEMPLATES.families['meta/responses']?.params).toMatchObject({
      store: false,
      stream: true,
      tool_choice: 'auto',
    });
  });
});

type RunnerFetch = (request: Request) => Promise<Response>;

function probeEnv(fetchRunner: RunnerFetch): Env {
  return {
    BENCH_RUNNER: {
      idFromName: (name: string) => `id:${name}`,
      get: () => ({ fetch: fetchRunner }),
    },
  } as unknown as Env;
}

const cancellableExecution = {
  runId: 'run-1',
  model,
  variant: 'high',
  rep: 0,
  caseId: probeCase.id,
  token: 'claim-token',
  attemptStartedAt: 1_700_000_000_000,
};

// The real issued pair for this generation, from the same issuer the worker uses, so the
// fixture cannot drift from the capability format and the executor never sees a provider
// token.
const issuedCapability = await issueCaseInferenceCapability('probe-test-secret', {
  engineIdentity: 'engine-1',
  runId: cancellableExecution.runId,
  model: cancellableExecution.model,
  variant: cancellableExecution.variant,
  caseId: cancellableExecution.caseId,
  repetition: cancellableExecution.rep,
  generation: 1,
  startedAt: cancellableExecution.attemptStartedAt,
});

const cancellableInference = {
  url: 'https://worker.test/case-inference',
  // The issuer's `invocationHeader` is the encoded value; the envelope names it `invocation`
  // and reserves `invocationHeader` for the header NAME, matching run.ts' mapping.
  authorization: issuedCapability.authorization,
  invocation: issuedCapability.invocationHeader,
  invocationHeader: BENCHMARK_CASE_HEADER,
};

function cancellableProbe(env: Env) {
  return runCancellableProbeCase(env, {
    instanceName: 'run:model:0',
    execution: cancellableExecution,
    inference: cancellableInference,
    model,
    variant: 'high',
    benchCase: probeCase,
    catalogModel: catalogModel(),
    kiloToken: 'user-token',
    kiloApiUrl: 'https://api.test',
    orgId: 'org-1',
    now: new Date('2026-11-20T09:00:00.000Z').getTime(),
  });
}

describe('runCancellableProbeCase', () => {
  it('runs the probe through the runner object that owns its generation', async () => {
    const sent: Request[] = [];
    const env = probeEnv(async request => {
      sent.push(request);
      return new Response(responsesCall(0.0012, 7), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const result = await cancellableProbe(env);

    expect(result.costUsd).toBe(0.0012);
    expect(result.tools.calls).toBe(1);
    expect(sent).toHaveLength(1);
    const forwarded = JSON.parse(await sent[0].clone().text());
    expect(forwarded.endpoint).toBe('responses');
    expect(forwarded.execution).toEqual(cancellableExecution);
    expect(forwarded.inference).toEqual(cancellableInference);
    expect(forwarded.timeoutMs).toBe(PROBE_TIMEOUT_MS);
    expect(JSON.stringify(forwarded)).not.toContain('user-token');
    expect(JSON.parse(forwarded.body)).toMatchObject({ model });
  });

  it('reports a cancelled generation as terminal instead of a timed-out probe', async () => {
    const env = probeEnv(async () =>
      Response.json(
        { error: 'case cancelled', cancelled: true },
        { status: 409, headers: { 'x-benchmark-runner': 'cancelled' } }
      )
    );

    await expect(cancellableProbe(env)).rejects.toBeInstanceOf(BenchmarkCaseCancelledError);
  });
});
