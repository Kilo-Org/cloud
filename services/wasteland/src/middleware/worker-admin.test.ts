import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerAdminBindingDigest } from '@kilocode/worker-utils/worker-admin-capability';
import type { WastelandEnv } from '../wasteland.worker';
import { resolveWorkerAdminMiddleware } from './worker-admin.middleware';

const NOW = Math.floor(Date.now() / 1000);

async function keyMaterial() {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'kid-1', alg: 'ES256', use: 'sig' };
  return { publicKeys: JSON.stringify({ keys: [jwk] }), privateKey };
}

async function capability(
  privateKey: CryptoKey,
  overrides: { actions?: string[]; targets?: unknown[]; jti?: string } = {}
) {
  return new SignJWT({
    iss: 'kilo-web',
    sub: 'user-1',
    aud: 'wasteland-admin',
    env: 'test',
    iat: NOW,
    nbf: NOW,
    exp: NOW + 300,
    jti: overrides.jti ?? 'jti-1',
    cap: {
      v: 1,
      actions: overrides.actions ?? ['trpc:wasteland.getWasteland'],
      targets: overrides.targets ?? [{ kind: 'wasteland', id: 'wasteland-a' }],
    },
    bnd: {
      pep: await workerAdminBindingDigest('pepper-1'),
      wsp: await workerAdminBindingDigest(''),
    },
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'kilo-worker-cap+jwt', kid: 'kid-1' })
    .sign(privateKey);
}

function app() {
  const app = new Hono<WastelandEnv>();
  app.use('/trpc/*', async (c, next) => {
    const raw = c.req.header('X-Test-Claims');
    const claims = raw ? JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) : {};
    c.set('kiloTokenClaims', claims);
    c.set('kiloUserId', 'user-1');
    c.set('kiloApiTokenPepper', 'pepper-1');
    c.set('kiloIsAdmin', claims.isAdmin === true);
    return next();
  });
  app.use('/trpc/*', resolveWorkerAdminMiddleware);
  app.all('/trpc/getWasteland', async c => {
    const decision = await c
      .get('workerAdmin')
      .decide('trpc:wasteland.getWasteland', { kind: 'wasteland', id: c.req.query('id') ?? '' });
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
  introspect?: () => Promise<Response>;
}): Env {
  vi.stubGlobal(
    'fetch',
    params.introspect ?? (async () => new Response(JSON.stringify({ active: true })))
  );
  return {
    ENVIRONMENT: 'test',
    LEGACY_ADMIN_CLAIM_MODE: params.mode ?? 'honor',
    WORKER_ADMIN_CAPABILITY_PUBLIC_KEYS: params.publicKeys ?? '',
    KILO_INTERNAL_API_URL: 'https://web.test',
    INTERNAL_API_SECRET: { get: async () => 'internal-secret' },
  } as unknown as Env;
}

function claims(extra: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({ isAdmin: true, env: 'test', iat: NOW, exp: NOW + 3600, ...extra })
  ).toString('base64url');
}

function request(id: string, headers: Record<string, string>, e: Env) {
  return app().request(`http://localhost/trpc/getWasteland?id=${id}`, { headers }, e);
}

afterEach(() => vi.unstubAllGlobals());

describe('Wasteland worker admin authority', () => {
  it.each([
    ['honor', 200],
    ['observe', 200],
    ['reject', 403],
  ] as const)('%s mode returns %s for a legacy admin token', async (mode, status) => {
    expect(
      (await request('wasteland-a', { 'X-Test-Claims': claims() }, env({ mode }))).status
    ).toBe(status);
  });

  it('hardens an over-long legacy claim in honor mode', async () => {
    expect(
      (
        await request(
          'wasteland-a',
          { 'X-Test-Claims': claims({ exp: NOW + 3601 }) },
          env({ mode: 'honor' })
        )
      ).status
    ).toBe(401);
  });

  it('allows a capability only for its own wasteland', async () => {
    const material = await keyMaterial();
    const token = await capability(material.privateKey);
    const e = env({ mode: 'reject', publicKeys: material.publicKeys });
    const headers = {
      'X-Test-Claims': claims({ isAdmin: false }),
      'X-Kilo-Worker-Capability': token,
    };

    expect((await request('wasteland-a', headers, e)).status).toBe(200);
    expect((await request('wasteland-b', headers, e)).status).toBe(403);
  });

  it('denies when introspection says inactive', async () => {
    const material = await keyMaterial();
    const token = await capability(material.privateKey, { jti: 'jti-inactive' });
    const response = await request(
      'wasteland-a',
      { 'X-Test-Claims': claims({ isAdmin: false }), 'X-Kilo-Worker-Capability': token },
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
    const token = await capability(material.privateKey, { jti: 'jti-unreachable' });
    const response = await request(
      'wasteland-a',
      { 'X-Test-Claims': claims({ isAdmin: false }), 'X-Kilo-Worker-Capability': token },
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

  it('rejects an invalid capability header', async () => {
    const material = await keyMaterial();
    const response = await request(
      'wasteland-a',
      { 'X-Test-Claims': claims(), 'X-Kilo-Worker-Capability': 'not-a-jwt' },
      env({ mode: 'honor', publicKeys: material.publicKeys })
    );
    expect(response.status).toBe(401);
  });
});
