const mockResolveGitCredentialsFromIntegration = jest.fn();

jest.mock('@/lib/gastown/git-credentials', () => ({
  resolveGitCredentialsFromIntegration: (...args: unknown[]) =>
    mockResolveGitCredentialsFromIntegration(...args),
}));

import { afterEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import { db } from '@/lib/drizzle';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { JWT_TOKEN_VERSION, TOKEN_EXPIRY } from '@/lib/tokens';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { platform_integrations, kilocode_users } from '@kilocode/db/schema';
import {
  GASTOWN_AUDIENCE,
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
  SESSION_INGEST_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { inArray } from 'drizzle-orm';
import { POST } from './route';

const createdUserIds: string[] = [];

function makeRequest(token: string, platformIntegrationId = crypto.randomUUID()) {
  return new NextRequest('http://localhost/api/gastown/git-credentials', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ platform_integration_id: platformIntegrationId }),
  });
}

function signToken(
  kiloUserId: string,
  options: {
    audience?: string;
    expiresIn?: number;
    secret?: string;
    extraPayload?: Record<string, unknown>;
  } = {}
) {
  return jwt.sign(
    {
      env: process.env.NODE_ENV,
      kiloUserId,
      apiTokenPepper: 'synthetic-test-pepper',
      version: JWT_TOKEN_VERSION,
      ...options.extraPayload,
    },
    options.secret ?? NEXTAUTH_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: options.expiresIn ?? TOKEN_EXPIRY.thirtyDays,
      ...(options.audience ? { audience: options.audience } : {}),
    }
  );
}

async function createUser() {
  const user = await insertTestUser({ api_token_pepper: 'synthetic-test-pepper' });
  createdUserIds.push(user.id);
  return user;
}

async function createUserGitHubIntegration(userId: string) {
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: userId,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: crypto.randomUUID(),
      repository_access: 'all',
      integration_status: 'active',
    })
    .returning({ id: platform_integrations.id });

  if (!integration) throw new Error('Expected GitHub integration fixture');
  return integration;
}

afterEach(async () => {
  mockResolveGitCredentialsFromIntegration.mockReset();
  if (createdUserIds.length > 0) {
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, createdUserIds));
    createdUserIds.length = 0;
  }
});

describe('POST /api/gastown/git-credentials', () => {
  test.each([
    [
      'Kilo API audience token',
      (userId: string) => signToken(userId, { audience: KILO_API_AUDIENCE }),
    ],
    [
      'legacy Gastown-shaped thirty-day token without an audience',
      (userId: string) => signToken(userId, { extraPayload: { gastownAccess: true } }),
    ],
  ])('accepts a %s for its owner before resolving credentials', async (_name, createToken) => {
    const user = await createUser();
    const integration = await createUserGitHubIntegration(user.id);
    mockResolveGitCredentialsFromIntegration.mockResolvedValue(null);

    const response = await POST(makeRequest(createToken(user.id), integration.id));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Could not resolve credentials for this integration',
    });
    expect(mockResolveGitCredentialsFromIntegration).toHaveBeenCalledWith(integration.id, user.id);
  });

  test('only resolves an integration owned by the signed user', async () => {
    const [owner, otherUser] = await Promise.all([createUser(), createUser()]);
    const integration = await createUserGitHubIntegration(owner.id);
    const token = signToken(otherUser.id, {
      audience: KILO_API_AUDIENCE,
      extraPayload: { userId: owner.id },
    });

    const response = await POST(makeRequest(token, integration.id));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Integration not found or not owned by this user',
    });
    expect(mockResolveGitCredentialsFromIntegration).not.toHaveBeenCalled();
  });

  test.each([
    [
      'gateway-only audience',
      (userId: string) => signToken(userId, { audience: KILO_GATEWAY_AUDIENCE }),
    ],
    ['Gastown audience', (userId: string) => signToken(userId, { audience: GASTOWN_AUDIENCE })],
    [
      'other worker audience',
      (userId: string) => signToken(userId, { audience: SESSION_INGEST_AUDIENCE }),
    ],
    ['malformed token', () => 'not-a-jwt'],
    [
      'wrong signature',
      (userId: string) => signToken(userId, { secret: 'different-synthetic-secret' }),
    ],
    ['expired token', (userId: string) => signToken(userId, { expiresIn: -1 })],
  ])(
    'rejects a %s before integration lookup or credential resolution',
    async (_name, createToken) => {
      const selectSpy = jest.spyOn(db, 'select');
      const token = createToken('unowned-synthetic-user');

      try {
        const response = await POST(makeRequest(token));

        expect(response.status).toBe(401);
        expect(selectSpy).not.toHaveBeenCalled();
      } finally {
        selectSpy.mockRestore();
      }
      expect(mockResolveGitCredentialsFromIntegration).not.toHaveBeenCalled();
    }
  );
});
