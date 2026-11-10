import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { after, NextResponse } from 'next/server';
import type { EnkryptOutputDetectors, OrganizationSettings } from '@kilocode/db/schema-types';
import {
  ENKRYPT_DETECT_URL,
  ENKRYPT_MAX_SCAN_CHARACTERS,
  type EnkryptGuardrailVerdict,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import { createEmptyEnkryptOutputDetectors } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import {
  EnkryptOutputGuardrailReportSchema,
  type EnkryptOutputGuardrailReport,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import { resolveEnkryptOutputGuardrail } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import { recordEnkryptUsage } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  guardEnkryptOutput,
  MAX_HELD_OUTPUT_BYTES,
  OUTPUT_KEEP_ALIVE_INTERVAL_MS,
  resolveEnkryptOutputScan,
  type EnkryptOutputScan,
} from './output-guardrail';

jest.mock('next/server', () => ({
  ...jest.requireActual<Record<string, unknown>>('next/server'),
  after: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage'
  ),
  recordEnkryptUsage: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect'
  ),
  ENKRYPT_GUARDRAIL_TIMEOUT_MS: 100,
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ENKRYPT_API_KEY: 'test-enkrypt-key',
}));

const mockedAfter = jest.mocked(after);
const mockedRecordUsage = jest.mocked(recordEnkryptUsage);

const KINDS = ['chat_completions', 'messages', 'responses'] as const;
const FORMATS = ['sse', 'json'] as const;
type Format = (typeof FORMATS)[number];

const MODEL_OUTPUT = 'Here is the key sk-test-4242';
const SECRET = 'sk-test-4242';
const KEEP_ALIVE = ': KILO PROCESSING\n\n';
const BLOCK_MESSAGE =
  "Your organization's Enkrypt AI guardrail blocked the model's response (detected: pii). The response was flagged by your organization policy. Rephrase the request and retry.";

const pii = { enabled: true, entities: ['secrets'] };
const toxicity = { enabled: true };

function sse(events: { event?: string; data: unknown }[]): string {
  return events
    .map(({ event, data }) => {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      return `${event ? `event: ${event}\n` : ''}data: ${payload}\n\n`;
    })
    .join('');
}

const UPSTREAM_BODIES: Record<GatewayChatApiKind, Record<Format, string>> = {
  chat_completions: {
    sse: sse([
      {
        data: { choices: [{ index: 0, delta: { role: 'assistant', content: 'Here is the key' } }] },
      },
      { data: { choices: [{ index: 0, delta: { content: ` ${SECRET}` } }] } },
      { data: { choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } } },
      { data: '[DONE]' },
    ]),
    json: JSON.stringify({
      id: 'chatcmpl-1',
      choices: [{ index: 0, message: { role: 'assistant', content: MODEL_OUTPUT } }],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    }),
  },
  messages: {
    sse: sse([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { id: 'msg_1', content: [] } },
      },
      {
        event: 'content_block_start',
        data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Here is the key' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ` ${SECRET}` },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]),
    json: JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: MODEL_OUTPUT }],
    }),
  },
  responses: {
    sse: sse([
      {
        event: 'response.created',
        data: { type: 'response.created', response: { id: 'resp_1', output: [] } },
      },
      {
        event: 'response.output_text.delta',
        data: {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          delta: 'Here is the key',
        },
      },
      {
        event: 'response.output_text.delta',
        data: {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          delta: ` ${SECRET}`,
        },
      },
      {
        event: 'response.completed',
        data: { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } },
      },
    ]),
    json: JSON.stringify({
      id: 'resp_1',
      output: [{ type: 'message', content: [{ type: 'output_text', text: MODEL_OUTPUT }] }],
    }),
  },
};

const CONTENT_TYPES: Record<Format, string> = {
  sse: 'text/event-stream',
  json: 'application/json',
};

function upstreamResponse(body: BodyInit, format: Format): Response {
  return new Response(body, {
    status: 200,
    statusText: 'OK',
    headers: {
      'content-type': CONTENT_TYPES[format],
      'x-upstream-request-id': 'req_1',
      'request-id': 'req_1',
    },
  });
}

function detectors(overrides: Partial<EnkryptOutputDetectors>): EnkryptOutputDetectors {
  return { ...createEmptyEnkryptOutputDetectors(), ...overrides };
}

function outputSettings(saved: unknown): OrganizationSettings {
  return { kilo_encrypt: true, enkrypt: { output_guardrail: { enabled: true, detectors: saved } } };
}

const blockingPii = detectors({ pii: { enabled: true, action: 'block', entities: ['secrets'] } });
const logOnlyPii = detectors({ pii: { enabled: true, action: 'log', entities: ['secrets'] } });
const blockingPiiWithLogOnlyToxicity = detectors({
  pii: { enabled: true, action: 'block', entities: ['secrets'] },
  toxicity: { enabled: true, action: 'log' },
});

function request(apiKind: GatewayChatApiKind = 'chat_completions') {
  return {
    sessionId: 'ses_output',
    organizationId: 'org-1',
    kiloUserId: 'oauth/google:123',
    apiKind,
    clientRequestId: 'client-request-1',
  };
}

