import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { accessGatewayRoutes } from './access-gateway';
import { signKiloToken } from '../auth/jwt';
import { deriveGatewayToken } from '../auth/gateway-token';
import { sandboxIdFromUserId } from '../auth/sandbox-id';
import { sandboxIdFromInstanceId } from '@kilocode/worker-utils/instance-id';
import { KILOCLAW_AUTH_COOKIE, KILOCLAW_ACTIVE_INSTANCE_COOKIE } from '../config';

const NEXTAUTH_SECRET = 'test-nextauth-secret';
const GATEWAY_TOKEN_SECRET = 'test-gateway-secret';
const USER_ID = 'user-1';
const INSTANCE_ID = '550e8400-e29b-41d4-a716-446655440000';
const INSTANCE_SANDBOX_ID = sandboxIdFromInstanceId(INSTANCE_ID);

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route('/', accessGatewayRoutes);
  return app;
}

function buildInstanceBinding(ownerUserId: string) {
  const stub = {
    getStatus: vi.fn().mockResolvedValue({
      userId: ownerUserId,
      sandboxId: INSTANCE_SANDBOX_ID,
    }),
  };
  return {
    idFromName: vi.fn().mockReturnValue('instance-id'),
    get: vi.fn().mockReturnValue(stub),
  };
}

function extractTokenFromRedirect(response: Response): string {
  const loc = response.headers.get('Location');
  if (!loc) throw new Error('missing Location');
  const hashIdx = loc.indexOf('#token=');
  if (hashIdx === -1) throw new Error(`Location has no #token=: ${loc}`);
  return loc.slice(hashIdx + '#token='.length);
}

async function signedAuthCookie(): Promise<string> {
  return signKiloToken({
    userId: USER_ID,
    pepper: null,
    secret: NEXTAUTH_SECRET,
    env: 'test',
  });
}

function parseSetCookies(response: Response): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const first = line.split(';')[0];
    const eq = first.indexOf('=');
    if (eq === -1) continue;
    cookies[first.slice(0, eq)] = first.slice(eq + 1);
  }
  return cookies;
}

function envBindings(overrides: Record<string, unknown> = {}) {
  return {
    NEXTAUTH_SECRET,
    GATEWAY_TOKEN_SECRET,
    WORKER_ENV: 'test',
    KILOCLAW_INSTANCE: buildInstanceBinding(USER_ID),
    KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
    KILOCLAW_INSTANCE_URL_SCHEME: 'https',
    ...overrides,
  } as never;
}

describe('access-gateway cookie scoping', () => {
  it('sets KILOCLAW_ACTIVE_INSTANCE_COOKIE on legacy host (claw.kilosessions.ai)', async () => {
    const app = buildApp();
    const token = await signedAuthCookie();

    const response = await app.fetch(
      new Request(
        `https://claw.kilosessions.ai/kilo-access-gateway?userId=${USER_ID}&instanceId=${INSTANCE_ID}`,
        { headers: { Cookie: `${KILOCLAW_AUTH_COOKIE}=${token}` } }
      ),
      envBindings()
    );

    expect(response.status).toBe(302);
    const cookies = parseSetCookies(response);
    expect(cookies[KILOCLAW_ACTIVE_INSTANCE_COOKIE]).toBe(INSTANCE_ID);
  });

  it('does NOT set KILOCLAW_ACTIVE_INSTANCE_COOKIE on per-instance virtual host', async () => {
    const app = buildApp();
    const token = await signedAuthCookie();
    const label = `i-${INSTANCE_ID.replaceAll('-', '')}`;

    const response = await app.fetch(
      new Request(
        `https://${label}.kiloclaw.ai/kilo-access-gateway?userId=${USER_ID}&instanceId=${INSTANCE_ID}`,
        { headers: { Cookie: `${KILOCLAW_AUTH_COOKIE}=${token}` } }
      ),
      envBindings()
    );

    expect(response.status).toBe(302);
    const cookies = parseSetCookies(response);
    expect(cookies[KILOCLAW_ACTIVE_INSTANCE_COOKIE]).toBeUndefined();
  });

  it('does NOT clear-cookie KILOCLAW_ACTIVE_INSTANCE_COOKIE on per-instance host when instanceId is absent', async () => {
    const app = buildApp();
    const token = await signedAuthCookie();
    const label = `i-${INSTANCE_ID.replaceAll('-', '')}`;

    // No instanceId query param — on legacy host this would clear the cookie.
    // On per-instance host we should emit no cookie header for the active-
    // instance cookie (set or clear) since the host is the routing signal.
    const response = await app.fetch(
      new Request(`https://${label}.kiloclaw.ai/kilo-access-gateway?userId=${USER_ID}`, {
        headers: { Cookie: `${KILOCLAW_AUTH_COOKIE}=${token}` },
      }),
      envBindings()
    );

    expect(response.status).toBe(302);
    const cookies = parseSetCookies(response);
    expect(cookies[KILOCLAW_ACTIVE_INSTANCE_COOKIE]).toBeUndefined();
  });

  it('respects a dev host suffix with a port', async () => {
    const app = buildApp();
    const token = await signedAuthCookie();
    const label = `i-${INSTANCE_ID.replaceAll('-', '')}`;
    const overrideEnv = envBindings({
      KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.localhost:8795',
      KILOCLAW_INSTANCE_URL_SCHEME: 'http',
    });

    const response = await app.fetch(
      new Request(
        `http://${label}.kiloclaw.localhost:8795/kilo-access-gateway?userId=${USER_ID}&instanceId=${INSTANCE_ID}`,
        { headers: { Cookie: `${KILOCLAW_AUTH_COOKIE}=${token}` } }
      ),
      overrideEnv
    );

    expect(response.status).toBe(302);
    const cookies = parseSetCookies(response);
    expect(cookies[KILOCLAW_ACTIVE_INSTANCE_COOKIE]).toBeUndefined();
  });
});

