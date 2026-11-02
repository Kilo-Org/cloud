import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  matchWorkerAdminRestAction,
  workerAdminBindingDigest,
  type WorkerAdminTarget,
} from '@kilocode/worker-utils/worker-admin-capability';
import type { GastownEnv } from '../../src/gastown.worker';
import { resolveWorkerAdminMiddleware } from '../../src/middleware/worker-admin.middleware';

const NOW = Math.floor(Date.now() / 1000);

type KeyMaterial = { publicKeys: string; privateKey: CryptoKey; kid: string };

async function keyMaterial(kid = 'kid-1'): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  return { publicKeys: JSON.stringify({ keys: [jwk] }), privateKey, kid };
}

async function capability(
  material: KeyMaterial,
  overrides: {
    actions?: string[];
    targets?: WorkerAdminTarget[];
    aud?: string;
    jti?: string;
  } = {}
): Promise<string> {
  return new SignJWT({
    iss: 'kilo-web',
    sub: 'user-1',
    aud: overrides.aud ?? 'gastown-admin',
    env: 'test',
    iat: NOW,
    nbf: NOW,
    exp: NOW + 300,
    jti: overrides.jti ?? 'jti-1',
    cap: {
      v: 1,
      actions: overrides.actions ?? ['trpc:gastown.getTown', 'rest:GET /api/towns/:townId/config'],
      targets: overrides.targets ?? [{ kind: 'town', id: 'town-a' }],
    },
    bnd: {
      pep: await workerAdminBindingDigest('pepper-1'),
      wsp: await workerAdminBindingDigest(''),
    },
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'kilo-worker-cap+jwt', kid: material.kid })
    .sign(material.privateKey);
}

function app() {
  const app = new Hono<GastownEnv>();
  app.use('/api/*', async (c, next) => {
    const claimsHeader = c.req.header('X-Test-Claims');
    const claims = claimsHeader
      ? JSON.parse(Buffer.from(claimsHeader, 'base64url').toString('utf8'))
      : {};
    const admin = claims.isAdmin === true;
    c.set('kiloTokenClaims', claims);
    c.set('kiloUserId', 'user-1');
    c.set('kiloApiTokenPepper', 'pepper-1');
    c.set('kiloIsAdmin', admin);
    c.set('kiloGastownAccess', true);
    return next();
  });
  app.use('/api/*', resolveWorkerAdminMiddleware);
  app.all('/api/towns/:townId/config', async c => {
    const action =
      matchWorkerAdminRestAction('gastown-admin', c.req.method, c.req.path) ??
      `rest:${c.req.method} ${c.req.path}`;
    const decision = await c.get('workerAdmin').decide(action, {
      kind: 'town',
      id: c.req.param('townId'),
    });
    return c.json(
      { allowed: decision.allowed, reason: decision.allowed ? null : decision.reason },
      decision.allowed ? 200 : decision.status
    );
  });
  return app;
}

function env(params: {
  mode?: 'honor' | 'observe' | 'reject';
  publicKeys?: string;
  introspect?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): Env {
  const fetchImpl =
    params.introspect ?? (async () => new Response(JSON.stringify({ active: true })));
  vi.stubGlobal('fetch', fetchImpl);
  return {
    ENVIRONMENT: 'test',
    LEGACY_ADMIN_CLAIM_MODE: params.mode ?? 'honor',
    WORKER_ADMIN_CAPABILITY_PUBLIC_KEYS: params.publicKeys ?? '',
    KILO_INTERNAL_API_URL: 'https://web.test',
    INTERNAL_API_SECRET: { get: async () => 'internal-secret' },
  } as unknown as Env;
}

function legacyClaims(extra: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({ isAdmin: true, env: 'test', iat: NOW, exp: NOW + 3600, ...extra })
  ).toString('base64url');
}

