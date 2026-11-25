import { createExecutionContext } from 'cloudflare:test';
import {
  SignerKeysResultSchema,
  signerOfTokenKid,
  UTS_ENDPOINTS,
  UTS_SIGNER_COUNT,
  UTS_SIGNER_KEYS_PATH,
} from '@kilocode/uts-contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleRequest } from '../../src/http';
import { signerKeysResponse } from '../../src/signer-keys';
import { fetchSignerKeys, keySet, resetAllSigners } from './support';
import { config, env } from './test-env';

beforeAll(async () => {
  await resetAllSigners();
});

const signerKeysUrl = `${config.endpoints.issuer}${UTS_SIGNER_KEYS_PATH}`;

describe('internal signer-keys route', () => {
  it('answers the feed caller with every signer exactly once', async () => {
    const response = await fetchSignerKeys();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const result = SignerKeysResultSchema.parse(await response.json());
    if (result.status !== 'ok') throw new Error(`answered ${result.status}`);
    expect(result.signers.map(entry => entry.signer)).toEqual(
      Array.from({ length: UTS_SIGNER_COUNT }, (_, index) => index)
    );
  });

  it('builds a key set of 32 keys: the current and next key of all 16 signers', async () => {
    const { keys } = await keySet();
    expect(keys).toHaveLength(32);
    const perSigner = new Map<number | null, number>();
    for (const key of keys) {
      const signer = signerOfTokenKid(key.kid);
      perSigner.set(signer, (perSigner.get(signer) ?? 0) + 1);
    }
    expect([...perSigner.values()]).toEqual(Array.from({ length: UTS_SIGNER_COUNT }, () => 2));
  });

  it('answers another caller, a binding without props and an internet request as an unknown path', async () => {
    for (const response of [
      await fetchSignerKeys(env.OTHER_MINT),
      await fetchSignerKeys(env.PROPLESS_MINT),
      await handleRequest(new Request(signerKeysUrl), env, createExecutionContext()),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    }
  });

  it('answers 405 to the feed caller for another method', async () => {
    const response = await env.FEED_MINT.fetch(signerKeysUrl, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
  });

  it('answers 500 misconfigured when signer objects refuse to load under the names it reads', async () => {
    // Staging names in a development Worker: every object refuses, as after a wrong deploy.
    const staging = {
      ...config,
      environment: 'staging' as const,
      endpoints: UTS_ENDPOINTS.staging,
    };
    const response = await signerKeysResponse(new Request(signerKeysUrl), env, staging, {
      caller: 'uts-feed-staging',
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: 'misconfigured' });
  });
});