function outputScan(
  saved: unknown,
  apiKind: GatewayChatApiKind = 'chat_completions'
): EnkryptOutputScan {
  const scan = resolveEnkryptOutputScan(request(apiKind), outputSettings(saved));
  if (!scan) throw new Error('expected the output guardrail to be enabled');
  return scan;
}

function usageRecord(overrides: Record<string, unknown>) {
  return {
    organizationId: 'org-1',
    kiloUserId: 'oauth/google:123',
    sessionId: 'ses_output',
    apiKind: 'chat_completions',
    guardrail: 'output',
    ...overrides,
  };
}

type DetectRequest = {
  text: string;
  detectors: Record<string, unknown>;
  user_metadata: { organization_id: string };
};

function detected(summary: Record<string, unknown>): Response {
  return Response.json(
    { summary, result_message: 'Here is the key [REDACTED]' },
    { headers: { 'x-enkrypt-credits-cost': '2' } }
  );
}

const allowAll = () => detected({ pii: 0, toxicity: 0 });
const detectPii = () => detected({ pii: 1, toxicity: 0 });

function mockEnkrypt(
  respond: (request: DetectRequest, init: RequestInit) => Promise<Response> | Response
) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (input, init = {}) => {
    if (input !== ENKRYPT_DETECT_URL) throw new Error(`unexpected fetch to ${String(input)}`);
    const body: unknown = JSON.parse(String(init.body));
    return respond(body as DetectRequest, init);
  });
}

function detectRequests(fetchSpy: ReturnType<typeof mockEnkrypt>): DetectRequest[] {
  return fetchSpy.mock.calls.map(([, init]) => {
    const body: unknown = JSON.parse(String(init?.body));
    return body as DetectRequest;
  });
}

async function runAfterTasks() {
  await Promise.all(
    mockedAfter.mock.calls.map(([task]) => (typeof task === 'function' ? task() : task))
  );
}

function parseSingleSseEvent(text: string): { event: string | null; data: unknown } {
  const match = /^(?:event: (\S+)\n)?data: ([^\n]*)\n\n$/.exec(text);
  if (!match) throw new Error(`not a single SSE event: ${text}`);
  return { event: match[1] ?? null, data: JSON.parse(match[2]) };
}

async function guard(
  response: Response,
  scan: EnkryptOutputScan | null,
  kind: GatewayChatApiKind = 'chat_completions',
  stream = true,
  captureReport?: (report: () => Promise<EnkryptOutputGuardrailReport>) => void
) {
  const release = jest.fn(
    async (released: Response) =>
      new NextResponse(released.body, {
        status: released.status,
        statusText: released.statusText,
        headers: released.headers,
      })
  );
  const onReject = jest.fn(
    async (_rejection: NextResponse, _verdict: EnkryptGuardrailVerdict) => {}
  );
  const client = await guardEnkryptOutput({
    response,
    scan,
    kind,
    stream,
    signal: new AbortController().signal,
    release,
    onReject,
    captureReport,
  });
  return { client, release, onReject };
}

function reportCapture() {
  return jest.fn((_report: () => Promise<EnkryptOutputGuardrailReport>) => {});
}

async function capturedReport(
  captureReport: ReturnType<typeof reportCapture>
): Promise<EnkryptOutputGuardrailReport> {
  expect(captureReport).toHaveBeenCalledTimes(1);
  const [readReport] = captureReport.mock.calls[0];
  const report = EnkryptOutputGuardrailReportSchema.parse(await readReport());
  expect(JSON.stringify(report)).not.toContain(SECRET);
  return report;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

const blockingPiiSettings = {
  status: 'ready',
  scan_tool_results: false,
  detectors: [{ detector: 'pii', action: 'block', pii_entities: ['secrets'] }],
};

function scanReport(overrides: Record<string, unknown>) {
  return {
    scan: 'blocking',
    detectors_enabled: ['pii'],
    detectors_blocking: ['pii'],
    verdict_cache: 'off',
    total_characters: MODEL_OUTPUT.length,
    total_segments: 1,
    cached_characters: 0,
    cached_segments: 0,
    scanned_characters: MODEL_OUTPUT.length,
    decision: 'allowed',
    error: null,
    detectors_fired: [],
    attempts: 1,
    credits_cost: 2,
    latency_ms: expect.any(Number),
    ...overrides,
  };
}

function releasedResponse(release: { mock: { calls: [Response][] } }): Response {
  expect(release.mock.calls).toHaveLength(1);
  return release.mock.calls[0][0];
}

function rejection(onReject: { mock: { calls: [NextResponse, EnkryptGuardrailVerdict][] } }): {
  response: NextResponse;
  verdict: EnkryptGuardrailVerdict;
} {
  expect(onReject.mock.calls).toHaveLength(1);
  const [response, verdict] = onReject.mock.calls[0];
  return { response, verdict };
}

function afterKeepAlive(text: string): string {
  expect(text.startsWith(KEEP_ALIVE)).toBe(true);
  return text.slice(KEEP_ALIVE.length);
}

function lazyStream(chunk: Uint8Array, chunks: number) {
  const source = { pulls: 0, cancel: jest.fn() };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (source.pulls++ < chunks) controller.enqueue(chunk);
      else controller.close();
    },
    cancel: source.cancel,
  });
  return { stream, source };
}