function get(path: string, headers: Record<string, string>, e: Env) {
  return app().request(`http://localhost${path}`, { headers }, e);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('worker admin mode matrix (legacy claim)', () => {
  it.each([
    ['honor', 200],
    ['observe', 200],
    ['reject', 403],
  ] as const)('%s mode returns %s for a legacy admin token', async (mode, status) => {
    const response = await get(
      '/api/towns/town-1/config',
      { 'X-Test-Claims': legacyClaims() },
      env({ mode })
    );
    expect(response.status).toBe(status);
  });

  it('hardens a dateless legacy claim even in honor mode', async () => {
    const response = await get(
      '/api/towns/town-1/config',
      { 'X-Test-Claims': legacyClaims({ exp: undefined }) },
      env({ mode: 'honor' })
    );
    expect(response.status).toBe(401);
  });

  it('hardens an over-long legacy claim even in honor mode', async () => {
    const response = await get(
      '/api/towns/town-1/config',
      { 'X-Test-Claims': legacyClaims({ exp: NOW + 3601 }) },
      env({ mode: 'honor' })
    );
    expect(response.status).toBe(401);
  });

  it('leaves an ordinary non-admin caller forbidden', async () => {
    const response = await get(
      '/api/towns/town-1/config',
      { 'X-Test-Claims': Buffer.from(JSON.stringify({ env: 'test' })).toString('base64url') },
      env({ mode: 'honor' })
    );
    expect(response.status).toBe(403);
  });
});

describe('worker admin capability scope', () => {
  it('allows a capability only for its own town', async () => {
    const material = await keyMaterial();
    const token = await capability(material);
    const e = env({ mode: 'reject', publicKeys: material.publicKeys });

    expect(
      (
        await get(
          '/api/towns/town-a/config',
          { 'X-Test-Claims': legacyClaims({ isAdmin: false }), 'X-Kilo-Worker-Capability': token },
          e
        )
      ).status
    ).toBe(200);

    expect(
      (
        await get(
          '/api/towns/town-b/config',
          { 'X-Test-Claims': legacyClaims({ isAdmin: false }), 'X-Kilo-Worker-Capability': token },
          e
        )
      ).status
    ).toBe(403);
  });

  it('refuses an action that is not on the allowlist', async () => {
    const material = await keyMaterial();
    const token = await capability(material, {
      actions: ['trpc:gastown.getTown'],
      targets: [{ kind: 'town', id: 'town-a' }],
    });
    const response = await get(
      '/api/towns/town-a/config',
      { 'X-Test-Claims': legacyClaims({ isAdmin: false }), 'X-Kilo-Worker-Capability': token },
      env({ mode: 'reject', publicKeys: material.publicKeys })
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ reason: 'action_not_allowed' });
  });

  it('denies when introspection says inactive', async () => {
    const material = await keyMaterial();
    const token = await capability(material, { jti: 'jti-inactive' });
    const response = await get(
      '/api/towns/town-a/config',
      { 'X-Test-Claims': legacyClaims({ isAdmin: false }), 'X-Kilo-Worker-Capability': token },
      env({
        mode: 'reject',
        publicKeys: material.publicKeys,
        introspect: async () => new Response(JSON.stringify({ active: false, reason: 'blocked' })),
      })
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ reason: 'blocked' });
  });

  it('fails closed with 503 when introspection is unreachable', async () => {
    const material = await keyMaterial();
    const token = await capability(material, { jti: 'jti-unreachable' });
    const response = await get(
      '/api/towns/town-a/config',
      { 'X-Test-Claims': legacyClaims({ isAdmin: false }), 'X-Kilo-Worker-Capability': token },
      env({
        mode: 'reject',
        publicKeys: material.publicKeys,
        introspect: async () => {
          throw new Error('offline');
        },
      })
    );
    expect(response.status).toBe(503);
  });

  it('rejects an invalid capability header instead of ignoring it', async () => {
    const material = await keyMaterial();
    const response = await get(
      '/api/towns/town-a/config',
      { 'X-Test-Claims': legacyClaims(), 'X-Kilo-Worker-Capability': 'not-a-jwt' },
      env({ mode: 'honor', publicKeys: material.publicKeys })
    );
    expect(response.status).toBe(401);
  });

  it('rejects an HS256 token signed with the shared secret', async () => {
    const material = await keyMaterial();
    const token = await new SignJWT({ isAdmin: true })
      .setProtectedHeader({ alg: 'HS256', typ: 'kilo-worker-cap+jwt', kid: 'kid-1' })
      .sign(new TextEncoder().encode('nextauth-secret'));
    const response = await get(
      '/api/towns/town-a/config',
      { 'X-Test-Claims': legacyClaims(), 'X-Kilo-Worker-Capability': token },
      env({ mode: 'honor', publicKeys: material.publicKeys })
    );
    expect(response.status).toBe(401);
  });
});
