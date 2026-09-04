import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import { validateAuthorizationHeader } from '@/lib/tokens';
import {
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';

const mockSharedResourceTokens = { enabled: false };
jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'internal-secret',
  NEXTAUTH_SECRET: 'benchmark-token-secret',
  isSharedResourceTokenIssuanceEnabled: jest.fn(() => mockSharedResourceTokens.enabled),
}));

const mockRows: unknown[] = [];
const mockMembershipRows: unknown[] = [];
let mockSelectCallCount = 0;
jest.mock('@/lib/drizzle', () => ({
  db: {
    select: () => {
      const callIndex = mockSelectCallCount++;
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(callIndex === 0 ? mockRows : mockMembershipRows),
          }),
        }),
      };
    },
  },
}));

import { POST } from './route';

function createRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3000/api/internal/auto-routing-benchmark/token', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('POST /api/internal/auto-routing-benchmark/token', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSharedResourceTokens.enabled = false;
    mockRows.length = 0;
    mockMembershipRows.length = 0;
    mockSelectCallCount = 0;
  });

  it('returns 401 without the bearer secret', async () => {
    const res = await POST(createRequest({ userId: 'user-1' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 with the wrong bearer secret', async () => {
    const res = await POST(createRequest({ userId: 'user-1' }, { authorization: 'Bearer wrong' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for an invalid body', async () => {
    mockSharedResourceTokens.enabled = true;
    const res = await POST(createRequest({}, { authorization: 'Bearer internal-secret' }));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the user does not exist', async () => {
    mockSharedResourceTokens.enabled = true;
    const res = await POST(
      createRequest({ userId: 'missing' }, { authorization: 'Bearer internal-secret' })
    );
    expect(res.status).toBe(404);
  });

  it('returns a sanitized 503 without minting when shared tokens are disabled', async () => {
    const sign = jest.spyOn(jwt, 'sign');
    const res = await POST(
      createRequest({ userId: 'user-1' }, { authorization: 'Bearer internal-secret' })
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'Service unavailable' });
    expect(sign).not.toHaveBeenCalled();
    sign.mockRestore();
  });

  it('mints one pepper-bound personal CLI token accepted by API and gateway audiences', async () => {
    mockSharedResourceTokens.enabled = true;
    mockRows.push({
      id: 'user-1',
      api_token_pepper: 'pepper',
      blocked_at: null,
      blocked_reason: null,
    });

    const res = await POST(
      createRequest({ userId: 'user-1' }, { authorization: 'Bearer internal-secret' })
    );

    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const claims = jwt.verify(token, 'benchmark-token-secret') as jwt.JwtPayload;
    expect(claims).toMatchObject({
      aud: [KILO_API_AUDIENCE, KILO_GATEWAY_AUDIENCE],
      apiTokenPepper: 'pepper',
      tokenPurpose: 'delegated-workload',
      credentialExchange: false,
      tokenSource: 'auto-routing-benchmark',
    });
    expect(claims.exp! - claims.iat!).toBe(6 * 60 * 60);
    expect(claims).not.toHaveProperty('organizationId');
    expect(claims).not.toHaveProperty('organizationRole');

    const headers = new Headers({ authorization: `Bearer ${token}` });
    expect(
      validateAuthorizationHeader(headers, { expectedAudience: KILO_API_AUDIENCE }).error
    ).toBeUndefined();
    expect(
      validateAuthorizationHeader(headers, { expectedAudience: KILO_GATEWAY_AUDIENCE }).error
    ).toBeUndefined();
    expect(
      validateAuthorizationHeader(headers, { expectedAudience: 'unrelated-audience' }).error
    ).toMatch(/^Invalid token \([a-f0-9-]+\)$/);
  });

  it('mints a dual-audience token with the exact eligible organization claims', async () => {
    mockSharedResourceTokens.enabled = true;
    mockRows.push({
      id: 'user-1',
      api_token_pepper: 'pepper',
      blocked_at: null,
      blocked_reason: null,
    });
    mockMembershipRows.push({ role: 'member' });

    const res = await POST(
      createRequest(
        { userId: 'user-1', organizationId: 'org-1' },
        { authorization: 'Bearer internal-secret' }
      )
    );

    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(jwt.verify(token, 'benchmark-token-secret')).toMatchObject({
      aud: [KILO_API_AUDIENCE, KILO_GATEWAY_AUDIENCE],
      organizationId: 'org-1',
      organizationRole: 'member',
      credentialExchange: false,
    });
  });

  it('does not mint a token for a user without an API token pepper', async () => {
    mockSharedResourceTokens.enabled = true;
    mockRows.push({ id: 'user-1', api_token_pepper: null, blocked_at: null, blocked_reason: null });

    const res = await POST(
      createRequest({ userId: 'user-1' }, { authorization: 'Bearer internal-secret' })
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'User is not eligible for benchmark tokens',
    });
  });

  it.each([
    { blocked_at: '2026-09-04T00:00:00.000Z', blocked_reason: null },
    { blocked_at: null, blocked_reason: 'manual block' },
  ])('does not mint a token for a blocked user', async blocked => {
    mockSharedResourceTokens.enabled = true;
    mockRows.push({ id: 'user-1', api_token_pepper: 'pepper', ...blocked });

    const res = await POST(
      createRequest({ userId: 'user-1' }, { authorization: 'Bearer internal-secret' })
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'User is not eligible for benchmark tokens',
    });
  });

  it('does not mint an organization token for an ineligible current role', async () => {
    mockSharedResourceTokens.enabled = true;
    mockRows.push({
      id: 'user-1',
      api_token_pepper: 'pepper',
      blocked_at: null,
      blocked_reason: null,
    });
    mockMembershipRows.push({ role: 'billing_manager' });

    const res = await POST(
      createRequest(
        { userId: 'user-1', organizationId: 'org-1' },
        { authorization: 'Bearer internal-secret' }
      )
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'Organization role is not supported for benchmark tokens',
    });
  });
});
