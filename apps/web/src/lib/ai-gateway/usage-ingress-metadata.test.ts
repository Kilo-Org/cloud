import { afterEach, beforeEach, expect, test } from '@jest/globals';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { MicrodollarUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { UsageRecordRequestSchema, type UsageRecordRequest } from '@kilocode/usage-contracts';

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ db: {}, readDb: {} }));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  startInactiveSpan: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  USAGE_INGEST_URL: 'https://synthetic.invalid/usage',
  USAGE_INGEST_PUBLISH_SECRET: 'synthetic-secret',
}));

import {
  extractUsageContextInfo,
  parseMicrodollarUsageFromString,
  toInsertableDbUsageRecord,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import { getMaxTokens } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import { enqueueUsage } from '@kilocode/web-shared/lib/ai-gateway/usage-publisher';

// Every input below is a synthetic reproduction of a rejection class (path, code and received
// type) seen at ingress. The rejected production values were never captured.

const send = jest
  .fn<Promise<void>, [UsageRecordRequest, { contentType: 'json' }]>()
  .mockResolvedValue(undefined);
// Load the actual Worker handler without importing its runtime globals into the Next.js typecheck.
const { handleFetch } = jest.requireActual<{
  handleFetch: (
    request: Request,
    env: { USAGE_INGEST_PUBLISH_SECRET: string; USAGE_INGEST_QUEUE: { send: typeof send } }
  ) => Promise<Response>;
}>('../../../../../services/usage-ingest/src/publish-usage');

const usageId = '12345678-1234-4234-8234-123456789ab2';
const context: MicrodollarUsageContext = {
  api_kind: 'chat_completions',
  kiloUserId: 'oauth/synthetic',
  usageId,
  provider: 'openrouter',
  requested_model: 'synthetic',
  fraudHeaders: {
    http_x_forwarded_for: null,
    http_x_vercel_ip_city: null,
    http_x_vercel_ip_country: null,
    http_x_vercel_ip_latitude: null,
    http_x_vercel_ip_longitude: null,
    http_x_vercel_ja4_digest: null,
    http_user_agent: null,
  },
  promptInfo: {
    user_prompt_prefix: 'synthetic',
    system_prompt_prefix: '',
    system_prompt_length: 0,
  },
  is_free: false,
  custom_llm_pricing: null,
  max_tokens: null,
  has_middle_out_transform: null,
  isStreaming: false,
  prior_microdollar_usage: 0,
  project_id: null,
  status_code: 200,
  editor_name: null,
  machine_id: null,
  user_byok: false,
  has_tools: false,
  feature: null,
  session_id: null,
  mode: null,
  auto_model: null,
  reasoning_setting: null,
  inference_region: null,
  ttfb_ms: null,
};

beforeEach(() => {
  send.mockClear();
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) =>
    handleFetch(new Request(String(url), init), {
      USAGE_INGEST_PUBLISH_SECRET: 'synthetic-secret',
      USAGE_INGEST_QUEUE: { send },
    })
  );
});
afterEach(() => {
  jest.restoreAllMocks();
});

type RequestKind = 'chat_completions' | 'messages' | 'responses';

/** The client body as the gateway sees it: raw JSON text parsed with `JSON.parse`. */
function clientRequest(kind: RequestKind, maxTokensJson: string | null): GatewayRequest {
  const field = {
    chat_completions: 'max_tokens',
    messages: 'max_tokens',
    responses: 'max_output_tokens',
  }[kind];
  const limit = maxTokensJson === null ? '' : `,"${field}":${maxTokensJson}`;
  const body: unknown = JSON.parse(`{"model":"synthetic","messages":[]${limit}}`);
  return { kind, body } as GatewayRequest;
}

/** The upstream non-streaming completion as the gateway receives it. */
function upstreamResponse({
  finishReasonJson = '"stop"',
  promptTokensJson = '10',
}: { finishReasonJson?: string; promptTokensJson?: string } = {}) {
  return `{"id":"gen-synthetic","model":"synthetic","provider":"synthetic","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":${finishReasonJson}}],"usage":{"prompt_tokens":${promptTokensJson},"completion_tokens":2,"total_tokens":12,"cost":0.000123,"is_byok":false}}`;
}

async function produceAndPublish({
  request = clientRequest('chat_completions', null),
  response = upstreamResponse(),
}: { request?: GatewayRequest; response?: string } = {}) {
  const usageStats = parseMicrodollarUsageFromString(
    response,
    context.kiloUserId,
    200,
    'openrouter'
  );
  const record = await toInsertableDbUsageRecord(
    usageStats,
    extractUsageContextInfo({
      ...context,
      api_kind: request.kind,
      max_tokens: getMaxTokens(request),
    })
  );
  const publication = await enqueueUsage({
    ...record,
    prior_microdollar_usage: 0,
    posthog_distinct_id: null,
  });
  return { record, publication };
}

function queuedPayload() {
  expect(send).toHaveBeenCalledTimes(1);
  const [payload] = send.mock.calls[0];
  // The consumer and the Frankfurt writer validate the queued message with this same contract.
  return UsageRecordRequestSchema.parse(JSON.parse(JSON.stringify(payload)));
}

function unrecordableLogs() {
  return jest
    .mocked(console.warn)
    .mock.calls.filter(
      ([message]) => message === 'usage metadata value outside the usage contract; recorded as null'
    );
}

