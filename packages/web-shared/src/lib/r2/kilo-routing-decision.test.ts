import { after } from 'next/server';
import { PutObjectCommand, S3ServiceException } from '@aws-sdk/client-s3';
import {
  KiloRoutingDecisionRecordSchema,
  type ByokFailoverAttempt,
  type ProviderRoutingDecision,
} from '@kilocode/web-shared/lib/ai-gateway/providers/routing-decision';
import type {
  EnkryptGuardrailReport,
  EnkryptOutputGuardrailReport,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import { createAiProviderMetadataCapture } from '@kilocode/web-shared/lib/r2/kilo-routing-decision';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type { FakeR2ClientModule } from '@kilocode/web-shared/tests/helpers/fake-r2.helper';

jest.mock('next/server', () => ({ after: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({ errorExceptInTest: jest.fn() }));
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

const USAGE_ID = '7d4a3c4e-8f1b-4f63-9a0e-2b8f6f1d5c21';

const decision: ProviderRoutingDecision = {
  requested_model: 'moonshotai/kimi-k2.6',
  api_kind: 'chat_completions',
  owner_type: 'user',
  steps: [
    { step: 'custom-llm', outcome: 'skipped', reason: 'no-match' },
    {
      step: 'kilo',
      outcome: 'selected',
      gateway: 'vercel',
      bounded_spending: false,
      organization_disabled_vercel_ai_gateway: false,
      kilo_ignored_providers: [],
    },
  ],
  byok_candidates: [],
  result: {
    kind: 'provider',
    route: 'kilo',
    provider_type: 'vercel',
    byok_provider_ids: [],
    payer: 'kilo',
    is_free: false,
  },
};

async function runScheduledUpload() {
  const callback = mockedAfter.mock.calls[0]?.[0];
  if (typeof callback !== 'function') throw new Error('Expected an after callback');
  await callback();
}

function archivedRecord() {
  return KiloRoutingDecisionRecordSchema.parse(
    JSON.parse(fakeR2.objects.get(`test-provider-metadata/${USAGE_ID}.json`) ?? '')
  );
}

beforeEach(() => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    R2_ACCOUNT_ID: 'test-metadata-account',
    R2_AI_PROVIDER_METADATA_BUCKET_NAME: 'test-provider-metadata',
    R2_AI_PROVIDER_METADATA_ACCESS_KEY_ID: 'test-metadata-access-key',
    R2_AI_PROVIDER_METADATA_SECRET_ACCESS_KEY: 'test-metadata-secret-key',
  });
  mockedAfter.mockReset();
  jest.spyOn(console, 'debug').mockImplementation(() => {});
  jest.mocked(errorExceptInTest).mockClear();
  fakeR2.objects.clear();
  jest.spyOn(fakeR2, 'send');
});

afterEach(() => jest.restoreAllMocks());

test.each([
  'R2_ACCOUNT_ID',
  'R2_AI_PROVIDER_METADATA_BUCKET_NAME',
  'R2_AI_PROVIDER_METADATA_ACCESS_KEY_ID',
  'R2_AI_PROVIDER_METADATA_SECRET_ACCESS_KEY',
])('does not archive without %s', name => {
  delete process.env[name];
  expect(createAiProviderMetadataCapture(USAGE_ID)).toBeUndefined();
  expect(mockedAfter).not.toHaveBeenCalled();
  expect(fakeR2.send).not.toHaveBeenCalled();
  expect(console.debug).toHaveBeenCalledTimes(1);
  expect(console.debug).toHaveBeenCalledWith(
    '[kilo-routing-decision] capture disabled: missing configuration',
    {
      accountConfigured: name !== 'R2_ACCOUNT_ID',
      bucketConfigured: name !== 'R2_AI_PROVIDER_METADATA_BUCKET_NAME',
      accessKeyIdConfigured: name !== 'R2_AI_PROVIDER_METADATA_ACCESS_KEY_ID',
      secretAccessKeyConfigured: name !== 'R2_AI_PROVIDER_METADATA_SECRET_ACCESS_KEY',
    }
  );
});

