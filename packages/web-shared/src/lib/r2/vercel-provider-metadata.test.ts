import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import type { FakeR2ClientModule } from '@kilocode/web-shared/tests/helpers/fake-r2.helper';
import {
  getVercelProviderMetadata,
  storeVercelProviderMetadata,
} from '@kilocode/web-shared/lib/r2/vercel-provider-metadata';

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

const BUCKET = 'test-vercel-provider-metadata';
const ENV = {
  R2_VERCEL_PROVIDER_METADATA_BUCKET_NAME: BUCKET,
  R2_VERCEL_PROVIDER_METADATA_ACCESS_KEY_ID: 'test-access-key',
  R2_VERCEL_PROVIDER_METADATA_SECRET_ACCESS_KEY: 'test-secret-key',
};
Object.assign(process.env, ENV);

const GENERATION_ID = 'gen_01KKGSWN56EG1YK9Q5ZV5V4GQ9';
const METADATA = {
  gateway: { routing: { finalProvider: 'openai' }, generationId: GENERATION_ID },
  openai: { responseId: 'resp_123' },
};

describe('vercel provider metadata storage', () => {
  beforeEach(() => {
    fakeR2.objects.clear();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('stores the metadata under the generation id and reads it back', async () => {
    await storeVercelProviderMetadata(GENERATION_ID, METADATA);

    expect(fakeR2.objects.get(`${BUCKET}/${GENERATION_ID}.json`)).toBe(JSON.stringify(METADATA));
    expect(fakeR2.credentials).toEqual({
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    });
    expect(await getVercelProviderMetadata(GENERATION_ID)).toBe(JSON.stringify(METADATA));
  });

  test('returns null for a generation without stored metadata', async () => {
    expect(await getVercelProviderMetadata('gen_01MISSING0000000000000000')).toBeNull();
  });

  test.each(['', 'chatcmpl-123', 'gen_../other', 'gen_abc/def', `gen_${'a'.repeat(129)}`])(
    'ignores the invalid generation id %j',
    async generationId => {
      await storeVercelProviderMetadata(generationId, METADATA);

      expect(fakeR2.objects.size).toBe(0);
      expect(await getVercelProviderMetadata(generationId)).toBeNull();
    }
  );

  test('swallows upload failures', async () => {
    jest.spyOn(fakeR2, 'send').mockRejectedValueOnce(new Error('R2 unavailable'));

    await expect(storeVercelProviderMetadata(GENERATION_ID, METADATA)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      '[vercel-provider-metadata] failed to store metadata',
      { generationId: GENERATION_ID, error: 'Error: R2 unavailable' }
    );
  });

  test('skips storing and rejects reads when the bucket is not configured', async () => {
    const saved = { ...process.env };
    delete process.env.R2_VERCEL_PROVIDER_METADATA_BUCKET_NAME;
    try {
      await jest.isolateModulesAsync(async () => {
        const isolated = await import('@kilocode/web-shared/lib/r2/vercel-provider-metadata');
        const isolatedR2 = jest.requireMock<FakeR2ClientModule>(
          '@kilocode/web-shared/lib/r2/create-client'
        ).fakeR2;

        await isolated.storeVercelProviderMetadata(GENERATION_ID, METADATA);

        expect(isolatedR2.objects.size).toBe(0);
        await expect(isolated.getVercelProviderMetadata(GENERATION_ID)).rejects.toThrow(
          isolated.VercelProviderMetadataStorageNotConfiguredError
        );
      });
    } finally {
      process.env = saved;
    }
  });
});
