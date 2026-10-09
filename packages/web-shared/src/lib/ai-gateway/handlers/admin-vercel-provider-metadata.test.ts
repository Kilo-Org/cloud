import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import type { FakeR2ClientModule } from '@kilocode/web-shared/tests/helpers/fake-r2.helper';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { handleAdminVercelProviderMetadataRequest } from './admin-vercel-provider-metadata';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
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
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

const BUCKET = 'test-vercel-provider-metadata';
Object.assign(process.env, {
  R2_VERCEL_PROVIDER_METADATA_BUCKET_NAME: BUCKET,
  R2_VERCEL_PROVIDER_METADATA_ACCESS_KEY_ID: 'test-access-key',
  R2_VERCEL_PROVIDER_METADATA_SECRET_ACCESS_KEY: 'test-secret-key',
});

const GENERATION_ID = 'gen_01KKGSWN56EG1YK9Q5ZV5V4GQ9';

function request(generationId: string) {
  return handleAdminVercelProviderMetadataRequest(
    new Request(`http://localhost/api/v1/admin/vercel-provider-metadata/${generationId}`),
    { params: Promise.resolve({ generationId }) }
  );
}

describe('GET /api/v1/admin/vercel-provider-metadata/[generationId]', () => {
  beforeEach(() => {
    fakeR2.objects.clear();
    mockedGetUserFromAuth.mockResolvedValue({
      user: defineTestUser({ is_admin: true }),
      authFailedResponse: null,
    });
  });

  test('requires an admin', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(
        { success: false, error: 'Access denied (nonadmin)' },
        { status: 403 }
      ),
    });
    fakeR2.objects.set(`${BUCKET}/${GENERATION_ID}.json`, '{}');

    const response = await request(GENERATION_ID);

    expect(mockedGetUserFromAuth).toHaveBeenCalledWith({ adminOnly: true });
    expect(response.status).toBe(403);
  });

  test('returns the stored provider metadata', async () => {
    const metadata = { gateway: { generationId: GENERATION_ID, cost: '0.01' } };
    fakeR2.objects.set(`${BUCKET}/${GENERATION_ID}.json`, JSON.stringify(metadata));

    const response = await request(GENERATION_ID);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual(metadata);
  });

  test('returns 404 when nothing is stored for the generation', async () => {
    const response = await request(GENERATION_ID);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: `No provider metadata stored for generation ${GENERATION_ID}`,
    });
  });

  test('returns 400 for a malformed generation id', async () => {
    const response = await request('not-a-generation');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid generation id' });
  });
});
