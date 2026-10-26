import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { verifyGlanceableSnapshotCredential } from '@kilocode/worker-utils/glanceable-snapshot-credential';
import { glanceableDeliveryDeps } from './glanceable-delivery-deps';

const signingSecret = 'test-snapshot-signing-key';
const legacySecret = 'test-internal-secret';
const snapshot = {
  type: 'active_agents_glanceable',
  schemaVersion: 1,
  revision: 3,
  scopeKey: 'deadbeef',
  organizationBound: false,
  status: 'happy',
  running: 2,
  needsInput: 1,
  needsApproval: 1,
  idle: 0,
  scheduled: 0,
  updatedAt: '2026-10-21T10:00:00.000Z',
  expiresAt: '2026-10-21T18:00:00.000Z',
  needsInputSince: '2026-10-21T09:00:00.000Z',
  scheduledAt: null,
  newestResultKind: 'needsInput',
  newestResultAt: '2026-10-21T09:00:00.000Z',
};

function bindings(flag?: string) {
  const legacyKey = vi.fn(async () => legacySecret);
  const signingKey = vi.fn(async () => signingSecret);
  const workerEnv = {
    ...env,
    EVENT_SERVICE: {
      ...env.EVENT_SERVICE,
      isUserInContext: async () => false,
    },
    KILO_WEB_API_BASE_URL: 'https://snapshot.test',
    INTERNAL_SESSION_AUTH_LEGACY_ENABLED: flag,
    GLANCEABLE_SNAPSHOT_SIGNING_SECRET: { get: signingKey },
    INTERNAL_API_SECRET: { get: legacyKey },
  } as Env;
  return { workerEnv, legacyKey, signingKey };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('snapshot request authentication', () => {
  it.each([undefined, '', 'true'])(
    'supports a legacy receiver during compatibility %s',
    async flag => {
      const { workerEnv } = bindings(flag);
      let requestHeaders = new Headers();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: unknown, init?: RequestInit) => {
          requestHeaders = new Headers(init?.headers);
          return requestHeaders.get('X-Internal-Secret') === legacySecret
            ? Response.json(snapshot)
            : new Response(null, { status: 401 });
        })
      );
      expect(
        await glanceableDeliveryDeps(workerEnv).buildSnapshot('oauth/user', null)
      ).toMatchObject(snapshot);
      const token = requestHeaders.get('authorization')?.slice('Bearer '.length);
      if (!token) throw new Error('Expected a scoped bearer');
      expect(await verifyGlanceableSnapshotCredential({ token, secret: signingSecret })).toEqual({
        ok: true,
        userId: 'oauth/user',
      });
    }
  );

  it.each(['false', 'invalid'])('stops sending the legacy secret with flag %s', async flag => {
    const { workerEnv, legacyKey } = bindings(flag);
    let requestHeaders = new Headers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        requestHeaders = new Headers(init?.headers);
        const token = requestHeaders.get('authorization')?.slice('Bearer '.length);
        const verified =
          token && (await verifyGlanceableSnapshotCredential({ token, secret: signingSecret }));
        return verified && verified.ok
          ? Response.json(snapshot)
          : new Response(null, { status: 401 });
      })
    );
    expect(await glanceableDeliveryDeps(workerEnv).buildSnapshot('oauth/user', null)).toMatchObject(
      snapshot
    );
    expect(requestHeaders.has('X-Internal-Secret')).toBe(false);
    expect(legacyKey).not.toHaveBeenCalled();
  });

  it('does not downgrade when its signing key is missing', async () => {
    const { workerEnv, signingKey, legacyKey } = bindings('true');
    signingKey.mockResolvedValue('');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await glanceableDeliveryDeps(workerEnv).buildSnapshot('oauth/user', null)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(legacyKey).not.toHaveBeenCalled();
  });

  it('reports an unavailable legacy key without sending a partial compatibility request', async () => {
    const { workerEnv, legacyKey } = bindings('true');
    legacyKey.mockRejectedValue(new Error('secret store unavailable'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await glanceableDeliveryDeps(workerEnv).buildSnapshot('oauth/user', null)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
