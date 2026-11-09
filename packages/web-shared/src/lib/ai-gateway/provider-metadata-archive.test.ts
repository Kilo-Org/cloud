import { PutObjectCommand } from '@aws-sdk/client-s3';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { after } from 'next/server';
import { countAndStoreUsage } from './processUsage';
import type { MicrodollarUsageContext } from './processUsage.types';
import { enqueueUsage } from './usage-publisher';
import { fetchGeneration } from './providers/upstream-request';
import {
  KiloRoutingDecisionRecordSchema,
  type ProviderRoutingDecision,
} from './providers/routing-decision';
import { createAiProviderMetadataCapture } from '@kilocode/web-shared/lib/r2/kilo-routing-decision';
import { getFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type { FakeR2ClientModule } from '@kilocode/web-shared/tests/helpers/fake-r2.helper';

jest.mock('next/server', () => ({
  ...jest.requireActual<object>('next/server'),
  after: jest.fn(),
}));
jest.mock('./usage-publisher', () => ({
  enqueueUsage: jest.fn(async () => ({ kind: 'accepted' })),
}));
jest.mock('./providers/upstream-request', () => ({ fetchGeneration: jest.fn() }));
jest.mock('./custom-pricing-config', () => ({
  getCustomPricingConfig: async () => ({ models: [] }),
}));
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/utils.server'),
  errorExceptInTest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/r2/create-client', () =>
  jest
    .requireActual<{
      createFakeR2ClientModule: () => FakeR2ClientModule;
    }>('@kilocode/web-shared/tests/helpers/fake-r2.helper')
    .createFakeR2ClientModule()
);

const { fakeR2 } = jest.requireMock<FakeR2ClientModule>(
  '@kilocode/web-shared/lib/r2/create-client'
);
const mockedAfter = jest.mocked(after);
const mockedEnqueueUsage = jest.mocked(enqueueUsage);
const USAGE_ID = '7d4a3c4e-8f1b-4f63-9a0e-2b8f6f1d5c21';
const GENERATION_ID = 'gen-provider-metadata-regression';
const MODEL = 'synthetic/archive-regression';
const BUCKET = 'test-provider-metadata';
const API_KINDS = ['chat_completions', 'messages', 'responses'] as const;
type ApiKind = (typeof API_KINDS)[number];
type JsonObject = Record<string, unknown>;

const metadata = {
  gateway: {
    generationId: 'vercel-generation-123',
    cost: '0.002',
    marketCost: '0.002',
    routing: { finalProvider: 'Synthetic', futureRoutingField: ['opaque', { retained: true }] },
  },
  future_provider: { nullValue: null, values: [false, 7, 'unknown'], nested: { retained: true } },
  arbitrary_top_level: 'preserved verbatim',
};

function createRequest(
  api_kind: ApiKind,
  isStreaming: boolean,
  provider: 'vercel' | 'openrouter' = 'vercel'
) {
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  if (!capture) throw new Error('Expected configured provider metadata capture');
  const decision: ProviderRoutingDecision = {
    requested_model: MODEL,
    api_kind,
    owner_type: 'user',
    steps: [
      { step: 'custom-llm', outcome: 'skipped', reason: 'no-match' },
      {
        step: 'kilo',
        outcome: 'selected',
        gateway: provider,
        bounded_spending: true,
        organization_disabled_vercel_ai_gateway: false,
        kilo_ignored_providers: ['synthetic-ignored'],
      },
    ],
    byok_candidates: [],
    result: {
      kind: 'provider',
      route: 'kilo',
      provider_type: provider,
      byok_provider_ids: [],
      payer: 'kilo',
      is_free: false,
    },
  };
  capture.captureRoutingDecision(decision);
  const context: MicrodollarUsageContext = {
    api_kind,
    kiloUserId: 'oauth/archive-regression',
    provider,
    fraudHeaders: getFraudDetectionHeaders(new Headers()),
    requested_model: MODEL,
    is_free: false,
    custom_llm_pricing: null,
    promptInfo: { system_prompt_prefix: '', system_prompt_length: 0, user_prompt_prefix: '' },
    max_tokens: null,
    has_middle_out_transform: null,
    isStreaming,
    prior_microdollar_usage: 0,
    project_id: null,
    status_code: null,
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
    usageId: USAGE_ID,
    providerMetadataCapture: capture,
  };
  return { capture, context, decision };
}