test.each([
  { kind: 'chat_completions', json: '4096', expected: 4096 },
  { kind: 'messages', json: '1', expected: 1 },
  { kind: 'responses', json: '9007199254740991', expected: Number.MAX_SAFE_INTEGER },
  { kind: 'chat_completions', json: null, expected: null },
] as const)(
  'records a representable $kind token limit unchanged: $json',
  async ({ kind, json, expected }) => {
    const { publication } = await produceAndPublish({ request: clientRequest(kind, json) });
    expect(publication).toEqual({ kind: 'accepted' });
    expect(queuedPayload().metadata.max_tokens).toBe(expected);
    expect(unrecordableLogs()).toHaveLength(0);
  }
);

// `too_big` at metadata.max_tokens: Zod's integer validator rejects numbers above the safe range.
test.each([
  { kind: 'chat_completions', json: '9007199254740992' },
  { kind: 'messages', json: '1e20' },
  { kind: 'responses', json: '1.7976931348623157e308' },
] as const)(
  'queues usage whose $kind token limit is beyond the safe integer range: $json',
  async ({ kind, json }) => {
    const request = clientRequest(kind, json);
    const requestedLimit = getMaxTokens(request);
    const { record, publication } = await produceAndPublish({ request });

    expect(publication).toEqual({ kind: 'accepted' });
    const payload = queuedPayload();
    expect(payload.metadata.max_tokens).toBeNull();
    expect(payload.core).toEqual(record.core);
    // Only the usage telemetry is normalized; the request forwarded upstream keeps its value.
    expect(getMaxTokens(request)).toBe(requestedLimit);
    expect(unrecordableLogs()).toEqual([
      [
        expect.any(String),
        expect.objectContaining({
          usageId,
          fields: [{ field: 'max_tokens', received: 'unsafe_integer' }],
        }),
      ],
    ]);
  }
);

// `invalid_type` (expected integer, received number) at metadata.max_tokens.
test.each([
  { kind: 'chat_completions', json: '1.5' },
  { kind: 'messages', json: '4096.000001' },
  { kind: 'responses', json: '-0.5' },
] as const)('queues usage whose $kind token limit is fractional: $json', async ({ kind, json }) => {
  const { record, publication } = await produceAndPublish({ request: clientRequest(kind, json) });

  expect(publication).toEqual({ kind: 'accepted' });
  const payload = queuedPayload();
  expect(payload.metadata.max_tokens).toBeNull();
  expect(payload.core).toEqual(record.core);
  expect(unrecordableLogs()).toEqual([
    [
      expect.any(String),
      expect.objectContaining({ fields: [{ field: 'max_tokens', received: 'fractional' }] }),
    ],
  ]);
});

test('records a non-finite token limit as null, as JSON serialization already did', async () => {
  const { publication } = await produceAndPublish({
    request: clientRequest('chat_completions', '1e400'),
  });
  expect(publication).toEqual({ kind: 'accepted' });
  expect(queuedPayload().metadata.max_tokens).toBeNull();
  expect(unrecordableLogs()[0]?.[1]).toMatchObject({
    fields: [{ field: 'max_tokens', received: 'non_finite' }],
  });
});

// `invalid_type` (expected string, received number) at metadata.finish_reason.
test.each(['0', '1', '3.5'])(
  'queues usage whose upstream finish_reason is numeric: %s',
  async finishReasonJson => {
    const { record, publication } = await produceAndPublish({
      response: upstreamResponse({ finishReasonJson }),
    });

    expect(publication).toEqual({ kind: 'accepted' });
    const payload = queuedPayload();
    expect(payload.metadata.finish_reason).toBeNull();
    expect(payload.core).toEqual(record.core);
    expect(payload.core).toMatchObject({ input_tokens: 10, output_tokens: 2, has_error: false });
    expect(unrecordableLogs()).toEqual([
      [
        expect.any(String),
        expect.objectContaining({ fields: [{ field: 'finish_reason', received: 'number' }] }),
      ],
    ]);
  }
);

test.each(['"stop"', '"length"', '"tool_calls"', '"provider_specific_reason"', 'null'])(
  'records a string or absent upstream finish_reason unchanged: %s',
  async finishReasonJson => {
    const { publication } = await produceAndPublish({
      response: upstreamResponse({ finishReasonJson }),
    });
    expect(publication).toEqual({ kind: 'accepted' });
    expect(queuedPayload().metadata.finish_reason).toBe(JSON.parse(finishReasonJson));
    expect(unrecordableLogs()).toHaveLength(0);
  }
);

test('reports both fields on one record without logging the values', async () => {
  const { publication } = await produceAndPublish({
    request: clientRequest('chat_completions', '123456789012345678901'),
    response: upstreamResponse({ finishReasonJson: '987654321' }),
  });
  expect(publication).toEqual({ kind: 'accepted' });
  const logs = unrecordableLogs();
  expect(logs).toHaveLength(1);
  expect(logs[0][1]).toMatchObject({
    fields: [
      { field: 'max_tokens', received: 'unsafe_integer' },
      { field: 'finish_reason', received: 'number' },
    ],
  });
  const logged = JSON.stringify(logs[0]);
  expect(logged).not.toContain('123456789012345678901');
  expect(logged).not.toContain('1.2345678901234568e+20');
  expect(logged).not.toContain('987654321');
});

test('ingress still rejects a fractional billing token count from the producer', async () => {
  const { record, publication } = await produceAndPublish({
    response: upstreamResponse({ promptTokensJson: '10.5' }),
  });
  expect(record.core.input_tokens).toBe(10.5);
  expect(publication).toEqual({ kind: 'unavailable', reason: 'http_400' });
  expect(send).not.toHaveBeenCalled();
});
