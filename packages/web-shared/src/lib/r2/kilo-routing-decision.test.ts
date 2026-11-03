import { after } from 'next/server';
import {
  KiloRoutingDecisionRecordSchema,
  type ProviderRoutingDecision,
} from '@kilocode/web-shared/lib/ai-gateway/providers/routing-decision';
import { archiveKiloRoutingDecision } from '@kilocode/web-shared/lib/r2/kilo-routing-decision';
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
      gateway: 'openrouter',
      bounded_spending: false,
      organization_vercel_disabled: false,
      kilo_ignored_providers: [],
    },
  ],
  byok_candidates: [],
  result: {
    kind: 'provider',
    route: 'kilo',
    provider_type: 'openrouter',
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
});

afterEach(() => jest.restoreAllMocks());

test.each([
  'R2_ACCOUNT_ID',
  'R2_AI_PROVIDER_METADATA_BUCKET_NAME',
  'R2_AI_PROVIDER_METADATA_ACCESS_KEY_ID',
  'R2_AI_PROVIDER_METADATA_SECRET_ACCESS_KEY',
])('does not archive without %s', name => {
  delete process.env[name];
  archiveKiloRoutingDecision(USAGE_ID, decision);
  expect(mockedAfter).not.toHaveBeenCalled();
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

test('uploads the decision after the response, keyed by the usage id', async () => {
  archiveKiloRoutingDecision(USAGE_ID, decision);
  expect(mockedAfter).toHaveBeenCalledTimes(1);
  expect(fakeR2.objects.size).toBe(0);
  expect(console.debug).toHaveBeenLastCalledWith('[kilo-routing-decision] scheduling archive', {
    usageId: USAGE_ID,
    bucket: 'test-provider-metadata',
  });

  await runScheduledUpload();

  expect(fakeR2.credentials).toEqual({
    accessKeyId: 'test-metadata-access-key',
    secretAccessKey: 'test-metadata-secret-key',
  });
  expect([...fakeR2.objects.keys()]).toEqual([`test-provider-metadata/kilo/${USAGE_ID}.json`]);
  expect(
    KiloRoutingDecisionRecordSchema.parse(
      JSON.parse(fakeR2.objects.get(`test-provider-metadata/kilo/${USAGE_ID}.json`) ?? '')
    )
  ).toEqual({
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

test('contains upload failures without logging the decision or the upstream error text', async () => {
  jest.spyOn(fakeR2, 'send').mockRejectedValue(new Error('sensitive upstream error text'));
  archiveKiloRoutingDecision(USAGE_ID, decision);

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
    /sensitive upstream|kimi|test-metadata-secret-key/
  );
});

test('reports a scheduling failure without throwing', () => {
  mockedAfter.mockImplementation(() => {
    throw new Error('after unavailable');
  });
  expect(() => archiveKiloRoutingDecision(USAGE_ID, decision)).not.toThrow();
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
