import { isResourceTokenIssuanceEnabled } from '@kilocode/web-shared/lib/config.server';
import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import { validateAuthorizationHeader } from '@kilocode/web-shared/lib/tokens';
import {
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';

const mockConfig: { secret: string | undefined; modern: boolean } = {
  secret: 'mint-secret',
  modern: true,
};
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  get BOT_TOKEN_MINT_SECRET() {
    return mockConfig.secret;
  },
  NEXTAUTH_SECRET: 'bot-token-signing-secret',
  isResourceTokenIssuanceEnabled: jest.fn(() => mockConfig.modern),
}));

const mockUserRows: unknown[] = [];
const mockMembershipRows: unknown[] = [];
let mockSelectCallCount = 0;
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    select: () => {
      const callIndex = mockSelectCallCount++;
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(callIndex === 0 ? mockUserRows : mockMembershipRows),
          }),
        }),
      };
    },
  },
}));

import { POST } from './route';

const BOT_ID = 'bot-internal-bouncer-watch';
const ORG_ID = 'org-1';
const AUTH = { authorization: 'Bearer mint-secret' };

function eligibleBot(overrides: Record<string, unknown> = {}) {
  return {
    id: BOT_ID,
    is_bot: true,
    api_token_pepper: 'pepper',
    blocked_at: null,
    blocked_reason: null,
    ...overrides,
  };
}

function createRequest(body: unknown, headers: Record<string, string> = AUTH) {
  return new NextRequest('http://localhost:3000/api/internal/bot-token', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const validBody = { userId: BOT_ID, organizationId: ORG_ID };

describe('POST /api/internal/bot-token', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.secret = 'mint-secret';
    mockConfig.modern = true;
    mockUserRows.length = 0;
    mockMembershipRows.length = 0;
    mockSelectCallCount = 0;
  });

  describe('auth', () => {
    it.each([
      ['missing', {}],
      ['wrong', { authorization: 'Bearer wrong' }],
      ['non-bearer', { authorization: 'mint-secret' }],
    ])('returns 401 for a %s secret without touching the database', async (_label, headers) => {
      mockUserRows.push(eligibleBot());
      mockMembershipRows.push({ role: 'member' });
      const res = await POST(createRequest(validBody, headers));
      expect(res.status).toBe(401);
      expect(mockSelectCallCount).toBe(0);
    });

    it.each([undefined, ''])('fails closed when the mint secret is %p', async secret => {
      mockConfig.secret = secret;
      mockUserRows.push(eligibleBot());
      mockMembershipRows.push({ role: 'member' });
      const res = await POST(createRequest(validBody, { authorization: 'Bearer ' }));
      expect(res.status).toBe(401);
      const resWithAnyToken = await POST(createRequest(validBody, { authorization: 'Bearer x' }));
      expect(resWithAnyToken.status).toBe(401);
    });
  });

  it.each([
    {},
    { userId: BOT_ID },
    { organizationId: ORG_ID },
    { userId: '', organizationId: ORG_ID },
  ])('returns 400 when the body is %p', async body => {
    const res = await POST(createRequest(body));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the user does not exist', async () => {
    const res = await POST(createRequest(validBody));
    expect(res.status).toBe(404);
  });

  it.each([
    ['a human user id', { id: 'user-1' }],
    ['a per-org product bot', { id: 'bot-code-review-org-1' }],
    ['is_bot=false', { is_bot: false }],
    ['blocked_at set', { blocked_at: '2026-10-01T00:00:00.000Z' }],
    ['blocked_reason set', { blocked_reason: 'manual block' }],
    ['a null pepper', { api_token_pepper: null }],
    ['an empty pepper', { api_token_pepper: '  ' }],
  ])('returns 403 for %s, in both token modes', async (_label, overrides) => {
    for (const modern of [true, false]) {
      mockConfig.modern = modern;
      mockSelectCallCount = 0;
      mockUserRows.length = 0;
      mockUserRows.push(eligibleBot(overrides));
      mockMembershipRows.length = 0;
      mockMembershipRows.push({ role: 'member' });
      const res = await POST(createRequest(validBody));
      expect(res.status).toBe(403);
    }
  });

  it('returns 404 when the bot is not a member of the organization', async () => {
    mockUserRows.push(eligibleBot());
    const res = await POST(createRequest(validBody));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Organization membership not found' });
  });

  it.each(['billing_manager'])('returns 403 for the %s role in both token modes', async role => {
    for (const modern of [true, false]) {
      mockConfig.modern = modern;
      mockSelectCallCount = 0;
      mockUserRows.length = 0;
      mockUserRows.push(eligibleBot());
      mockMembershipRows.length = 0;
      mockMembershipRows.push({ role });
      const res = await POST(createRequest(validBody));
      expect(res.status).toBe(403);
    }
  });

  it.each(['owner', 'member'] as const)(
    'issues a one-hour API and gateway token for an eligible %s bot',
    async role => {
      mockUserRows.push(eligibleBot());
      mockMembershipRows.push({ role });
      const before = Date.now();

      const res = await POST(createRequest(validBody));

      expect(res.status).toBe(200);
      const { token, expiresAt } = (await res.json()) as { token: string; expiresAt: string };
      const claims = jwt.verify(token, 'bot-token-signing-secret') as jwt.JwtPayload;
      expect(claims).toMatchObject({
        kiloUserId: BOT_ID,
        aud: [KILO_API_AUDIENCE, KILO_GATEWAY_AUDIENCE],
        apiTokenPepper: 'pepper',
        tokenPurpose: 'delegated-workload',
        credentialExchange: false,
        tokenSource: 'internal-bot',
        organizationId: ORG_ID,
        organizationRole: role,
      });
      expect(claims.exp! - claims.iat!).toBe(60 * 60);
      expect(new Date(expiresAt).getTime()).toBe(claims.exp! * 1000);
      expect(new Date(expiresAt).getTime() - before).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
      expect(isResourceTokenIssuanceEnabled).toHaveBeenCalledWith('internal-bot');

      const headers = new Headers({ authorization: `Bearer ${token}` });
      expect(
        validateAuthorizationHeader(headers, { expectedAudience: KILO_API_AUDIENCE }).error
      ).toBeUndefined();
      expect(
        validateAuthorizationHeader(headers, { expectedAudience: KILO_GATEWAY_AUDIENCE }).error
      ).toBeUndefined();
      expect(
        validateAuthorizationHeader(headers, { expectedAudience: 'unrelated-audience' }).error
      ).toMatch(/^Invalid token/);
    }
  );

  it('issues a one-hour legacy token while the family flag is off', async () => {
    mockConfig.modern = false;
    mockUserRows.push(eligibleBot());
    mockMembershipRows.push({ role: 'member' });

    const res = await POST(createRequest(validBody));

    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const claims = jwt.verify(token, 'bot-token-signing-secret') as jwt.JwtPayload;
    expect(claims).toMatchObject({
      kiloUserId: BOT_ID,
      tokenSource: 'internal-bot',
      organizationId: ORG_ID,
      organizationRole: 'member',
    });
    expect(claims).not.toHaveProperty('aud');
    expect(claims.exp! - claims.iat!).toBe(60 * 60);
  });
});
