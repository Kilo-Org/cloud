import { after } from 'next/server';
import { createVercelProviderMetadataCapture } from '@kilocode/web-shared/lib/r2/vercel-provider-metadata';
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

async function runScheduledUpload() {
  const callback = mockedAfter.mock.calls[0]?.[0];
  if (typeof callback !== 'function') throw new Error('Expected an after callback');
  await callback();
}

beforeEach(() => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    R2_VERCEL_PROVIDER_METADATA_BUCKET_NAME: 'test-provider-metadata',
    R2_VERCEL_PROVIDER_METADATA_ACCESS_KEY_ID: 'test-metadata-access-key',
    R2_VERCEL_PROVIDER_METADATA_SECRET_ACCESS_KEY: 'test-metadata-secret-key',
  });
  mockedAfter.mockReset();
  jest.spyOn(console, 'debug').mockImplementation(() => {});
  jest.mocked(errorExceptInTest).mockClear();
  fakeR2.objects.clear();
});

afterEach(() => jest.restoreAllMocks());

test.each([
  'R2_VERCEL_PROVIDER_METADATA_BUCKET_NAME',
  'R2_VERCEL_PROVIDER_METADATA_ACCESS_KEY_ID',
  'R2_VERCEL_PROVIDER_METADATA_SECRET_ACCESS_KEY',
])('disables capture without %s', name => {
  delete process.env[name];
  expect(createVercelProviderMetadataCapture()).toBeUndefined();
  expect(mockedAfter).not.toHaveBeenCalled();
  expect(console.debug).not.toHaveBeenCalled();
});

test('uploads the latest metadata once, after the response, keyed by generation ID', async () => {
  const capture = createVercelProviderMetadataCapture();
  const metadata = {
    gateway: {
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
    upstream: { additionalField: 'retained' },
  };

  capture?.({ gateway: { cost: '0.1' } }, 'gen_test');
  capture?.(metadata);
  capture?.(undefined, 'gen_test');
  expect(mockedAfter).toHaveBeenCalledTimes(1);
  expect(fakeR2.objects.size).toBe(0);
  expect(console.debug).toHaveBeenCalledTimes(1);
  expect(console.debug).toHaveBeenLastCalledWith('[vercel-provider-metadata] scheduling archive', {
    generationId: 'gen_test',
  });

  await runScheduledUpload();

  expect(fakeR2.credentials).toEqual({
    accessKeyId: 'test-metadata-access-key',
    secretAccessKey: 'test-metadata-secret-key',
  });
  expect([...fakeR2.objects]).toEqual([
    ['test-provider-metadata/gen_test.json', JSON.stringify(metadata)],
  ]);
  expect(console.debug).toHaveBeenCalledTimes(2);
  expect(console.debug).toHaveBeenLastCalledWith('[vercel-provider-metadata] archived metadata', {
    generationId: 'gen_test',
  });
});

test('retains metadata received before the generation ID', async () => {
  const capture = createVercelProviderMetadataCapture();
  const metadata = { gateway: { cost: '0.1' } };
  capture?.(metadata);
  expect(mockedAfter).not.toHaveBeenCalled();
  expect(console.debug).not.toHaveBeenCalled();

  capture?.(undefined, 'gen_late_id');
  await runScheduledUpload();

  expect(fakeR2.objects.get('test-provider-metadata/gen_late_id.json')).toBe(
    JSON.stringify(metadata)
  );
});

test('does not schedule an upload without an ID and valid metadata', () => {
  const capture = createVercelProviderMetadataCapture();
  for (const metadata of [undefined, null, false, 42, 'invalid', []]) {
    capture?.(metadata, 'gen_test');
  }
  expect(mockedAfter).not.toHaveBeenCalled();

  const captureWithoutId = createVercelProviderMetadataCapture();
  captureWithoutId?.({ gateway: {} }, '');
  expect(mockedAfter).not.toHaveBeenCalled();
});

test('contains upload failures without logging metadata or upstream error text', async () => {
  jest.spyOn(fakeR2, 'send').mockRejectedValue(new Error('sensitive upstream error text'));
  const capture = createVercelProviderMetadataCapture();
  capture?.({ gateway: { additionalField: 'private metadata' } }, 'gen_failed');

  await expect(runScheduledUpload()).resolves.toBeUndefined();

  expect(errorExceptInTest).toHaveBeenCalledWith(
    '[vercel-provider-metadata] failed to archive metadata',
    { generationId: 'gen_failed', errorType: 'Error' }
  );
  expect(JSON.stringify(jest.mocked(errorExceptInTest).mock.calls)).not.toMatch(
    /sensitive upstream|private metadata/
  );
  expect(console.debug).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(jest.mocked(console.debug).mock.calls)).not.toMatch(
    /sensitive upstream|private metadata/
  );
});

test('attempts registration and reports scheduling failures only once per response', () => {
  mockedAfter.mockImplementation(() => {
    throw new Error('after unavailable');
  });
  const capture = createVercelProviderMetadataCapture();
  expect(() => capture?.({ gateway: {} }, 'gen_test')).not.toThrow();
  expect(() => capture?.(undefined, 'gen_test')).not.toThrow();
  expect(() => capture?.({ gateway: { cost: '0.1' } }, 'gen_test')).not.toThrow();
  expect(mockedAfter).toHaveBeenCalledTimes(1);
  expect(errorExceptInTest).toHaveBeenCalledTimes(1);
  expect(console.debug).toHaveBeenCalledTimes(1);
});
