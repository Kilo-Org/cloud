import { POST } from './route';
import { getUserFromSessionForCredentialIssuance } from '@kilocode/web-shared/lib/user/server';
import { isOrganizationMember } from '@kilocode/worker-utils/account-access';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromSessionForCredentialIssuance: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ db: {} }));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'synthetic-signing-secret',
}));
jest.mock('@kilocode/worker-utils/account-access', () => ({ isOrganizationMember: jest.fn() }));
jest.mock('@kilocode/worker-utils/kilo-token-policy', () => ({ signModernKiloToken: jest.fn() }));
jest.mock('@/lib/web-config.server', () => ({ SESSION_SYNC_WORKER_URL: 'https://sync.test' }));
const auth = jest.mocked(getUserFromSessionForCredentialIssuance);
const member = jest.mocked(isOrganizationMember);
const sign = jest.mocked(signModernKiloToken);
const organizationId = '00000000-0000-4000-8000-000000000001';
const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const originalFetch = globalThis.fetch;
const request = (body: unknown = {}) =>
  new Request('https://app.test/api/session-sync/grant', {
    method: 'POST',
    body: JSON.stringify(body),
  });

beforeEach(() => {
  jest.resetAllMocks();
  globalThis.fetch = fetcher;
  auth.mockResolvedValue({
    user: { id: 'synthetic-user', api_token_pepper: 'synthetic-pepper' },
    authFailedResponse: null,
  } as Awaited<ReturnType<typeof getUserFromSessionForCredentialIssuance>>);
  sign.mockResolvedValue({
    token: 'private-human-credential',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
  member.mockResolvedValue(true);
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

test.each([undefined, organizationId])(
  'returns only a short grant for tenant %s',
  async organizationId => {
    const grant = {
      version: 1,
      token: 'short-sync-grant',
      expiresAt: new Date(Date.now() + 299_000).toISOString(),
      userID: 'synthetic-user',
      tenant: {
        type: organizationId ? 'organization' : 'user',
        id: organizationId ?? 'synthetic-user',
      },
    };
    fetcher.mockResolvedValue(
      Response.json({
        ...grant,
        credential: 'private-human-credential',
        headers: { Authorization: 'private' },
      })
    );
    const response = await POST(request({ organizationId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(grant);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenPurpose: 'human-api',
        audience: 'kilo-api',
        expiresInSeconds: 300,
        credentialExchange: false,
      })
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      redirect: 'error',
      headers: { Authorization: 'Bearer private-human-credential' },
      body: JSON.stringify({
        version: 1,
        ...(organizationId ? { organizationID: organizationId } : {}),
      }),
    });
  }
);

test('denies unauthenticated requests before signing', async () => {
  auth.mockResolvedValue({
    user: null,
    authFailedResponse: new Response(null, { status: 401 }),
  } as Awaited<ReturnType<typeof getUserFromSessionForCredentialIssuance>>);
  expect((await POST(request())).status).toBe(401);
  expect(sign).not.toHaveBeenCalled();
});

test('denies non-members before signing', async () => {
  member.mockResolvedValue(false);
  expect((await POST(request({ organizationId }))).status).toBe(403);
  expect(sign).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

test.each(['throw', 'refusal', 'scope', 'echo', 'oversized'])(
  'dependency %s exposes no credential or upstream detail',
  async mode => {
    if (mode === 'throw') fetcher.mockRejectedValue(new Error('private-human-credential'));
    else if (mode === 'refusal')
      fetcher.mockResolvedValue(
        Response.json({ credential: 'private-human-credential' }, { status: 403 })
      );
    else if (mode === 'oversized')
      fetcher.mockResolvedValue(new Response('private-human-credential'.repeat(1000)));
    else
      fetcher.mockResolvedValue(
        Response.json({
          version: 1,
          token: 'private-human-credential',
          expiresAt: new Date(Date.now() + 299_000).toISOString(),
          userID: mode === 'echo' ? 'synthetic-user' : 'foreign-user',
          tenant: { type: 'user', id: mode === 'echo' ? 'synthetic-user' : 'foreign-user' },
        })
      );
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(
      JSON.stringify({ error: 'Session sync authorization is unavailable' })
    );
  }
);
