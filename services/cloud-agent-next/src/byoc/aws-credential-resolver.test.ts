import { generateKeyPairSync } from 'node:crypto';
import { encryptKeyedEnvelope, parseKeyedEnvelope } from '@kilocode/encryption';
import { AWS_BYOC_ENVELOPE_KEY_ID } from '@kilocode/worker-utils/aws-byoc';
import { AWS_ECS_BYOC_ENVELOPE_SCHEME } from '@kilocode/worker-utils/aws-ecs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import { ECS_TEST_CONFIG } from '../../test/fixtures/aws-ecs.js';
import {
  fetchAwsByocConnection,
  resolveAwsEcsByocConfiguration,
} from './aws-credential-resolver.js';
import { byocOwnerKey, type ByocSource } from './owner.js';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const source = { userId: 'oauth/user-one', credentialId: '22222222-2222-4222-8222-222222222222' };
const organization = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  credentialId: source.credentialId,
};
const env = {
  KILOCODE_BACKEND_BASE_URL: 'https://backend.example.test/',
  AGENT_ENV_VARS_PRIVATE_KEY: keys.privateKey,
  INTERNAL_API_SECRET_PROD: { get: async () => 'internal-secret' },
} as Env;

function envelope(
  owner: ByocSource = source,
  config: unknown = ECS_TEST_CONFIG,
  scheme = AWS_ECS_BYOC_ENVELOPE_SCHEME,
  purpose = 'byoc-aws-ecs-configuration'
) {
  return parseKeyedEnvelope(
    encryptKeyedEnvelope(
      JSON.stringify(config),
      scheme,
      { keyId: AWS_BYOC_ENVELOPE_KEY_ID, publicKeyPem: keys.publicKey },
      `${purpose}:v1:${byocOwnerKey(owner)}:${owner.credentialId}`
    ),
    scheme
  );
}
function connection(overrides: Record<string, unknown> = {}, owner: ByocSource = source) {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      ...owner,
      setupStatus: 'ready',
      credentialsEncrypted: envelope(owner),
      ...overrides,
    })
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => vi.unstubAllGlobals());

describe('AWS BYOC connection authority', () => {
  it.each([source, organization])('decrypts only the selected owner: %j', async owner => {
    const fetcher = connection({}, owner);
    await expect(resolveAwsEcsByocConfiguration(env, owner)).resolves.toEqual(ECS_TEST_CONFIG);
    const [url, init] = fetcher.mock.calls[0];
    if (typeof url !== 'string') throw new Error('Expected a URL string');
    const query = new URL(url).searchParams;
    expect(query.get('provider')).toBe('aws-ecs');
    expect(query.get('credentialId')).toBe(owner.credentialId);
    expect(query.get('userId')).toBe('userId' in owner ? owner.userId : null);
    expect(query.get('organizationId')).toBe(
      'organizationId' in owner ? owner.organizationId : null
    );
    expect(init?.redirect).toBe('manual');
  });
  it.each([
    { userId: 'oauth/other' },
    { credentialId: '33333333-3333-4333-8333-333333333333' },
    { organizationId: organization.organizationId },
  ])('rejects a response from another authority: %j', async override => {
    connection(override);
    await expect(fetchAwsByocConnection(env, source, source.credentialId)).rejects.toThrow(
      'byoc_aws_not_ready'
    );
  });
  it.each([
    { ...source, userId: 'oauth/other' },
    { ...source, credentialId: '33333333-3333-4333-8333-333333333333' },
  ])('rejects ciphertext copied from another owner or credential: %j', async other => {
    connection({ credentialsEncrypted: envelope(other) });
    await expect(resolveAwsEcsByocConfiguration(env, source)).rejects.toThrow('byoc_aws_not_ready');
  });
  it('rejects a foreign envelope scheme and purpose even when the plaintext is valid', async () => {
    connection({
      credentialsEncrypted: envelope(
        source,
        ECS_TEST_CONFIG,
        'byoc-aws-configuration-rsa-aes-256-gcm',
        'byoc-aws-configuration'
      ),
    });
    await expect(resolveAwsEcsByocConfiguration(env, source)).rejects.toThrow('byoc_aws_not_ready');
  });
  it('rejects mixed AWS accounts in decrypted configuration', async () => {
    connection({
      credentialsEncrypted: envelope(source, {
        ...ECS_TEST_CONFIG,
        clusterArn: ECS_TEST_CONFIG.clusterArn.replace(/:\d{12}:/, ':999999999999:'),
      }),
    });
    await expect(resolveAwsEcsByocConfiguration(env, source)).rejects.toThrow('byoc_aws_not_ready');
  });
  it('reports an outdated template separately from malformed configuration', async () => {
    connection({
      credentialsEncrypted: envelope(source, { ...ECS_TEST_CONFIG, templateVersion: 0 }),
    });
    await expect(resolveAwsEcsByocConfiguration(env, source)).rejects.toThrow(
      'byoc_aws_stack_outdated'
    );
  });
  it('rejects an unready connection and a missing decryption key', async () => {
    connection({ setupStatus: 'building' });
    await expect(resolveAwsEcsByocConfiguration(env, source)).rejects.toThrow('byoc_aws_not_ready');
    connection();
    await expect(
      resolveAwsEcsByocConfiguration({ ...env, AGENT_ENV_VARS_PRIVATE_KEY: undefined }, source)
    ).rejects.toThrow('byoc_aws_not_ready');
  });
  it('reports a missing connection without another lookup', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(resolveAwsEcsByocConfiguration(env, source)).rejects.toThrow(
      'byoc_credential_missing'
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
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
});
