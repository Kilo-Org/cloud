import { generateKeyPairSync } from 'node:crypto';
import { encryptKeyedEnvelope, parseKeyedEnvelope } from '@kilocode/encryption';
import {
  AWS_BYOC_ENVELOPE_KEY_ID,
  AWS_BYOC_ENVELOPE_SCHEME,
} from '@kilocode/worker-utils/aws-byoc';
import { AWS_ECS_BYOC_ENVELOPE_SCHEME } from '@kilocode/worker-utils/aws-ecs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import { ECS_TEST_CONFIG } from '../../test/fixtures/aws-ecs.js';
import { resolveAwsEcsByocConfiguration } from './aws-ecs-credential-resolver.js';
import { resolveAwsByocConfiguration } from './aws-credential-resolver.js';
import { byocOwnerKey, type ByocSource } from './owner.js';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const source = { userId: 'oauth/user-one', credentialId: '22222222-2222-4222-8222-222222222222' };
const env = {
  KILOCODE_BACKEND_BASE_URL: 'https://backend.example.test/',
  AGENT_ENV_VARS_PRIVATE_KEY: keys.privateKey,
  INTERNAL_API_SECRET_PROD: { get: async () => 'internal-secret' },
} as Env;
function envelope(
  owner: ByocSource = source,
  config = ECS_TEST_CONFIG,
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
function connection(ciphertext: unknown, owner: ByocSource = source, status = 'ready') {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ ...owner, setupStatus: status, credentialsEncrypted: ciphertext })
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => vi.unstubAllGlobals());
describe('independent ECS connection authority', () => {
  it.each([
    source,
    { organizationId: '11111111-1111-4111-8111-111111111111', credentialId: source.credentialId },
  ])('decrypts only the selected ECS owner', async owner => {
    const fetcher = connection(envelope(owner), owner);
    expect(await resolveAwsEcsByocConfiguration(env, owner)).toEqual(ECS_TEST_CONFIG);
    const url = fetcher.mock.calls[0][0];
    if (typeof url !== 'string') throw new Error('expected URL');
    expect(new URL(url).searchParams.get('provider')).toBe('aws-ecs');
    expect(new URL(url).searchParams.get('credentialId')).toBe(owner.credentialId);
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual');
  });
  it('rejects MicroVM scheme and purpose even when the plaintext has ECS fields', async () => {
    connection(
      envelope(source, ECS_TEST_CONFIG, AWS_BYOC_ENVELOPE_SCHEME, 'byoc-aws-configuration')
    );
    await expect(resolveAwsEcsByocConfiguration(env, source)).rejects.toThrow('byoc_aws_not_ready');
  });
  it('keeps ECS ciphertext unavailable to the MicroVM resolver', async () => {
    connection(envelope());
    await expect(resolveAwsByocConfiguration(env, source)).rejects.toThrow('byoc_aws_not_ready');
  });
  it.each([
    { ...source, userId: 'oauth/other' },
    { ...source, credentialId: '33333333-3333-4333-8333-333333333333' },
  ])('rejects ciphertext copied from another authority', async other => {
    connection(envelope(other));
    await expect(resolveAwsEcsByocConfiguration(env, source)).rejects.toThrow('byoc_aws_not_ready');
  });
  it('does not fall back to a MicroVM connection when the ECS connection is missing', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(resolveAwsEcsByocConfiguration(env, source)).rejects.toThrow(
      'byoc_credential_missing'
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('requires readiness, a decryption key, and the current ECS template', async () => {
    connection(envelope(), source, 'building');
    await expect(resolveAwsEcsByocConfiguration(env, source)).rejects.toThrow('byoc_aws_not_ready');
    connection(envelope());
    await expect(
      resolveAwsEcsByocConfiguration({ ...env, AGENT_ENV_VARS_PRIVATE_KEY: undefined }, source)
    ).rejects.toThrow('byoc_aws_not_ready');
    connection(envelope(source, { ...ECS_TEST_CONFIG, templateVersion: 0 }));
    await expect(resolveAwsEcsByocConfiguration(env, source)).rejects.toThrow(
      'byoc_aws_stack_outdated'
    );
  });
});
