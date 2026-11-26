import { createExecutionContext } from 'cloudflare:test';
import { AuthorizationServerMetadataSchema, UTS_ENDPOINTS } from '@kilocode/uts-contracts';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { handleDevRequest } from '../../src/dev';
import type { Env } from '../../src/env';
import { handleRequest } from '../../src/http';
import { claims, keySet } from './support';
import { config, env } from './test-env';

const METADATA_PATH = '/.well-known/oauth-authorization-server';

function request(path: string, init?: RequestInit): Request {
  return new Request(`${config.endpoints.issuer}${path}`, init);
}

/** An internet request to the default entrypoint's fetch handler. */
const fetchMint = (input: Request, target: Env = env) =>
  handleRequest(input, target, createExecutionContext());

/** The same Worker as configured for production; only plain vars differ, and no store is bound. */
const productionEnv: Env = {
  ...env,
  UTS_ENVIRONMENT: 'production',
  DO_JURISDICTION: 'eu',
  IDENTITY_STORE: undefined,
};

/** The test config binds an identity store; these tests describe the Worker without one. */
const unprovisionedEnv: Env = { ...env, IDENTITY_STORE: undefined };

describe('authorization-server metadata', () => {
  it('names the issuer and the key set on the feed Worker, and no flow that does not answer', async () => {
    const response = await fetchMint(request(METADATA_PATH), unprovisionedEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    const metadata = AuthorizationServerMetadataSchema.parse(await response.json());
    expect(metadata).toEqual({
      issuer: 'http://localhost:8800',
      jwks_uri: 'http://localhost:8801/.well-known/jwks.json',
      response_types_supported: [],
      grant_types_supported: [],
    });
  });

  it('serves the production issuer and key set URL in production', async () => {
    const response = await fetchMint(request(METADATA_PATH), productionEnv);
    expect(await response.json()).toMatchObject({
      issuer: UTS_ENDPOINTS.production.issuer,
      jwks_uri: 'https://uts-feed.kiloapps.io/.well-known/jwks.json',
    });
  });

  it('answers 405 to other methods and 404 to other paths', async () => {
    const post = await fetchMint(request(METADATA_PATH, { method: 'POST' }));
    expect(post.status).toBe(405);
    expect(post.headers.get('Allow')).toBe('GET');
    expect((await fetchMint(request('/'))).status).toBe(404);
  });

  it('refuses a configuration that leaves production objects unscoped', async () => {
    await expect(
      fetchMint(request(METADATA_PATH), { ...env, UTS_ENVIRONMENT: 'production' })
    ).rejects.toThrow(/eu jurisdiction/);
  });
});

describe('development signing route', () => {
  const signRequest = (body: unknown) =>
    request('/__dev/sign', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  const sign = (body: unknown, target: Env = env) =>
    handleDevRequest(signRequest(body), target, createExecutionContext());

  it('signs with the signer the grant hash picks; the token verifies against the key set', async () => {
    const response = await sign({ grantId: 'grant-e2e', claims: claims({ sid: 'grant-e2e' }) });
    expect(response.status).toBe(200);
    const body = z.object({ token: z.string() }).parse(await response.json());
    const { payload, protectedHeader } = await jwtVerify(
      body.token,
      createLocalJWKSet(await keySet()),
      {
        issuer: config.endpoints.issuer,
        audience: 'gateway',
        typ: 'at+jwt',
        algorithms: ['EdDSA'],
      }
    );
    expect(payload.sid).toBe('grant-e2e');
    expect(protectedHeader.kid).toMatch(/^uts-token-\d{2}-/);
  });

  it('answers 400 with the refusal for a claim set the signer refuses', async () => {
    const response = await sign({ grantId: 'grant-e2e', claims: claims({ env: 'staging' }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'environment_mismatch' });
    expect((await sign({ claims: claims() })).status).toBe(400);
  });

  it('does not exist outside development or in the deployed entry', async () => {
    const body = { grantId: 'grant-e2e', claims: claims() };
    expect((await sign(body, productionEnv)).status).toBe(404);
    expect((await fetchMint(signRequest(body))).status).toBe(404);
  });

  it('serves the deployed routes through the development entry', async () => {
    const response = await handleDevRequest(request(METADATA_PATH), env, createExecutionContext());
    expect(response.status).toBe(200);
  });
});