const ONE_MIB = new Uint8Array(1024 * 1024);
const OVER_LIMIT_CHUNKS = MAX_HELD_OUTPUT_BYTES / ONE_MIB.byteLength + 1;

beforeEach(() => {
  mockedAfter.mockReset();
  mockedRecordUsage.mockReset().mockResolvedValue(undefined);
  jest.spyOn(console, 'debug').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('resolveEnkryptOutputScan', () => {
  it('returns null without an output guardrail', () => {
    expect(
      resolveEnkryptOutputScan(request(), {
        kilo_encrypt: true,
        enkrypt: { input_guardrail: { enabled: true } },
      })
    ).toBeNull();
    expect(resolveEnkryptOutputScan(request(), undefined)).toBeNull();
  });

  it('returns the request and inference association with the resolved output guardrail config', () => {
    const settings = outputSettings(blockingPii);
    const associatedRequest = {
      ...request('messages'),
      microdollarUsageId: '00000000-0000-4000-8000-000000000003',
    };

    expect(resolveEnkryptOutputScan(associatedRequest, settings)).toEqual({
      ...associatedRequest,
      config: resolveEnkryptOutputGuardrail('org-1', settings),
    });
  });
});

describe('guardEnkryptOutput', () => {
  it('releases the upstream response untouched without an output guardrail', async () => {
    const fetchSpy = mockEnkrypt(allowAll);
    const response = upstreamResponse(UPSTREAM_BODIES.chat_completions.sse, 'sse');

    const { client, release, onReject } = await guard(response, null);

    expect(releasedResponse(release)).toBe(response);
    expect(await client.text()).toBe(UPSTREAM_BODIES.chat_completions.sse);
    expect(onReject).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockedAfter).not.toHaveBeenCalled();
  });

  it('releases an upstream error response unscanned', async () => {
    const fetchSpy = mockEnkrypt(detectPii);
    const body = JSON.stringify({ error: { message: `Upstream failed near ${SECRET}` } });
    const response = new Response(body, {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });

    const { client, release, onReject } = await guard(
      response,
      outputScan(blockingPii),
      'chat_completions',
      false
    );

    expect(releasedResponse(release)).toBe(response);
    expect(client.status).toBe(500);
    expect(await client.text()).toBe(body);
    expect(onReject).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockedAfter).not.toHaveBeenCalled();
  });

  describe('with only log-only detectors', () => {
    it('releases the original response before the body completes and scans it afterwards', async () => {
      const fetchSpy = mockEnkrypt(allowAll);
      const body = UPSTREAM_BODIES.chat_completions.sse;
      const splitAt = body.indexOf('\n\n') + 2;
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      void writer.write(encoder.encode(body.slice(0, splitAt)));
      const response = upstreamResponse(readable, 'sse');

      const { client, release, onReject } = await guard(response, outputScan(logOnlyPii));

      expect(releasedResponse(release)).toBe(response);
      expect(fetchSpy).not.toHaveBeenCalled();

      void writer.write(encoder.encode(body.slice(splitAt)));
      void writer.close();
      expect(await client.text()).toBe(body);
      await runAfterTasks();

      expect(onReject).not.toHaveBeenCalled();
      expect(detectRequests(fetchSpy)).toEqual([
        { text: MODEL_OUTPUT, detectors: { pii }, user_metadata: { organization_id: 'org-1' } },
      ]);
      expect(mockedRecordUsage.mock.calls).toEqual([
        [usageRecord({ decision: 'allowed', creditsCost: 2, addedLatencyMs: 0 })],
      ]);
    });

    it('never rejects the response when a log-only detector fires', async () => {
      const fetchSpy = mockEnkrypt(detectPii);
      const body = UPSTREAM_BODIES.messages.json;
      const response = upstreamResponse(body, 'json');

      const { client, release, onReject } = await guard(
        response,
        outputScan(logOnlyPii, 'messages'),
        'messages',
        false
      );
      await runAfterTasks();

      expect(releasedResponse(release)).toBe(response);
      expect(onReject).not.toHaveBeenCalled();
      expect(await client.text()).toBe(body);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(mockedRecordUsage.mock.calls).toEqual([
        [
          usageRecord({
            apiKind: 'messages',
            decision: 'allowed',
            creditsCost: 2,
            addedLatencyMs: 0,
            detectorsFired: ['pii'],
          }),
        ],
      ]);
    });

    it('skips the log-only scan of a body over the held output limit', async () => {
      const fetchSpy = mockEnkrypt(allowAll);
      const { stream } = lazyStream(ONE_MIB, OVER_LIMIT_CHUNKS);
      const response = upstreamResponse(stream, 'sse');

      const { client, release } = await guard(response, outputScan(logOnlyPii));
      await runAfterTasks();

      expect(releasedResponse(release)).toBe(response);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockedRecordUsage).not.toHaveBeenCalled();
      await client.body?.cancel();
    });

    it('skips the log-only scan of output too large to scan', async () => {
      const fetchSpy = mockEnkrypt(allowAll);
      const body = JSON.stringify({
        choices: [{ index: 0, message: { content: 'x'.repeat(ENKRYPT_MAX_SCAN_CHARACTERS + 1) } }],
      });

      const { client } = await guard(upstreamResponse(body, 'json'), outputScan(logOnlyPii));

      expect(await client.text()).toBe(body);
      await runAfterTasks();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockedRecordUsage).not.toHaveBeenCalled();
    });
  });

  describe('with a blocking detector that allows the response', () => {
    it.each(KINDS.flatMap(kind => FORMATS.map(format => [kind, format] as const)))(
      'releases the %s %s body byte for byte',
      async (kind, format) => {
        const fetchSpy = mockEnkrypt(allowAll);
        const body = UPSTREAM_BODIES[kind][format];
        const stream = format === 'sse';

        const { client, release, onReject } = await guard(
          upstreamResponse(body, format),
          outputScan(blockingPii, kind),
          kind,
          stream
        );

        const text = await client.text();
        const released = releasedResponse(release);
        expect(released.status).toBe(200);
        expect(released.statusText).toBe('OK');
        expect(released.headers.get('content-type')).toBe(CONTENT_TYPES[format]);
        expect(released.headers.get('x-upstream-request-id')).toBe('req_1');
        expect(onReject).not.toHaveBeenCalled();
        expect(client.status).toBe(200);
        expect(client.headers.get('content-type')).toBe(CONTENT_TYPES[format]);
        expect(client.headers.get('request-id')).toBe('req_1');
        expect(text).toBe(stream ? `${KEEP_ALIVE}${body}` : body);
        expect(detectRequests(fetchSpy)).toEqual([
          { text: MODEL_OUTPUT, detectors: { pii }, user_metadata: { organization_id: 'org-1' } },
        ]);
      }
    );

    it('returns the released response directly for a streamed request with a JSON body', async () => {
      mockEnkrypt(allowAll);
      const body = UPSTREAM_BODIES.chat_completions.json;

      const { client, release } = await guard(
        upstreamResponse(body, 'json'),
        outputScan(blockingPii)
      );

      expect(client.headers.get('x-upstream-request-id')).toBe('req_1');
      expect(await client.text()).toBe(body);
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('scans log-only detectors in a separate call from the blocking detectors', async () => {
      const fetchSpy = mockEnkrypt(allowAll);

      const { client, release } = await guard(
        upstreamResponse(UPSTREAM_BODIES.chat_completions.sse, 'sse'),
        outputScan(blockingPiiWithLogOnlyToxicity)
      );
      await runAfterTasks();

      expect(await client.text()).toBe(`${KEEP_ALIVE}${UPSTREAM_BODIES.chat_completions.sse}`);
      expect(release).toHaveBeenCalledTimes(1);
      expect(detectRequests(fetchSpy)).toEqual(
        expect.arrayContaining([
          { text: MODEL_OUTPUT, detectors: { pii }, user_metadata: { organization_id: 'org-1' } },
          {
            text: MODEL_OUTPUT,
            detectors: { toxicity },
            user_metadata: { organization_id: 'org-1' },
          },
        ])
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('decodes multi-byte characters split across upstream chunks', async () => {
      const fetchSpy = mockEnkrypt(allowAll);
      const body = sse([{ data: { choices: [{ index: 0, delta: { content: 'café ☕' } }] } }]);
      const bytes = new TextEncoder().encode(body);
      const oneBytePerChunk = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      });

      const { client } = await guard(
        upstreamResponse(oneBytePerChunk, 'sse'),
        outputScan(blockingPii)
      );

      expect(await client.text()).toBe(`${KEEP_ALIVE}${body}`);
      expect(detectRequests(fetchSpy).map(({ text }) => text)).toEqual(['café ☕']);
    });

    it.each([false, true])(
      'replays the scanned part of a body that failed upstream, then fails with the same error (stream: %s)',
      async stream => {
        mockEnkrypt(allowAll);
        const error = new Error('upstream connection reset');
        let pulls = 0;
        const failing = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulls++ === 0) {
              controller.enqueue(new TextEncoder().encode(UPSTREAM_BODIES.chat_completions.sse));
            } else {
              controller.error(error);
            }
          },
        });

        const { client, release } = await guard(
          upstreamResponse(failing, 'sse'),
          outputScan(blockingPii),
          'chat_completions',
          stream
        );

        const reader = client.body?.getReader();
        const decoder = new TextDecoder();
        if (stream) expect(decoder.decode((await reader?.read())?.value)).toBe(KEEP_ALIVE);
        expect(decoder.decode((await reader?.read())?.value)).toBe(
          UPSTREAM_BODIES.chat_completions.sse
        );
        await expect(reader?.read()).rejects.toBe(error);
        expect(release).toHaveBeenCalledTimes(1);
      }
    );
  });

  describe('with a blocking detector that fires', () => {
    const openAiBlockedError = {
      error: {
        message: BLOCK_MESSAGE,
        type: 'invalid_request_error',
        code: 'guardrail_blocked',
        param: null,
      },
      error_type: 'guardrail_blocked',
    };
    const anthropicBlockedError = {
      type: 'error',
      error: { type: 'invalid_request_error', message: BLOCK_MESSAGE },
      error_type: 'guardrail_blocked',
    };

    it.each([
      ['chat_completions', openAiBlockedError],
      ['messages', anthropicBlockedError],
      ['responses', openAiBlockedError],
    ] as const)('rejects a %s JSON response with a native error', async (kind, expected) => {
      mockEnkrypt(detectPii);

      const { client, release, onReject } = await guard(
        upstreamResponse(UPSTREAM_BODIES[kind].json, 'json'),
        outputScan(blockingPii, kind),
        kind,
        false
      );

      expect(release).not.toHaveBeenCalled();
      const { response, verdict } = rejection(onReject);
      expect(response).toBe(client);
      expect(verdict).toEqual({ action: 'block', message: BLOCK_MESSAGE });
      expect(client.status).toBe(400);
      expect(client.headers.get('x-should-retry')).toBe('false');
      const text = await client.text();
      expect(text).not.toContain(SECRET);
      expect(JSON.parse(text)).toEqual(expected);
    });

    it.each([
      ['chat_completions', null, openAiBlockedError],
      ['messages', 'error', anthropicBlockedError],
      [
        'responses',
        'error',
        {
          type: 'error',
          sequence_number: 0,
          code: 'guardrail_blocked',
          message: BLOCK_MESSAGE,
          param: null,
          error: {
            type: 'invalid_request_error',
            code: 'guardrail_blocked',
            message: BLOCK_MESSAGE,
            param: null,
          },
          error_type: 'guardrail_blocked',
        },
      ],
    ] as const)(
      'rejects a %s stream with a keep-alive comment and a single SSE error event',
      async (kind, event, expected) => {
        mockEnkrypt(detectPii);

        const { client, release, onReject } = await guard(
          upstreamResponse(UPSTREAM_BODIES[kind].sse, 'sse'),
          outputScan(blockingPii, kind),
          kind,
          true
        );

        expect(client.status).toBe(200);
        expect(client.headers.get('content-type')).toBe('text/event-stream');
        const text = await client.text();
        expect(text).not.toContain(SECRET);
        expect(parseSingleSseEvent(afterKeepAlive(text))).toEqual({ event, data: expected });
        expect(release).not.toHaveBeenCalled();
        const { response, verdict } = rejection(onReject);
        expect(verdict).toEqual({ action: 'block', message: BLOCK_MESSAGE });
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        expect(response.headers.get('x-should-retry')).toBe('false');
      }
    );
  });

  describe('when the blocking scan cannot complete', () => {
    it('withholds the response after Enkrypt fails twice', async () => {
      const fetchSpy = mockEnkrypt(() => new Response('upstream error', { status: 500 }));

      const { client, release, onReject } = await guard(
        upstreamResponse(UPSTREAM_BODIES.chat_completions.json, 'json'),
        outputScan(blockingPii),
        'chat_completions',
        false
      );

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(release).not.toHaveBeenCalled();
      expect(rejection(onReject).verdict).toEqual({ action: 'unavailable', reason: 'transient' });
      expect(client.status).toBe(503);
      expect(client.headers.get('retry-after')).toBe('1');
      expect(await client.json()).toEqual({
        error: {
          message:
            "Your organization's Enkrypt AI guardrail could not check the model's response, so it was withheld. Please retry.",
          type: 'server_error',
          code: 'guardrail_unavailable',
          param: null,
        },
        error_type: 'guardrail_unavailable',
      });
    });

    it('sends a stream error event when Enkrypt fails on a streamed request', async () => {
      mockEnkrypt(() => new Response('upstream error', { status: 500 }));

      const { client, release, onReject } = await guard(
        upstreamResponse(UPSTREAM_BODIES.messages.sse, 'sse'),
        outputScan(blockingPii, 'messages'),
        'messages',
        true
      );

      expect(client.status).toBe(200);
      const text = await client.text();
      expect(text).not.toContain(SECRET);
      expect(parseSingleSseEvent(afterKeepAlive(text))).toEqual({
        event: 'error',
        data: {
          type: 'error',
          error: {
            type: 'api_error',
            message: expect.stringContaining("could not check the model's response"),
          },
          error_type: 'guardrail_unavailable',
        },
      });
      expect(release).not.toHaveBeenCalled();
      expect(rejection(onReject).response.headers.get('retry-after')).toBe('1');
    });

    it('withholds the response when the scan times out', async () => {
      mockEnkrypt(
        (_request, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          })
      );

      const { client, onReject } = await guard(
        upstreamResponse(UPSTREAM_BODIES.responses.json, 'json'),
        outputScan(blockingPii, 'responses'),
        'responses',
        false
      );

      expect(rejection(onReject).verdict).toEqual({ action: 'unavailable', reason: 'timeout' });
      expect(client.status).toBe(503);
      expect(client.headers.get('x-should-retry')).toBe('false');
      expect(await client.json()).toMatchObject({
        error: {
          message: expect.stringContaining("did not finish checking the model's response in time"),
        },
      });
    });

    it('withholds output too large to scan without calling Enkrypt', async () => {
      const fetchSpy = mockEnkrypt(allowAll);
      const body = JSON.stringify({
        choices: [{ index: 0, message: { content: 'x'.repeat(ENKRYPT_MAX_SCAN_CHARACTERS + 1) } }],
      });

      const { client, release, onReject } = await guard(
        upstreamResponse(body, 'json'),
        outputScan(blockingPii),
        'chat_completions',
        false
      );
      await runAfterTasks();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(rejection(onReject).verdict).toMatchObject({ action: 'block' });
      expect(client.status).toBe(400);
      expect(await client.json()).toMatchObject({
        error: {
          message: expect.stringContaining('3,000,000 characters of model output'),
          code: 'guardrail_blocked',
        },
      });
      expect(mockedRecordUsage).not.toHaveBeenCalled();
    });

    it('withholds a body over the held output limit and cancels the upstream body', async () => {
      const fetchSpy = mockEnkrypt(allowAll);
      const { stream, source } = lazyStream(ONE_MIB, OVER_LIMIT_CHUNKS + 10);

      const { client, release, onReject } = await guard(
        upstreamResponse(stream, 'sse'),
        outputScan(blockingPii),
        'chat_completions',
        false
      );
      await runAfterTasks();

      expect(source.cancel).toHaveBeenCalledTimes(1);
      expect(source.pulls).toBeLessThanOrEqual(OVER_LIMIT_CHUNKS + 1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(rejection(onReject).verdict).toMatchObject({ action: 'block' });
      expect(client.status).toBe(400);
      expect(await client.json()).toMatchObject({
        error: {
          message: expect.stringContaining('cannot hold back more than 64 MB of model response'),
          code: 'guardrail_blocked',
        },
      });
      expect(mockedRecordUsage).not.toHaveBeenCalled();
    });

    it('withholds the response without reading it when the saved output detectors are invalid', async () => {
      const fetchSpy = mockEnkrypt(allowAll);
      const scan = outputScan({ pii: 'bad' });
      const cancel = jest.fn();
      const neverEnding = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(UPSTREAM_BODIES.chat_completions.sse));
        },
        cancel,
      });

      const { client, release, onReject } = await guard(
        upstreamResponse(neverEnding, 'json'),
        scan,
        'chat_completions',
        false
      );

      expect(scan.config).toEqual({ scanToolResults: false, status: 'invalid' });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(rejection(onReject).verdict).toEqual({ action: 'unavailable', reason: 'failed' });
      expect(client.status).toBe(503);
      expect(client.headers.get('x-should-retry')).toBe('false');
      expect(await client.json()).toMatchObject({
        error: {
          message:
            "Your organization's Enkrypt AI guardrail could not check the model's response, so it was withheld. Try again later.",
          code: 'guardrail_unavailable',
        },
      });
      expect(mockedAfter).not.toHaveBeenCalled();
    });

    it('withholds a streamed response with no text when the saved output detectors are invalid', async () => {
      const fetchSpy = mockEnkrypt(allowAll);
      const body = sse([
        { data: { choices: [{ index: 0, delta: { content: '' } }] } },
        { data: '[DONE]' },
      ]);

      const { client, release, onReject } = await guard(
        upstreamResponse(body, 'sse'),
        outputScan({ pii: 'bad' })
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(rejection(onReject).verdict).toEqual({ action: 'unavailable', reason: 'failed' });
      expect(client.status).toBe(200);
      expect(parseSingleSseEvent(await client.text())).toEqual({
        event: null,
        data: {
          error: expect.objectContaining({
            message: expect.stringContaining("could not check the model's response"),
            code: 'guardrail_unavailable',
          }),
          error_type: 'guardrail_unavailable',
        },
      });
    });
  });

  describe('keep-alive', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('sends a keep-alive comment every 15 seconds until the scan decides', async () => {
      jest.useFakeTimers({
        doNotFake: [
          'Date',
          'hrtime',
          'nextTick',
          'performance',
          'queueMicrotask',
          'requestAnimationFrame',
          'cancelAnimationFrame',
          'requestIdleCallback',
          'cancelIdleCallback',
          'setImmediate',
          'clearImmediate',
          'setInterval',
          'clearInterval',
        ],
      });
      const verdict = Promise.withResolvers<Response>();
      const fetchSpy = mockEnkrypt(() => verdict.promise);
      const body = UPSTREAM_BODIES.chat_completions.sse;

      const { client, release } = await guard(
        upstreamResponse(body, 'sse'),
        outputScan(blockingPii)
      );
      const reader = client.body?.getReader();
      const decoder = new TextDecoder();

      expect(decoder.decode((await reader?.read())?.value)).toBe(KEEP_ALIVE);
      let secondSettled = false;
      const second = reader?.read().finally(() => {
        secondSettled = true;
      });
      await jest.advanceTimersByTimeAsync(OUTPUT_KEEP_ALIVE_INTERVAL_MS - 1);
      expect(secondSettled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(decoder.decode((await second)?.value)).toBe(KEEP_ALIVE);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();

      verdict.resolve(allowAll());
      let rest = '';
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        rest += decoder.decode(chunk.value, { stream: true });
      }

      expect(rest).toBe(body);
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  describe('usage', () => {
    it('preserves the inference association on output retries and log-only usage with latency only on the final blocking call', async () => {
      const microdollarUsageId = '00000000-0000-4000-8000-000000000003';
      let blockingCalls = 0;
      const fetchSpy = mockEnkrypt(request => {
        if ('pii' in request.detectors && blockingCalls++ === 0) {
          return new Response('upstream error', { status: 500 });
        }
        return allowAll();
      });

      const { client } = await guard(
        upstreamResponse(UPSTREAM_BODIES.chat_completions.sse, 'sse'),
        { ...outputScan(blockingPiiWithLogOnlyToxicity), microdollarUsageId }
      );
      expect(mockedAfter).toHaveBeenCalledTimes(1);
      await runAfterTasks();

      expect(await client.text()).toBe(`${KEEP_ALIVE}${UPSTREAM_BODIES.chat_completions.sse}`);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(mockedRecordUsage.mock.calls).toEqual([
        [
          usageRecord({
            microdollarUsageId,
            decision: 'error',
            creditsCost: null,
            addedLatencyMs: null,
          }),
        ],
        [
          usageRecord({
            microdollarUsageId,
            decision: 'allowed',
            creditsCost: 2,
            addedLatencyMs: expect.any(Number),
          }),
        ],
        [
          usageRecord({
            microdollarUsageId,
            decision: 'allowed',
            creditsCost: 2,
            addedLatencyMs: null,
          }),
        ],
      ]);
    });

    it('records a blocked response', async () => {
      mockEnkrypt(detectPii);

      await guard(
        upstreamResponse(UPSTREAM_BODIES.responses.sse, 'sse'),
        outputScan(blockingPii, 'responses'),
        'responses'
      );
      await runAfterTasks();

      expect(mockedRecordUsage.mock.calls).toEqual([
        [
          usageRecord({
            apiKind: 'responses',
            decision: 'blocked',
            creditsCost: 2,
            addedLatencyMs: expect.any(Number),
            detectorsFired: ['pii'],
          }),
        ],
      ]);
    });
  });

  describe('report', () => {
    it('reports a held-back stream that a blocking detector allows', async () => {
      mockEnkrypt(allowAll);
      const body = UPSTREAM_BODIES.chat_completions.sse;
      const captureReport = reportCapture();

      const { client } = await guard(
        upstreamResponse(body, 'sse'),
        outputScan(blockingPii),
        'chat_completions',
        true,
        captureReport
      );
      await client.text();
      await runAfterTasks();

      expect(await capturedReport(captureReport)).toEqual({
        settings: blockingPiiSettings,
        held_back: true,
        held_bytes: byteLength(body),
        held_ms: expect.any(Number),
        upstream_read_failed: false,
        output_characters: MODEL_OUTPUT.length,
        not_scanned_reason: null,
        verdict: 'allow',
        unavailable_reason: null,
        added_latency_ms: expect.any(Number),
        scans: [scanReport({})],
      });
    });

    it('reports both scans when a blocking detector fires alongside a log-only detector', async () => {
      mockEnkrypt(request =>
        'pii' in request.detectors ? detected({ pii: 1 }) : detected({ toxicity: 0 })
      );
      const body = UPSTREAM_BODIES.messages.sse;
      const captureReport = reportCapture();

      const { client } = await guard(
        upstreamResponse(body, 'sse'),
        outputScan(blockingPiiWithLogOnlyToxicity, 'messages'),
        'messages',
        true,
        captureReport
      );
      await client.text();
      await runAfterTasks();

      expect(await capturedReport(captureReport)).toEqual({
        settings: {
          status: 'ready',
          scan_tool_results: false,
          detectors: [
            { detector: 'pii', action: 'block', pii_entities: ['secrets'] },
            { detector: 'toxicity', action: 'log' },
          ],
        },
        held_back: true,
        held_bytes: byteLength(body),
        held_ms: expect.any(Number),
        upstream_read_failed: false,
        output_characters: MODEL_OUTPUT.length,
        not_scanned_reason: null,
        verdict: 'block',
        unavailable_reason: null,
        added_latency_ms: expect.any(Number),
        scans: [
          scanReport({ decision: 'blocked', detectors_fired: ['pii'] }),
          scanReport({
            scan: 'log_only',
            detectors_enabled: ['toxicity'],
            detectors_blocking: [],
          }),
        ],
      });
    });

    it('reports a transient Enkrypt failure', async () => {
      mockEnkrypt(() => new Response('upstream error', { status: 500 }));
      const body = UPSTREAM_BODIES.chat_completions.json;
      const captureReport = reportCapture();

      const { client } = await guard(
        upstreamResponse(body, 'json'),
        outputScan(blockingPii),
        'chat_completions',
        false,
        captureReport
      );
      await client.text();
      await runAfterTasks();

      expect(await capturedReport(captureReport)).toEqual({
        settings: blockingPiiSettings,
        held_back: true,
        held_bytes: byteLength(body),
        held_ms: expect.any(Number),
        upstream_read_failed: false,
        output_characters: MODEL_OUTPUT.length,
        not_scanned_reason: null,
        verdict: 'unavailable',
        unavailable_reason: 'transient',
        added_latency_ms: expect.any(Number),
        scans: [
          scanReport({
            decision: 'error_fail_closed',
            error: 'http_500',
            attempts: 2,
            credits_cost: null,
          }),
        ],
      });
    });

    it('reports invalid saved detectors without reading the response', async () => {
      const fetchSpy = mockEnkrypt(allowAll);
      const captureReport = reportCapture();

      const { client } = await guard(
        upstreamResponse(UPSTREAM_BODIES.chat_completions.json, 'json'),
        outputScan({ pii: 'bad' }),
        'chat_completions',
        false,
        captureReport
      );
      await client.text();
      await runAfterTasks();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await capturedReport(captureReport)).toEqual({
        settings: { status: 'invalid', scan_tool_results: false, detectors: [] },
        held_back: false,
        held_bytes: null,
        held_ms: null,
        upstream_read_failed: false,
        output_characters: null,
        not_scanned_reason: 'invalid_config',
        verdict: 'unavailable',
        unavailable_reason: 'failed',
        added_latency_ms: null,
        scans: [],
      });
    });

    it('reports output too large to scan', async () => {
      mockEnkrypt(allowAll);
      const content = `${SECRET}${'x'.repeat(ENKRYPT_MAX_SCAN_CHARACTERS)}`;
      const body = JSON.stringify({ choices: [{ index: 0, message: { content } }] });
      const captureReport = reportCapture();

      const { client } = await guard(
        upstreamResponse(body, 'json'),
        outputScan(blockingPii),
        'chat_completions',
        false,
        captureReport
      );
      await client.text();
      await runAfterTasks();

      expect(await capturedReport(captureReport)).toEqual({
        settings: blockingPiiSettings,
        held_back: true,
        held_bytes: byteLength(body),
        held_ms: expect.any(Number),
        upstream_read_failed: false,
        output_characters: content.length,
        not_scanned_reason: 'output_too_large',
        verdict: 'block',
        unavailable_reason: null,
        added_latency_ms: expect.any(Number),
        scans: [],
      });
    });

    it('reports held output over the limit', async () => {
      mockEnkrypt(allowAll);
      const { stream } = lazyStream(ONE_MIB, OVER_LIMIT_CHUNKS);
      const captureReport = reportCapture();

      const { client } = await guard(
        upstreamResponse(stream, 'sse'),
        outputScan(blockingPii),
        'chat_completions',
        false,
        captureReport
      );
      await client.text();
      await runAfterTasks();

      expect(await capturedReport(captureReport)).toEqual({
        settings: blockingPiiSettings,
        held_back: true,
        held_bytes: MAX_HELD_OUTPUT_BYTES,
        held_ms: expect.any(Number),
        upstream_read_failed: false,
        output_characters: null,
        not_scanned_reason: 'held_output_too_large',
        verdict: 'block',
        unavailable_reason: null,
        added_latency_ms: null,
        scans: [],
      });
    });

    it('reports a log-only scan once the copied response has been read', async () => {
      mockEnkrypt(allowAll);
      const body = UPSTREAM_BODIES.responses.sse;
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      void writer.write(encoder.encode(body.slice(0, 10)));
      const captureReport = reportCapture();

      const { client } = await guard(
        upstreamResponse(readable, 'sse'),
        outputScan(logOnlyPii, 'responses'),
        'responses',
        true,
        captureReport
      );

      expect(captureReport).toHaveBeenCalledTimes(1);
      let settled = false;
      const pending = captureReport.mock.calls[0][0]().finally(() => {
        settled = true;
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(settled).toBe(false);

      void writer.write(encoder.encode(body.slice(10)));
      void writer.close();
      expect(await client.text()).toBe(body);
      await runAfterTasks();
      await pending;

      expect(await capturedReport(captureReport)).toEqual({
        settings: {
          status: 'ready',
          scan_tool_results: false,
          detectors: [{ detector: 'pii', action: 'log', pii_entities: ['secrets'] }],
        },
        held_back: false,
        held_bytes: null,
        held_ms: null,
        upstream_read_failed: false,
        output_characters: MODEL_OUTPUT.length,
        not_scanned_reason: null,
        verdict: 'skip',
        unavailable_reason: null,
        added_latency_ms: null,
        scans: [scanReport({ scan: 'log_only', detectors_blocking: [] })],
      });
    });

    it('captures no report without an output guardrail', async () => {
      const captureReport = reportCapture();

      const { client } = await guard(
        upstreamResponse(UPSTREAM_BODIES.chat_completions.sse, 'sse'),
        null,
        'chat_completions',
        true,
        captureReport
      );
      await client.text();

      expect(captureReport).not.toHaveBeenCalled();
    });

    it('captures no report for an upstream error response', async () => {
      const captureReport = reportCapture();
      const response = new Response(JSON.stringify({ error: { message: 'overloaded' } }), {
        status: 529,
        headers: { 'content-type': 'application/json' },
      });

      const { client } = await guard(
        response,
        outputScan(blockingPii),
        'chat_completions',
        false,
        captureReport
      );
      await client.text();

      expect(captureReport).not.toHaveBeenCalled();
    });
  });
});
