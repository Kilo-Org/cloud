import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { accessGatewayRoutes } from './access-gateway';
import { signKiloToken } from '../auth/jwt';
import { KILOCLAW_AUTH_COOKIE, KILOCLAW_ACTIVE_INSTANCE_COOKIE } from '../config';

const NEXTAUTH_SECRET = 'test-nextauth-secret';
const GATEWAY_TOKEN_SECRET = 'test-gateway-secret';
const USER_ID = 'user-1';
const INSTANCE_ID = '550e8400-e29b-41d4-a716-446655440000';

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route('/', accessGatewayRoutes);
  return app;
}

function buildInstanceBinding(ownerUserId: string) {
  const stub = {
    getStatus: vi.fn().mockResolvedValue({
      userId: ownerUserId,
      sandboxId: `ki_${INSTANCE_ID.replaceAll('-', '')}`,
    }),
  };
  return {
    idFromName: vi.fn().mockReturnValue('instance-id'),
    get: vi.fn().mockReturnValue(stub),
  };
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
