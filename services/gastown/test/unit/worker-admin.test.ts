import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { workerAdminBindingDigest } from '@kilocode/worker-utils/worker-admin-capability';
import type { GastownEnv } from '../../src/gastown.worker';
import { resolveWorkerAdminMiddleware } from '../../src/middleware/worker-admin.middleware';

async function jwks(): Promise<{ publicKeys: string; privateKey: CryptoKey }> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'kid-1', alg: 'ES256', use: 'sig' };
  return { publicKeys: JSON.stringify({ keys: [jwk] }), privateKey };
}

function appForProbe() {
  const app = new Hono<GastownEnv>();
  app.use('/api/*', async (c, next) => {
    const claimsHeader = c.req.header('X-Test-Claims');
    const claims = claimsHeader
      ? JSON.parse(Buffer.from(claimsHeader, 'base64url').toString('utf8'))
      : {};
    c.set('kiloTokenClaims', claims);
    c.set('kiloUserId', 'user-1');
    c.set('kiloApiTokenPepper', 'pepper-1');
    c.set('kiloIsAdmin', claims.isAdmin === true);
    return next();
  });
  app.use('/api/*', resolveWorkerAdminMiddleware);
  app.get('/api/probe', c =>
    c.json({
      isAdmin: c.get('kiloIsAdmin'),
      hasCapability: c.get('workerAdmin')?.hasCapability ?? false,
    })
  );
  return app;
}

function env(publicKeys = ''): Env {
  return {
    ENVIRONMENT: 'test',
    LEGACY_ADMIN_CLAIM_MODE: 'honor',
    WORKER_ADMIN_CAPABILITY_PUBLIC_KEYS: publicKeys,
  } as unknown as Env;
}

function tokenFor(claims: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(claims)).toString('base64url');
}

describe('resolveWorkerAdminMiddleware', () => {
  it('honors a one-hour legacy admin claim', async () => {
    const response = await appForProbe().request(
      'http://localhost/api/probe',
      {
        headers: {
          'X-Test-Claims': tokenFor({ isAdmin: true, iat: 1_800_000_000, exp: 1_800_003_600 }),
        },
      },
      env()
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ isAdmin: true, hasCapability: false });
  });

  it('drops a dateless or over-long legacy admin claim in honor mode', async () => {
    for (const claims of [
      { isAdmin: true, iat: 1_800_000_000 },
      { isAdmin: true, iat: 1_800_000_000, exp: 1_800_003_601 },
    ]) {
      const response = await appForProbe().request(
        'http://localhost/api/probe',
        { headers: { 'X-Test-Claims': tokenFor(claims) } },
        env()
      );
      await expect(response.json()).resolves.toEqual({ isAdmin: false, hasCapability: false });
    }
  });

  it('rejects an invalid capability header instead of ignoring it', async () => {
    const response = await appForProbe().request(
      'http://localhost/api/probe',
      {
        headers: {
          'X-Test-Claims': tokenFor({ isAdmin: true, iat: 1_800_000_000, exp: 1_800_003_600 }),
          'X-Kilo-Worker-Capability': 'not-a-jwt',
        },
      },
      env((await jwks()).publicKeys)
    );
    expect(response.status).toBe(401);
  });

  it('accepts an ES256 capability signed by a published kid', async () => {
    const material = await jwks();
    const now = Math.floor(Date.now() / 1000);
    const capability = await new SignJWT({
      iss: 'kilo-web',
      sub: 'user-1',
      aud: 'gastown-admin',
      env: 'test',
      iat: now,
      nbf: now,
      exp: now + 300,
      jti: 'jti-1',
      cap: {
        v: 1,
        actions: ['trpc:gastown.getTown'],
        targets: [{ kind: 'town', id: 'town-1' }],
      },
      bnd: {
        pep: await workerAdminBindingDigest('pepper-1'),
        wsp: await workerAdminBindingDigest(''),
      },
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'kilo-worker-cap+jwt', kid: 'kid-1' })
      .sign(material.privateKey);

    const response = await appForProbe().request(
      'http://localhost/api/probe',
      {
        headers: {
          'X-Test-Claims': tokenFor({
            isAdmin: false,
            env: 'test',
            iat: 1_800_000_000,
            exp: 1_800_003_600,
          }),
          'X-Kilo-Worker-Capability': capability,
        },
      },
      env(material.publicKeys)
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ isAdmin: false, hasCapability: true });
  });
});