function jsonBody(apiKind: ApiKind, withUsage = true): JsonObject {
  const common = { id: GENERATION_ID, model: MODEL, provider: 'Synthetic' };
  const cost = { cost: 0.002, is_byok: false };
  if (apiKind === 'chat_completions') {
    return {
      ...common,
      choices: [{ message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
      ...(withUsage
        ? { usage: { ...cost, prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }
        : {}),
    };
  }
  return {
    ...common,
    ...(apiKind === 'messages'
      ? { type: 'message', content: [], stop_reason: 'end_turn' }
      : { output: [], status: 'completed' }),
    ...(withUsage ? { usage: { ...cost, input_tokens: 8, output_tokens: 3 } } : {}),
  };
}

function initialFrames(apiKind: ApiKind, withUsage = true): JsonObject[] {
  const body = jsonBody(apiKind, withUsage);
  if (apiKind === 'messages') {
    return [
      { type: 'message_start', message: body },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: body.usage },
    ];
  }
  if (apiKind === 'responses') return [{ type: 'response.created', response: body }];
  return [{ ...body, choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }];
}

function metadataFrame(apiKind: ApiKind, value: unknown): JsonObject {
  return {
    ...(apiKind === 'messages' ? { type: 'ping' } : {}),
    ...(apiKind === 'responses' ? { type: 'response.output_text.delta', delta: '' } : {}),
    provider_metadata: value,
  };
}

function sse(...frames: unknown[]): string {
  return frames
    .map(frame => `data: ${frame === '[DONE]' ? frame : JSON.stringify(frame)}\n\n`)
    .join('');
}

function controlledResponse() {
  const { promise, resolve } = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const response = new Response(
    new ReadableStream<Uint8Array>({ start: controller => resolve(controller) }),
    { headers: { 'content-type': 'text/event-stream' } }
  );
  return {
    response,
    async write(text: string) {
      (await promise).enqueue(new TextEncoder().encode(text));
    },
    async close() {
      (await promise).close();
    },
    async abort() {
      (await promise).error(new DOMException('Synthetic upstream interruption', 'ResponseAborted'));
    },
  };
}

function runArchive() {
  const callbacks = mockedAfter.mock.calls
    .map(([work]) => work)
    .filter((work): work is () => Promise<void> => typeof work === 'function');
  expect(callbacks).toHaveLength(1);
  return callbacks[0]();
}

function expectArchive(decision: ProviderRoutingDecision, expectedMetadata?: unknown) {
  expect(fakeR2.send).toHaveBeenCalledTimes(1);
  expect(fakeR2.send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
  const key = `${BUCKET}/${USAGE_ID}.json`;
  expect([...fakeR2.objects.keys()]).toEqual([key]);
  const record = JSON.parse(fakeR2.objects.get(key) ?? '');
  expect(record).toEqual({
    schema_version: 1,
    usage_id: USAGE_ID,
    created_at: expect.any(String),
    ...decision,
    ...(expectedMetadata === undefined ? {} : { vercel: { metadata: expectedMetadata } }),
  });
  expect(KiloRoutingDecisionRecordSchema.parse(record)).toEqual(record);
}

function expectBilling(hasError = false, cost = 2000) {
  expect(mockedEnqueueUsage).toHaveBeenCalledTimes(1);
  const payload = mockedEnqueueUsage.mock.calls[0]?.[0];
  expect(payload?.core).toEqual(
    expect.objectContaining({
      id: USAGE_ID,
      model: MODEL,
      has_error: hasError,
      cost,
      input_tokens: 8,
      output_tokens: 3,
    })
  );
  expect(payload?.metadata.id).toBe(USAGE_ID);
  expect(payload).not.toHaveProperty('providerMetadataCapture');
  expect(payload?.metadata).not.toHaveProperty('providerMetadataCapture');
}

beforeEach(() => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    VERCEL_TARGET_ENV: 'staging',
    VERCEL_ENV: 'preview',
    R2_ACCOUNT_ID: 'test-metadata-account',
    R2_AI_PROVIDER_METADATA_BUCKET_NAME: BUCKET,
    R2_AI_PROVIDER_METADATA_ACCESS_KEY_ID: 'test-metadata-access-key',
    R2_AI_PROVIDER_METADATA_SECRET_ACCESS_KEY: 'test-metadata-secret-key',
  });
  mockedAfter.mockReset();
  mockedEnqueueUsage.mockClear();
  jest.mocked(fetchGeneration).mockReset();
  jest.mocked(errorExceptInTest).mockClear();
  fakeR2.objects.clear();
  jest.spyOn(fakeR2, 'send');
  jest.spyOn(console, 'debug').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('raw provider metadata archive with usage accounting', () => {
  test.each(API_KINDS)(
    '%s JSON combines routing and opaque metadata in one deferred put',
    async apiKind => {
      const { context, decision } = createRequest(apiKind, false);
      await countAndStoreUsage(
        Response.json({ ...jsonBody(apiKind), provider_metadata: metadata }),
        context,
        undefined
      );

      expect(fakeR2.send).not.toHaveBeenCalled();
      expect(fakeR2.objects.size).toBe(0);
      expectBilling();
      await runArchive();
      expectArchive(decision, metadata);
    }
  );

  test.each(API_KINDS)(
    '%s JSON accepts camelCase metadata without changing billing',
    async apiKind => {
      const { context, decision } = createRequest(apiKind, false);
      await countAndStoreUsage(
        Response.json({ ...jsonBody(apiKind), providerMetadata: metadata }),
        context,
        undefined
      );

      await runArchive();
      expectArchive(decision, metadata);
      expectBilling();
    }
  );

  test.each(['provider_metadata', 'providerMetadata'])(
    'chat JSON visits every choice message with %s and replaces rather than merges metadata',
    async alias => {
      const { context, decision } = createRequest('chat_completions', false);
      await countAndStoreUsage(
        Response.json({
          ...jsonBody('chat_completions'),
          provider_metadata: { rootOnly: true },
          choices: [
            {
              message: { content: 'first', [alias]: { firstChoiceOnly: true } },
              finish_reason: 'stop',
            },
            { message: { content: 'second', [alias]: metadata }, finish_reason: 'stop' },
          ],
        }),
        context,
        undefined
      );

      await runArchive();
      expectArchive(decision, metadata);
      expectBilling();
    }
  );

  const streamLocations: { name: string; apiKind: ApiKind; frame: JsonObject }[] = [
    {
      name: 'chat first choice delta',
      apiKind: 'chat_completions',
      frame: { choices: [{ delta: { provider_metadata: metadata } }] },
    },
    {
      name: 'chat every choice delta and camelCase',
      apiKind: 'chat_completions',
      frame: {
        choices: [
          { delta: { provider_metadata: { stale: true } } },
          { delta: { providerMetadata: metadata } },
        ],
      },
    },
    {
      name: 'chat root after choice deltas',
      apiKind: 'chat_completions',
      frame: {
        choices: [{ delta: { provider_metadata: { stale: true } } }],
        providerMetadata: metadata,
      },
    },
    {
      name: 'chat root without choices',
      apiKind: 'chat_completions',
      frame: { provider_metadata: metadata },
    },
    {
      name: 'chat root with empty choices',
      apiKind: 'chat_completions',
      frame: { choices: [], providerMetadata: metadata },
    },
    {
      name: 'Messages message_start nested message',
      apiKind: 'messages',
      frame: {
        type: 'message_start',
        message: { ...jsonBody('messages'), provider_metadata: metadata },
      },
    },
    {
      name: 'Messages message_start camelCase nested message',
      apiKind: 'messages',
      frame: {
        type: 'message_start',
        message: { ...jsonBody('messages'), providerMetadata: metadata },
      },
    },
    {
      name: 'Messages message_start top envelope after nested message',
      apiKind: 'messages',
      frame: {
        type: 'message_start',
        message: { ...jsonBody('messages'), provider_metadata: { stale: true } },
        provider_metadata: metadata,
      },
    },
    {
      name: 'Messages message_delta top envelope',
      apiKind: 'messages',
      frame: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        providerMetadata: metadata,
      },
    },
    {
      name: 'Messages non-usage top envelope',
      apiKind: 'messages',
      frame: { type: 'ping', provider_metadata: metadata },
    },
    ...[
      'response.created',
      'response.in_progress',
      'response.completed',
      'response.incomplete',
      'response.failed',
      'error',
    ].flatMap(type => [
      {
        name: `Responses ${type} nested response`,
        apiKind: 'responses' as const,
        frame: { type, response: { ...jsonBody('responses'), providerMetadata: metadata } },
      },
      {
        name: `Responses ${type} top envelope after nested response`,
        apiKind: 'responses' as const,
        frame: {
          type,
          response: { ...jsonBody('responses'), provider_metadata: { stale: true } },
          provider_metadata: metadata,
        },
      },
    ]),
  ];

  test.each(streamLocations)(
    '$name is archived from the raw stream',
    async ({ apiKind, frame }) => {
      const { context, decision } = createRequest(apiKind, true);
      await countAndStoreUsage(
        new Response(sse(...initialFrames(apiKind), frame)),
        context,
        undefined
      );

      expect(fakeR2.send).not.toHaveBeenCalled();
      await runArchive();
      expectArchive(decision, metadata);
      expect(mockedEnqueueUsage).toHaveBeenCalledTimes(1);
    }
  );

  test.each(API_KINDS)('%s retains latest metadata across separate events', async apiKind => {
    const { context, decision } = createRequest(apiKind, true);
    await countAndStoreUsage(
      new Response(
        sse(
          metadataFrame(apiKind, { staleOnly: true, gateway: { staleGatewayOnly: true } }),
          ...initialFrames(apiKind),
          metadataFrame(apiKind, metadata),
          metadataFrame(apiKind, null),
          metadataFrame(apiKind, ['not an object']),
          '[DONE]'
        )
      ),
      context,
      undefined
    );

    await runArchive();
    expectArchive(decision, metadata);
    expectBilling();
  });

  test.each(API_KINDS)('%s archives metadata without usage or a response id', async apiKind => {
    const { context, decision } = createRequest(apiKind, false);
    const body = jsonBody(apiKind, false);
    delete body.id;
    await countAndStoreUsage(
      Response.json({ ...body, provider_metadata: metadata }),
      context,
      undefined
    );

    await runArchive();
    expectArchive(decision, metadata);
    expect(mockedEnqueueUsage.mock.calls[0]?.[0].core).toEqual(
      expect.objectContaining({ id: USAGE_ID, input_tokens: 0, output_tokens: 0 })
    );
  });

  test.each(API_KINDS)('%s SSE archives metadata without usage', async apiKind => {
    const { context, decision } = createRequest(apiKind, true);
    await countAndStoreUsage(
      new Response(
        sse(metadataFrame(apiKind, metadata), ...initialFrames(apiKind, false), '[DONE]')
      ),
      context,
      undefined
    );

    await runArchive();
    expectArchive(decision, metadata);
    expect(mockedEnqueueUsage.mock.calls[0]?.[0].core).toEqual(
      expect.objectContaining({ id: USAGE_ID, input_tokens: 0, output_tokens: 0 })
    );
  });

  test.each(API_KINDS)('%s preserves a route-only archive with an absent body', async apiKind => {
    const { context, decision } = createRequest(apiKind, false);
    await expect(countAndStoreUsage(new Response(null), context, undefined)).resolves.toBeNull();

    await runArchive();
    expectArchive(decision);
    expect(mockedEnqueueUsage).not.toHaveBeenCalled();
  });

  test.each(API_KINDS)(
    '%s preserves a route-only archive when JSON parsing fails',
    async apiKind => {
      const { context, decision } = createRequest(apiKind, false);
      await expect(
        countAndStoreUsage(new Response('{invalid JSON'), context, undefined)
      ).rejects.toThrow(SyntaxError);

      await expect(runArchive()).resolves.toBeUndefined();
      expectArchive(decision);
      expect(mockedEnqueueUsage).not.toHaveBeenCalled();
    }
  );

  test.each(
    API_KINDS.flatMap(apiKind =>
      ['malformed', 'transport abort'].map(failure => ({ apiKind, failure }))
    )
  )(
    '$apiKind retains partial metadata and bills hasError after $failure',
    async ({ apiKind, failure }) => {
      const { context, decision, capture } = createRequest(apiKind, true);
      const captured = jest.spyOn(capture, 'captureVercelMetadata');
      const upstream = controlledResponse();
      const accounting = countAndStoreUsage(upstream.response, context, undefined);
      const partial = metadataFrame(apiKind, metadata);
      await upstream.write(sse(...initialFrames(apiKind), partial));
      await nextTurn();
      expect(captured).toHaveBeenCalledWith(partial);
      if (failure === 'malformed') {
        await upstream.write('data: {malformed JSON\n\n');
        await upstream.close();
      } else {
        await upstream.abort();
      }

      await expect(accounting).resolves.toEqual(
        expect.objectContaining({ status: 'queued', usageId: USAGE_ID })
      );
      await runArchive();
      expectArchive(decision, metadata);
      expectBilling(true);
    }
  );

  test('client cancellation does not discard late metadata from the accounting response clone', async () => {
    const { context, decision } = createRequest('chat_completions', true);
    const upstream = controlledResponse();
    const accounting = countAndStoreUsage(upstream.response.clone(), context, undefined);
    await upstream.write(sse(...initialFrames('chat_completions')));
    const client = upstream.response.body?.getReader();
    if (!client) throw new Error('Expected client response body');
    await client.read();
    const cancelled = client.cancel('client disconnected');
    await upstream.write(sse(metadataFrame('chat_completions', metadata), '[DONE]'));
    await upstream.close();

    await accounting;
    await cancelled;
    await runArchive();
    expectArchive(decision, metadata);
    expectBilling();
  });

  test.each(API_KINDS)(
    '%s retains complete metadata before an unterminated final SSE event',
    async apiKind => {
      const { context, decision } = createRequest(apiKind, true);
      await countAndStoreUsage(
        new Response(
          `${sse(...initialFrames(apiKind), metadataFrame(apiKind, metadata))}data: ${JSON.stringify(metadataFrame(apiKind, { incomplete: true }))}\n`
        ),
        context,
        undefined
      );

      await runArchive();
      expectArchive(decision, metadata);
      expectBilling();
    }
  );

  test.each(
    API_KINDS.flatMap(apiKind =>
      (['vercel', 'openrouter'] as const).map(provider => ({ apiKind, provider }))
    )
  )(
    '$apiKind $provider protocol terminal does not leave an archive waiting for raw EOF',
    async ({ apiKind, provider }) => {
      const { context, decision } = createRequest(apiKind, true, provider);
      const upstream = controlledResponse();
      const accounting = countAndStoreUsage(upstream.response, context, undefined);
      const upload = runArchive();
      await nextTurn();
      if (provider === 'vercel') expect(fakeR2.send).not.toHaveBeenCalled();
      const terminal =
        apiKind === 'chat_completions'
          ? '[DONE]'
          : apiKind === 'messages'
            ? { type: 'message_stop', providerMetadata: metadata }
            : {
                type: 'response.completed',
                response: jsonBody(apiKind),
                providerMetadata: metadata,
              };
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await upstream.write(
          sse(
            ...initialFrames(apiKind),
            metadataFrame(
              apiKind,
              apiKind === 'chat_completions' ? metadata : { beforeTerminalOnly: true }
            ),
            terminal,
            metadataFrame(apiKind, { afterTerminalMustNotOverwrite: true })
          )
        );
        await Promise.race([
          upload,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Archive waited for physical EOF')), 1000);
          }),
        ]);
        expectArchive(decision, provider === 'vercel' ? metadata : undefined);
        expect(mockedEnqueueUsage).not.toHaveBeenCalled();
      } finally {
        clearTimeout(timeout);
        await upstream.close();
        await accounting;
        await upload;
      }
      expectBilling();
    }
  );

  test.each(API_KINDS)(
    '%s stream:true request parses an HTTP JSON response and preserves its billed usage',
    async apiKind => {
      const { context, decision } = createRequest(apiKind, true);
      await countAndStoreUsage(
        Response.json({ ...jsonBody(apiKind), provider_metadata: metadata }),
        context,
        undefined
      );

      await runArchive();
      expectArchive(decision, metadata);
      expectBilling();
      expect(mockedEnqueueUsage.mock.calls[0]?.[0].metadata.streamed).toBe(false);
    }
  );

  test.each(API_KINDS)(
    '%s stream:true request archives an HTTP JSON error with no usage',
    async apiKind => {
      const { context, decision } = createRequest(apiKind, true);
      await countAndStoreUsage(
        Response.json(
          { error: { message: 'Synthetic error' }, providerMetadata: metadata },
          { status: 502 }
        ),
        context,
        undefined
      );

      await runArchive();
      expectArchive(decision, metadata);
      expect(mockedEnqueueUsage.mock.calls[0]?.[0].core).toEqual(
        expect.objectContaining({ cost: 0, has_error: true })
      );
      expect(mockedEnqueueUsage.mock.calls[0]?.[0].metadata).toEqual(
        expect.objectContaining({ status_code: 502, streamed: false })
      );
    }
  );

  test.each(API_KINDS)(
    '%s stream:false request still harvests an HTTP SSE response',
    async apiKind => {
      const { context, decision } = createRequest(apiKind, false);
      await countAndStoreUsage(
        new Response(sse(...initialFrames(apiKind), metadataFrame(apiKind, metadata), '[DONE]'), {
          headers: { 'content-type': 'text/event-stream' },
        }),
        context,
        undefined
      );

      await runArchive();
      expectArchive(decision, metadata);
      expectBilling();
      expect(mockedEnqueueUsage.mock.calls[0]?.[0].metadata.streamed).toBe(true);
    }
  );

  test('ignores Vercel-looking metadata from a different serving provider', async () => {
    const { context, decision } = createRequest('chat_completions', false, 'openrouter');
    await countAndStoreUsage(
      Response.json({ ...jsonBody('chat_completions'), provider_metadata: metadata }),
      context,
      undefined
    );

    await runArchive();
    expectArchive(decision);
    expectBilling();
  });

  test('an archive upload failure does not reject accounting or change its billed record', async () => {
    const { context } = createRequest('chat_completions', false);
    jest.mocked(fakeR2.send).mockRejectedValueOnce(new Error('Synthetic object storage failure'));
    const accounting = countAndStoreUsage(
      Response.json({ ...jsonBody('chat_completions'), provider_metadata: metadata }),
      context,
      undefined
    );
    const upload = runArchive();

    await expect(accounting).resolves.toEqual(
      expect.objectContaining({ status: 'queued', usageId: USAGE_ID })
    );
    await expect(upload).resolves.toBeUndefined();
    expectBilling();
    expect(fakeR2.send).toHaveBeenCalledTimes(1);
    expect(fakeR2.objects.size).toBe(0);
    expect(errorExceptInTest).toHaveBeenCalledWith(
      '[kilo-routing-decision] failed to archive metadata',
      expect.objectContaining({ usageId: USAGE_ID, stage: 'upload' })
    );
  });
});