test('uploads a route-only decision after the response, keyed by the usage id', async () => {
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  expect(mockedAfter).not.toHaveBeenCalled();
  capture?.captureRoutingDecision(decision);
  expect(mockedAfter).toHaveBeenCalledTimes(1);
  expect(fakeR2.objects.size).toBe(0);
  expect(fakeR2.send).not.toHaveBeenCalled();
  expect(console.debug).toHaveBeenLastCalledWith('[kilo-routing-decision] scheduling archive', {
    usageId: USAGE_ID,
    bucket: 'test-provider-metadata',
  });

  await runScheduledUpload();

  expect(fakeR2.credentials).toEqual({
    accessKeyId: 'test-metadata-access-key',
    secretAccessKey: 'test-metadata-secret-key',
  });
  expect([...fakeR2.objects.keys()]).toEqual([`test-provider-metadata/${USAGE_ID}.json`]);
  expect(archivedRecord()).toEqual({
    schema_version: 1,
    usage_id: USAGE_ID,
    created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    ...decision,
  });
  expect(console.debug).toHaveBeenLastCalledWith('[kilo-routing-decision] archived metadata', {
    usageId: USAGE_ID,
    bucket: 'test-provider-metadata',
  });
});

test('combines full metadata fidelity and routing fields in exactly one PutObject', async () => {
  const metadata = {
    gateway: {
      generationId: 'vercel-generation-123',
      routing: {
        modelAttempts: [
          {
            providerAttempts: [
              { provider: 'openai', success: false, error: { code: 'rate_limit' }, duration: 250 },
              { provider: 'amazon-bedrock', success: true, duration: 600 },
            ],
          },
        ],
      },
      additionalField: { retained: true },
    },
    upstream: { additionalField: 'retained', array: [null, false, 4, 'unknown'] },
  };
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureRoutingDecision(decision);
  capture?.captureRoutingDecision({ ...decision, requested_model: 'ignored-repeat' });
  capture?.captureVercelMetadata({ provider_metadata: { superseded: true } });
  capture?.captureVercelMetadata({ providerMetadata: metadata });
  capture?.captureVercelMetadata({ choices: [] });
  expect(mockedAfter).toHaveBeenCalledTimes(1);
  expect(fakeR2.send).not.toHaveBeenCalled();

  await runScheduledUpload();

  expect(fakeR2.send).toHaveBeenCalledTimes(1);
  expect(fakeR2.send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
  expect(archivedRecord()).toEqual({
    schema_version: 1,
    usage_id: USAGE_ID,
    created_at: expect.any(String),
    ...decision,
    vercel: { metadata },
  });
  expect([...fakeR2.objects.keys()]).toEqual([`test-provider-metadata/${USAGE_ID}.json`]);
});

test('adds the Enkrypt guardrail report read at upload time', async () => {
  const enkrypt: EnkryptGuardrailReport = {
    settings: {
      status: 'ready',
      detectors: [{ detector: 'injection_attack', action: 'block' }],
    },
    verdict: 'block',
    unavailable_reason: null,
    added_latency_ms: 412,
    scans: [
      {
        scan: 'blocking',
        detectors_enabled: ['injection_attack'],
        detectors_blocking: ['injection_attack'],
        verdict_cache: 'hit',
        total_characters: 9_000,
        total_segments: 12,
        cached_characters: 8_000,
        cached_segments: 10,
        scanned_characters: 3_000,
        decision: 'blocked',
        error: null,
        detectors_fired: ['injection_attack'],
        attempts: 1,
        credits_cost: 3,
        latency_ms: 400,
        verdict_cache_write: 'skipped',
      },
    ],
  };
  const report = jest.fn(async () => enkrypt);
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureEnkryptReport(report);
  capture?.captureRoutingDecision(decision);
  expect(report).not.toHaveBeenCalled();

  await runScheduledUpload();

  expect(archivedRecord()).toEqual({
    schema_version: 1,
    usage_id: USAGE_ID,
    created_at: expect.any(String),
    ...decision,
    enkrypt,
  });
});

test('adds the Enkrypt output guardrail report read at upload time', async () => {
  const enkryptOutput: EnkryptOutputGuardrailReport = {
    settings: {
      status: 'ready',
      detectors: [{ detector: 'pii', action: 'block', pii_entities: ['secrets'] }],
    },
    held_back: true,
    held_bytes: 4_096,
    held_ms: 8_200,
    upstream_read_failed: false,
    output_characters: 1_200,
    not_scanned_reason: null,
    verdict: 'block',
    unavailable_reason: null,
    added_latency_ms: 310,
    scans: [
      {
        scan: 'blocking',
        detectors_enabled: ['pii'],
        detectors_blocking: ['pii'],
        verdict_cache: 'off',
        total_characters: 1_200,
        total_segments: 1,
        cached_characters: 0,
        cached_segments: 0,
        scanned_characters: 1_200,
        decision: 'blocked',
        error: null,
        detectors_fired: ['pii'],
        attempts: 1,
        credits_cost: 2,
        latency_ms: 300,
      },
    ],
  };
  const report = jest.fn(async () => enkryptOutput);
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureEnkryptOutputReport(report);
  capture?.captureRoutingDecision(decision);
  expect(report).not.toHaveBeenCalled();

  await runScheduledUpload();

  expect(archivedRecord()).toEqual({
    schema_version: 1,
    usage_id: USAGE_ID,
    created_at: expect.any(String),
    ...decision,
    enkrypt_output: enkryptOutput,
  });
});

test('archives the input report when the Enkrypt output report fails', async () => {
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureEnkryptReport(async () => null);
  capture?.captureEnkryptOutputReport(async () => {
    throw new TypeError('boom');
  });
  capture?.captureRoutingDecision(decision);

  await runScheduledUpload();

  expect(archivedRecord()).not.toHaveProperty('enkrypt_output');
  expect(errorExceptInTest).toHaveBeenCalledWith(
    '[kilo-routing-decision] Enkrypt output report failed; archived without it',
    { usageId: USAGE_ID, errorType: 'TypeError' }
  );
});

test('still archives the routing decision when the Enkrypt report fails', async () => {
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureEnkryptReport(async () => {
    throw new RangeError('Maximum call stack size exceeded');
  });
  capture?.captureRoutingDecision(decision);

  await runScheduledUpload();

  expect(archivedRecord()).toEqual({
    schema_version: 1,
    usage_id: USAGE_ID,
    created_at: expect.any(String),
    ...decision,
  });
  expect(errorExceptInTest).toHaveBeenCalledWith(
    '[kilo-routing-decision] Enkrypt report failed; archived without it',
    { usageId: USAGE_ID, errorType: 'RangeError' }
  );
});

test('omits the Enkrypt entry when no guardrail applied', async () => {
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureEnkryptReport(async () => null);
  capture?.captureRoutingDecision(decision);

  await runScheduledUpload();

  expect(archivedRecord()).not.toHaveProperty('enkrypt');
});

test('adds the BYOK failover attempts', async () => {
  const attempts: ByokFailoverAttempt[] = [
    {
      provider_type: 'vercel',
      byok_provider_ids: ['openai'],
      status: 429,
      error_code: 'insufficient_quota',
      duration_ms: 412,
      outcome: 'failed-over',
    },
    {
      provider_type: 'openrouter',
      byok_provider_ids: ['openrouter'],
      status: 200,
      duration_ms: 903,
      outcome: 'served',
    },
  ];
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureRoutingDecision(decision);
  capture?.captureByokFailoverAttempts(Promise.resolve(attempts));

  await runScheduledUpload();

  expect(archivedRecord()).toEqual({
    schema_version: 1,
    usage_id: USAGE_ID,
    created_at: expect.any(String),
    ...decision,
    byok_failover_attempts: attempts,
  });
});

test('awaits the BYOK failover attempts at upload time', async () => {
  const attempts = Promise.withResolvers<ByokFailoverAttempt[]>();
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureRoutingDecision(decision);
  capture?.captureByokFailoverAttempts(attempts.promise);
  expect(fakeR2.send).not.toHaveBeenCalled();

  const upload = runScheduledUpload();
  await Promise.resolve();
  expect(fakeR2.send).not.toHaveBeenCalled();
  attempts.resolve([
    {
      provider_type: 'vercel',
      byok_provider_ids: ['openai'],
      status: 429,
      error_code: 'rate_limit_error',
      duration_ms: 120,
      outcome: 'failed-over',
    },
  ]);
  await upload;

  expect(archivedRecord().byok_failover_attempts).toEqual([
    expect.objectContaining({ status: 429, error_code: 'rate_limit_error' }),
  ]);
});

test('archives without the BYOK failover attempts when they fail to resolve', async () => {
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureRoutingDecision(decision);
  capture?.captureByokFailoverAttempts(Promise.reject(new Error('upstream error text')));

  await runScheduledUpload();

  expect(archivedRecord()).toEqual({
    schema_version: 1,
    usage_id: USAGE_ID,
    created_at: expect.any(String),
    ...decision,
  });
  expect(errorExceptInTest).toHaveBeenCalledWith(
    '[kilo-routing-decision] BYOK failover attempts failed; archived without it',
    { usageId: USAGE_ID, errorType: 'Error' }
  );
  expect(JSON.stringify(jest.mocked(errorExceptInTest).mock.calls)).not.toMatch(
    /upstream error text/
  );
});

test.each([
  { name: 'none were captured', attempts: undefined },
  { name: 'an empty list was captured', attempts: Promise.resolve([]) },
])('omits the BYOK failover attempts when $name', async ({ attempts }) => {
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureRoutingDecision(decision);
  if (attempts) capture?.captureByokFailoverAttempts(attempts);

  await runScheduledUpload();

  expect(archivedRecord()).not.toHaveProperty('byok_failover_attempts');
});

test('does not register an archive from metadata or parser settlement without routing', async () => {
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureVercelMetadata({ provider_metadata: { captured: true } });
  capture?.waitFor(Promise.resolve());
  await Promise.resolve();
  expect(mockedAfter).not.toHaveBeenCalled();
  expect(fakeR2.send).not.toHaveBeenCalled();
});

test('defers serialization until the raw parser installed after routing settles', async () => {
  const parsing = Promise.withResolvers<unknown>();
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  const toJSON = jest.fn(() => ({ complete: true }));
  capture?.captureRoutingDecision(decision);
  capture?.waitFor(parsing.promise);
  capture?.captureVercelMetadata({ provider_metadata: { toJSON } });
  expect(toJSON).not.toHaveBeenCalled();

  const upload = runScheduledUpload();
  await Promise.resolve();
  expect(fakeR2.send).not.toHaveBeenCalled();
  expect(toJSON).not.toHaveBeenCalled();
  capture?.captureVercelMetadata({});
  parsing.resolve({ billing: 'unchanged' });
  await upload;

  expect(toJSON).toHaveBeenCalledTimes(1);
  expect(archivedRecord().vercel).toEqual({ metadata: { complete: true } });
  await expect(parsing.promise).resolves.toEqual({ billing: 'unchanged' });
});

test('normalizes rejected parsing without changing its rejection or dropping partial metadata', async () => {
  const parsing = Promise.withResolvers<unknown>();
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureRoutingDecision(decision);
  capture?.waitFor(parsing.promise);
  capture?.captureVercelMetadata({ provider_metadata: { partial: true } });
  const upload = runScheduledUpload();
  const error = new Error('sensitive parsing failure');
  parsing.reject(error);

  await expect(upload).resolves.toBeUndefined();
  await expect(parsing.promise).rejects.toBe(error);
  expect(archivedRecord().vercel).toEqual({ metadata: { partial: true } });
  expect(errorExceptInTest).not.toHaveBeenCalled();
});

test('handles an already rejected parsing promise without creating an unhandled rejection', async () => {
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureRoutingDecision(decision);
  capture?.waitFor(Promise.reject(new Error('parsing failed')));

  await expect(runScheduledUpload()).resolves.toBeUndefined();
  expect(archivedRecord()).not.toHaveProperty('vercel');
});

test.each([
  { api_kind: 'chat_completions', terminal: '[DONE]' },
  { api_kind: 'chat_completions', terminal: { error: { message: 'failed' } } },
  { api_kind: 'messages', terminal: { type: 'message_stop' } },
  { api_kind: 'messages', terminal: { type: 'error' } },
  { api_kind: 'responses', terminal: { type: 'response.completed' } },
  { api_kind: 'responses', terminal: { type: 'response.failed' } },
  { api_kind: 'responses', terminal: { type: 'response.incomplete' } },
  { api_kind: 'responses', terminal: { type: 'error' } },
] as const)(
  'archives on $api_kind terminal $terminal while raw parsing remains pending',
  async ({ api_kind, terminal }) => {
    const parsing = Promise.withResolvers<unknown>();
    const capture = createAiProviderMetadataCapture(USAGE_ID);
    capture?.captureRoutingDecision({ ...decision, api_kind });
    capture?.waitFor(parsing.promise);
    capture?.captureVercelMetadata({ provider_metadata: { before: true } });
    const upload = runScheduledUpload();
    await Promise.resolve();
    expect(fakeR2.send).not.toHaveBeenCalled();

    capture?.captureVercelMetadata(
      typeof terminal === 'string'
        ? terminal
        : { ...terminal, provider_metadata: { terminal: true } }
    );
    capture?.captureVercelMetadata({ provider_metadata: { ignored: true } });
    await upload;

    expect(archivedRecord().vercel).toEqual(
      typeof terminal === 'string'
        ? { metadata: { before: true } }
        : { metadata: { terminal: true } }
    );
    expect(fakeR2.send).toHaveBeenCalledTimes(1);
    parsing.reject(new Error('later accounting failure'));
    await Promise.resolve();
    expect(errorExceptInTest).not.toHaveBeenCalled();
  }
);

test('omits the Vercel envelope when metadata is invalid', async () => {
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureRoutingDecision(decision);
  for (const metadata of [undefined, null, false, 42, 'invalid', []]) {
    capture?.captureVercelMetadata({ provider_metadata: metadata });
  }
  await runScheduledUpload();

  expect(archivedRecord()).not.toHaveProperty('vercel');
});

test('archives metadata without a response id', async () => {
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureRoutingDecision(decision);
  capture?.captureVercelMetadata({ provider_metadata: {} });
  await runScheduledUpload();

  expect(archivedRecord().vercel).toEqual({ metadata: {} });
});

test('contains upload failures without logging the decision or the upstream error text', async () => {
  jest.spyOn(fakeR2, 'send').mockRejectedValue(new Error('sensitive upstream error text'));
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureRoutingDecision(decision);
  capture?.captureVercelMetadata({ provider_metadata: { private: 'private metadata' } });

  await expect(runScheduledUpload()).resolves.toBeUndefined();

  expect(errorExceptInTest).toHaveBeenCalledWith(
    '[kilo-routing-decision] failed to archive metadata',
    {
      usageId: USAGE_ID,
      bucket: 'test-provider-metadata',
      stage: 'upload',
      errorType: 'Error',
    }
  );
  expect(JSON.stringify(jest.mocked(errorExceptInTest).mock.calls)).not.toMatch(
    /sensitive upstream|kimi|private metadata|test-metadata-secret-key/
  );
});

test('includes safe S3 diagnostics without logging the raw service error', async () => {
  jest.spyOn(fakeR2, 'send').mockRejectedValue(
    new S3ServiceException({
      name: 'AccessDenied',
      $fault: 'client',
      $metadata: { httpStatusCode: 403, requestId: 'test-r2-request', attempts: 1 },
      message: 'sensitive upstream error text',
    })
  );
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureRoutingDecision(decision);
  capture?.captureVercelMetadata({ provider_metadata: { private: 'private metadata' } });

  await expect(runScheduledUpload()).resolves.toBeUndefined();

  expect(errorExceptInTest).toHaveBeenCalledWith(
    '[kilo-routing-decision] failed to archive metadata',
    {
      usageId: USAGE_ID,
      bucket: 'test-provider-metadata',
      stage: 'upload',
      errorType: 'AccessDenied',
      httpStatusCode: 403,
      requestId: 'test-r2-request',
      attempts: 1,
    }
  );
  expect(JSON.stringify(jest.mocked(errorExceptInTest).mock.calls)).not.toMatch(
    /sensitive upstream|private metadata|test-metadata-secret-key|test-metadata-access-key/
  );
});

test('contains deferred serialization failures without sending an object', async () => {
  const metadata: Record<string, unknown> = {};
  metadata.circular = metadata;
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  capture?.captureRoutingDecision(decision);
  capture?.captureVercelMetadata({ provider_metadata: metadata });

  await expect(runScheduledUpload()).resolves.toBeUndefined();

  expect(fakeR2.send).not.toHaveBeenCalled();
  expect(errorExceptInTest).toHaveBeenCalledWith(
    '[kilo-routing-decision] failed to archive metadata',
    expect.objectContaining({ stage: 'upload', errorType: 'TypeError' })
  );
});

test('reports a scheduling failure once without throwing or retrying registration', () => {
  mockedAfter.mockImplementation(() => {
    throw new Error('after unavailable');
  });
  const capture = createAiProviderMetadataCapture(USAGE_ID);
  expect(() => capture?.captureRoutingDecision(decision)).not.toThrow();
  expect(() => capture?.captureRoutingDecision(decision)).not.toThrow();
  capture?.captureVercelMetadata({ provider_metadata: {} });
  expect(mockedAfter).toHaveBeenCalledTimes(1);
  expect(errorExceptInTest).toHaveBeenCalledTimes(1);
  expect(fakeR2.send).not.toHaveBeenCalled();
  expect(errorExceptInTest).toHaveBeenCalledWith(
    '[kilo-routing-decision] failed to archive metadata',
    {
      usageId: USAGE_ID,
      bucket: 'test-provider-metadata',
      stage: 'registration',
      errorType: 'Error',
    }
  );
});