describe('access-gateway token derivation on per-instance hosts', () => {
  it('mints token from host-encoded sandbox on legacy host (same user)', async () => {
    const app = buildApp();
    const token = await signedAuthCookie();
    const legacySandboxId = sandboxIdFromUserId(USER_ID);
    // Derive the legacy label from the sandboxId helper so the test stays
    // in sync with the encoding.
    const { hostnameLabelFromSandboxId } = await import('../auth/hostname-label');
    const label = hostnameLabelFromSandboxId(legacySandboxId);
    if (!label) throw new Error('Expected legacy label for user-1');

    const response = await app.fetch(
      new Request(`https://${label}.kiloclaw.ai/kilo-access-gateway?userId=${USER_ID}`, {
        headers: { Cookie: `${KILOCLAW_AUTH_COOKIE}=${token}` },
      }),
      envBindings()
    );

    expect(response.status).toBe(302);
    const actualToken = extractTokenFromRedirect(response);
    const expectedToken = await deriveGatewayToken(legacySandboxId, GATEWAY_TOKEN_SECRET);
    expect(actualToken).toBe(expectedToken);
  });

  it('ignores instanceId query param on per-instance host and uses host sandbox', async () => {
    // User is on their legacy host but passes some other instanceId as a
    // query param. The token must be for the host-encoded legacy sandbox,
    // NOT for the query-param instance — otherwise the OpenClaw SPA would
    // receive a token mismatched with the host its requests go to.
    const app = buildApp();
    const token = await signedAuthCookie();
    const legacySandboxId = sandboxIdFromUserId(USER_ID);
    const { hostnameLabelFromSandboxId } = await import('../auth/hostname-label');
    const label = hostnameLabelFromSandboxId(legacySandboxId);
    if (!label) throw new Error('Expected legacy label for user-1');
    const otherInstanceId = '11111111-1111-1111-1111-111111111111';

    const response = await app.fetch(
      new Request(
        `https://${label}.kiloclaw.ai/kilo-access-gateway?userId=${USER_ID}&instanceId=${otherInstanceId}`,
        { headers: { Cookie: `${KILOCLAW_AUTH_COOKIE}=${token}` } }
      ),
      // Stub the DO to "own" whatever instanceId gets queried — proves the
      // host-derived sandbox still wins regardless.
      envBindings({ KILOCLAW_INSTANCE: buildInstanceBinding(USER_ID) })
    );

    expect(response.status).toBe(302);
    const actualToken = extractTokenFromRedirect(response);
    const expectedToken = await deriveGatewayToken(legacySandboxId, GATEWAY_TOKEN_SECRET);
    const queryInstanceToken = await deriveGatewayToken(
      sandboxIdFromInstanceId(otherInstanceId),
      GATEWAY_TOKEN_SECRET
    );
    expect(actualToken).toBe(expectedToken);
    expect(actualToken).not.toBe(queryInstanceToken);
  });

  it('mints token from instance-keyed host sandbox when authenticated user owns it', async () => {
    const app = buildApp();
    const token = await signedAuthCookie();
    const label = `i-${INSTANCE_ID.replaceAll('-', '')}`;

    const response = await app.fetch(
      new Request(
        `https://${label}.kiloclaw.ai/kilo-access-gateway?userId=${USER_ID}&instanceId=${INSTANCE_ID}`,
        { headers: { Cookie: `${KILOCLAW_AUTH_COOKIE}=${token}` } }
      ),
      envBindings()
    );

    expect(response.status).toBe(302);
    const actualToken = extractTokenFromRedirect(response);
    const expectedToken = await deriveGatewayToken(INSTANCE_SANDBOX_ID, GATEWAY_TOKEN_SECRET);
    expect(actualToken).toBe(expectedToken);
  });

  it('rejects instance-keyed host when another user owns the instance', async () => {
    const app = buildApp();
    const token = await signedAuthCookie();
    const label = `i-${INSTANCE_ID.replaceAll('-', '')}`;

    const response = await app.fetch(
      new Request(
        `https://${label}.kiloclaw.ai/kilo-access-gateway?userId=${USER_ID}&instanceId=${INSTANCE_ID}`,
        { headers: { Cookie: `${KILOCLAW_AUTH_COOKIE}=${token}` } }
      ),
      envBindings({ KILOCLAW_INSTANCE: buildInstanceBinding('other-user') })
    );

    expect(response.status).toBe(403);
  });

  it('ignores mismatched `?instanceId=` on per-instance hosts (no pre-flight 403)', async () => {
    // Regression: `assertInstanceOwnership` on the query-param used to run
    // before the host-based logic, so a stale `?instanceId=` on a
    // per-instance host returned 403 even though `buildRedirectUrl` would
    // have ignored the param anyway. On per-instance hosts the Host header
    // is the authoritative routing signal.
    const app = buildApp();
    const token = await signedAuthCookie();
    const label = `i-${INSTANCE_ID.replaceAll('-', '')}`;
    const staleQueryInstanceId = '11111111-1111-1111-1111-111111111111';

    // Two separate DO stubs: the host-encoded instance is owned by USER_ID,
    // the query-param instance is owned by someone else. Without the fix,
    // the pre-flight check on the latter would 403.
    const hostStub = {
      getStatus: vi.fn().mockResolvedValue({
        userId: USER_ID,
        sandboxId: INSTANCE_SANDBOX_ID,
      }),
    };
    const staleStub = {
      getStatus: vi.fn().mockResolvedValue({
        userId: 'someone-else',
        sandboxId: sandboxIdFromInstanceId(staleQueryInstanceId),
      }),
    };
    const instanceBinding = {
      idFromName: vi.fn((id: string) => `do-id:${id}`),
      get: vi.fn((doId: string) => {
        if (doId === `do-id:${INSTANCE_ID}`) return hostStub;
        if (doId === `do-id:${staleQueryInstanceId}`) return staleStub;
        throw new Error(`unexpected DO lookup: ${doId}`);
      }),
    };

    const response = await app.fetch(
      new Request(
        `https://${label}.kiloclaw.ai/kilo-access-gateway?userId=${USER_ID}&instanceId=${staleQueryInstanceId}`,
        { headers: { Cookie: `${KILOCLAW_AUTH_COOKIE}=${token}` } }
      ),
      envBindings({ KILOCLAW_INSTANCE: instanceBinding })
    );

    expect(response.status).toBe(302);
    const actualToken = extractTokenFromRedirect(response);
    expect(actualToken).toBe(await deriveGatewayToken(INSTANCE_SANDBOX_ID, GATEWAY_TOKEN_SECRET));
    // Stale-query-param DO should never have been consulted.
    expect(staleStub.getStatus).not.toHaveBeenCalled();
  });

  it('rejects legacy host that decodes to a different userId', async () => {
    const app = buildApp();
    const token = await signedAuthCookie();
    // Legacy label for user-2 — authenticated user is user-1.
    const otherLegacySandboxId = sandboxIdFromUserId('user-2');
    const { hostnameLabelFromSandboxId } = await import('../auth/hostname-label');
    const label = hostnameLabelFromSandboxId(otherLegacySandboxId);
    if (!label) throw new Error('Expected legacy label for user-2');

    const response = await app.fetch(
      new Request(`https://${label}.kiloclaw.ai/kilo-access-gateway?userId=${USER_ID}`, {
        headers: { Cookie: `${KILOCLAW_AUTH_COOKIE}=${token}` },
      }),
      envBindings()
    );

    expect(response.status).toBe(403);
  });
});
