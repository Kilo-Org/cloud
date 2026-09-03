import jwt from 'jsonwebtoken';
import { SESSION_INGEST_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  isKiloCredentialExchangeEligible,
  verifyKiloTokenForPolicy,
  verifyKiloTokenForResource,
} from '@kilocode/worker-utils/kilo-token-policy';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import {
  deleteSession,
  fetchSessionMessagesPage,
  fetchSessionSnapshot,
  shareSession,
  unshareSession,
} from './session-ingest-client';
import { notifyCliSessionRenamed } from './cloud-agent/session-events';

jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/lib/config.server'),
  SESSION_INGEST_WORKER_URL: 'https://session-ingest.test.invalid',
}));

const mockFetch = jest.fn();
const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = mockFetch;
});

const boundedTokenFlag = 'BOUNDED_INTERNAL_SERVICE_TOKENS_ENABLED';
const originalBoundedTokenFlag = process.env[boundedTokenFlag];
const userId = 'user_session_ingest_test';
const sessionId = 'ses_12345678901234567890123456';

function snapshotFixture() {
  return {
    info: { id: sessionId, title: 'Session title' },
    messages: messagesPageFixture().history.messages,
  };
}

function messagesPageFixture() {
  return {
    success: true as const,
    kiloSessionId: sessionId,
    history: {
      messages: [
        {
          info: {
            id: 'msg_1',
            sessionID: sessionId,
            role: 'user',
            time: { created: 1_761_000_000_100 },
            agent: 'build',
            model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
          },
          parts: [
            {
              id: 'prt_1',
              sessionID: sessionId,
              messageID: 'msg_1',
              type: 'text',
              text: 'Hello',
            },
          ],
        },
      ],
      nextCursor: 'opaque-next-cursor',
      omittedItemCount: 0,
    },
  };
}

function okJson(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body) };
}

function bearerToken(init: RequestInit | undefined): string {
  const authorization = new Headers(init?.headers).get('authorization');
  expect(authorization).toMatch(/^Bearer .+$/);
  if (!authorization) throw new Error('Expected bearer authorization header');
  return authorization.slice('Bearer '.length);
}

function verifiedClaims(token: string): jwt.JwtPayload {
  const claims = jwt.verify(token, NEXTAUTH_SECRET, { algorithms: ['HS256'] });
  if (typeof claims === 'string') throw new Error('Expected JWT payload claims');
  return claims;
}

afterEach(() => {
  global.fetch = originalFetch;
  mockFetch.mockReset();
  if (originalBoundedTokenFlag === undefined) {
    delete process.env[boundedTokenFlag];
  } else {
    process.env[boundedTokenFlag] = originalBoundedTokenFlag;
  }
});

describe('session-ingest client token issuance', () => {
  it.each([
    ['bounded issuance disabled', false],
    ['bounded issuance enabled', true],
  ])('uses real bounded tokens for every session-ingest flow when %s', async (_name, enabled) => {
    if (enabled) {
      process.env[boundedTokenFlag] = 'true';
    } else {
      delete process.env[boundedTokenFlag];
    }

    const snapshot = snapshotFixture();
    const messagesPage = messagesPageFixture();
    mockFetch
      .mockResolvedValueOnce(okJson(snapshot))
      .mockResolvedValueOnce(okJson(messagesPage))
      .mockResolvedValueOnce(okJson({ success: true, share_token: 'opaque-share-token' }))
      .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content' })
      .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content' })
      .mockResolvedValueOnce(okJson({ delivered: false }));

    await expect(fetchSessionSnapshot(sessionId, userId)).resolves.toEqual(snapshot);
    await expect(fetchSessionMessagesPage(sessionId, userId, { limit: 50 })).resolves.toEqual({
      kiloSessionId: sessionId,
      history: messagesPage.history,
    });
    await expect(shareSession(sessionId, userId)).resolves.toEqual({
      share_token: 'opaque-share-token',
    });
    await expect(unshareSession(sessionId, userId)).resolves.toBeUndefined();
    await expect(deleteSession(sessionId, userId)).resolves.toBeUndefined();
    await expect(
      notifyCliSessionRenamed({ sessionId, title: 'Renamed session', userId })
    ).resolves.toEqual({ delivered: false });

    expect(mockFetch).toHaveBeenCalledTimes(6);
    const tokens = mockFetch.mock.calls.map(([, init]) => bearerToken(init));
    expect(tokens).toHaveLength(6);

    for (const token of tokens) {
      const claims = verifiedClaims(token);
      expect(claims.version).toBe(3);
      expect(claims.kiloUserId).toBe(userId);
      if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
        throw new Error('Expected numeric token timestamps');
      }
      expect(claims.exp - claims.iat).toBe(60 * 60);
      expect(claims.env).toBeUndefined();
      expect(claims.apiTokenPepper).toBeUndefined();
      expect(claims.organizationId).toBeUndefined();

      await expect(
        verifyKiloTokenForResource(token, NEXTAUTH_SECRET, {
          audience: SESSION_INGEST_AUDIENCE,
          mode: 'allow-legacy',
        })
      ).resolves.toMatchObject({ kiloUserId: userId });

      const policyAuth = await verifyKiloTokenForPolicy(token, NEXTAUTH_SECRET, {
        audience: SESSION_INGEST_AUDIENCE,
        mode: 'allow-legacy',
      });
      expect(isKiloCredentialExchangeEligible(policyAuth, { legacy: 'five-year-api' })).toBe(false);

      if (enabled) {
        expect(claims).toMatchObject({
          aud: SESSION_INGEST_AUDIENCE,
          tokenPurpose: 'internal-service',
          credentialExchange: false,
        });
        await expect(
          verifyKiloTokenForResource(token, NEXTAUTH_SECRET, {
            audience: 'session-ingest:user-deletion',
            mode: 'required',
          })
        ).rejects.toThrow();
      } else {
        expect(claims.aud).toBeUndefined();
        expect(claims.tokenPurpose).toBeUndefined();
        expect(claims.credentialExchange).toBeUndefined();
      }
    }

    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      `https://session-ingest.test.invalid/api/session/${sessionId}/export`,
      `https://session-ingest.test.invalid/api/session/${sessionId}/messages?limit=50`,
      `https://session-ingest.test.invalid/api/session/${sessionId}/share`,
      `https://session-ingest.test.invalid/api/session/${sessionId}/unshare`,
      `https://session-ingest.test.invalid/api/session/${sessionId}`,
      `https://session-ingest.test.invalid/api/session/${sessionId}/rename-notify`,
    ]);
  });
});
