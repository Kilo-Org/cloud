import { generateKeyPairSync } from 'node:crypto';
import type { MintRequest } from '@kilocode/sts-contracts';
import { encryptKeyedEnvelope, parseKeyedEnvelope } from '@kilocode/encryption';
import {
  AWS_BYOC_ENVELOPE_KEY_ID,
  AWS_BYOC_ENVELOPE_SCHEME,
} from '@kilocode/worker-utils/aws-byoc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import { AWS_TEST_CONFIGURATION } from '../../test/fixtures/aws-provider.js';
import { fetchAwsByocConnection, resolveAwsByocConfiguration } from './aws-credential-resolver.js';
import { byocOwnerKey, type ByocSource } from './owner.js';
import { WEB_BYOC_CREDENTIALS_READ } from '../web-internal-auth.js';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const source = { userId: 'user/one', credentialId: '22222222-2222-4222-8222-222222222222' };
const env = {
  KILOCODE_BACKEND_BASE_URL: 'https://backend.example.test/',
  AGENT_ENV_VARS_PRIVATE_KEY: keys.privateKey,
  INTERNAL_API_SECRET_PROD: { get: async () => 'internal-secret' },
} as Env;

function envelope(owner: ByocSource = source, config = AWS_TEST_CONFIGURATION) {
  return parseKeyedEnvelope(
    encryptKeyedEnvelope(
      JSON.stringify(config),
      AWS_BYOC_ENVELOPE_SCHEME,
      { keyId: AWS_BYOC_ENVELOPE_KEY_ID, publicKeyPem: keys.publicKey },
      `byoc-aws-configuration:v1:${byocOwnerKey(owner)}:${owner.credentialId}`
    ),
    AWS_BYOC_ENVELOPE_SCHEME
  );
}
function stubConnection(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ...source,
        setupStatus: 'ready',
        credentialsEncrypted: envelope(),
        ...overrides,
      })
    )
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('AWS BYOC connection authority', () => {
  it('decrypts the exact personal owner and credential envelope', async () => {
    stubConnection();
    await expect(resolveAwsByocConfiguration(env, source)).resolves.toEqual(AWS_TEST_CONFIGURATION);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    if (typeof url !== 'string') throw new Error('Expected a URL string');
    expect(new URL(url).searchParams.get('userId')).toBe(source.userId);
    expect(new URL(url).searchParams.get('credentialId')).toBe(source.credentialId);
    expect(init?.redirect).toBe('manual');
  });
  it('decrypts an organization envelope without a personal owner', async () => {
    const organization = {
      organizationId: '11111111-1111-4111-8111-111111111111',
      credentialId: source.credentialId,
    };
    stubConnection({
      ...organization,
      userId: undefined,
      credentialsEncrypted: envelope(organization),
    });
    await expect(resolveAwsByocConfiguration(env, organization)).resolves.toEqual(
      AWS_TEST_CONFIGURATION
    );
  });
  it.each([
    { userId: 'user/two' },
    { credentialId: '33333333-3333-4333-8333-333333333333' },
    { organizationId: '11111111-1111-4111-8111-111111111111' },
  ])('rejects a response from another authority: %j', async override => {
    stubConnection(override);
    await expect(fetchAwsByocConnection(env, source, source.credentialId)).rejects.toThrow(
      'byoc_aws_not_ready'
    );
  });
  it.each([
    { ...source, userId: 'user/two' },
    { ...source, credentialId: '33333333-3333-4333-8333-333333333333' },
  ])('rejects ciphertext copied from another owner or credential: %j', async other => {
    stubConnection({ credentialsEncrypted: envelope(other) });
    await expect(resolveAwsByocConfiguration(env, source)).rejects.toThrow('byoc_aws_not_ready');
  });
  it('rejects mixed AWS accounts in decrypted configuration', async () => {
    stubConnection({
      credentialsEncrypted: envelope(source, {
        ...AWS_TEST_CONFIGURATION,
        imageIdentifier: 'arn:aws:lambda:us-east-1:999999999999:microvm-image:other',
      }),
    });
    await expect(resolveAwsByocConfiguration(env, source)).rejects.toThrow('byoc_aws_not_ready');
  });
  it('reports an outdated template separately from malformed configuration', async () => {
    stubConnection({
      credentialsEncrypted: envelope(source, { ...AWS_TEST_CONFIGURATION, templateVersion: 0 }),
    });
    await expect(resolveAwsByocConfiguration(env, source)).rejects.toThrow(
      'byoc_aws_stack_outdated'
    );
  });
  it('rejects an unready connection and a missing decryption key', async () => {
    stubConnection({ setupStatus: 'building' });
    await expect(resolveAwsByocConfiguration(env, source)).rejects.toThrow('byoc_aws_not_ready');
    stubConnection();
    await expect(
      resolveAwsByocConfiguration({ ...env, AGENT_ENV_VARS_PRIVATE_KEY: undefined }, source)
    ).rejects.toThrow('byoc_aws_not_ready');
  });
  it('refuses backend redirects without forwarding internal authentication', async () => {
    const transport = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://other.example/' } })
    );
    vi.stubGlobal('fetch', transport);
    await expect(fetchAwsByocConnection(env, source)).rejects.toThrow('byoc_aws_not_ready');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ redirect: 'manual' }));
  });
  describe('under BYOC_LOOKUP_SENDER_AUTH=sts', () => {
    const MINTED = 'minted.byoc.token';
    function mintBinding() {
      return {
        getBundle: vi.fn(),
        mintTokens: vi.fn(async (request: MintRequest) => ({
          status: 'ok' as const,
          tokens: request.tokens.map(({ audience, scope }) => ({
            status: 'issued' as const,
            audience,
            scope,
            token: MINTED,
            jti: 'jti-byoc',
            expiresAt: Math.floor(Date.now() / 1000) + 300,
          })),
        })),
      };
    }

    it('reads the connection with only a BYOC read token', async () => {
      stubConnection();
      const STS = mintBinding();
      const internal = vi.fn(async () => 'internal-secret');
      const stsEnv = {
        ...env,
        KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
        BYOC_LOOKUP_SENDER_AUTH: 'sts',
        INTERNAL_API_SECRET_PROD: { get: internal },
        STS,
      } as Env;

      await expect(resolveAwsByocConfiguration(stsEnv, source)).resolves.toEqual(
        AWS_TEST_CONFIGURATION
      );
      expect(STS.mintTokens).toHaveBeenCalledWith({ tokens: [WEB_BYOC_CREDENTIALS_READ] });
      expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toEqual({
        authorization: `Bearer ${MINTED}`,
      });
      expect(internal).not.toHaveBeenCalled();
    });

    it('never sends a token to a backend outside the web production origins', async () => {
      stubConnection();
      const STS = mintBinding();
      await expect(
        fetchAwsByocConnection({ ...env, BYOC_LOOKUP_SENDER_AUTH: 'sts', STS } as Env, source)
      ).rejects.toThrow('byoc_aws_not_ready');
      expect(STS.mintTokens).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
