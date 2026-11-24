import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { encryptKeyedEnvelope, parseKeyedEnvelope } from '@kilocode/encryption';
import { AWS_BYOC_ENVELOPE_KEY_ID } from '@kilocode/worker-utils/aws-byoc';
import {
  awsEcsConfigurationEnvelope,
  awsEcsSetupEnvelope,
} from '@kilocode/worker-utils/aws-onboarding';
import { ECS_TEST_CONFIG } from '../../test/fixtures/aws-ecs.js';
import {
  awsSetupEnrollment,
  createAwsSetupIntent,
  readAwsSetupIntent,
  readReadyAwsConfiguration,
  type AwsSetupEnvironment,
} from './aws-setup-intent.js';
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const hash = 'a'.repeat(64);
function fixture() {
  const binding = {
    owner: { userId: 'oauth/provider/user' },
    credentialId: '11111111-1111-4111-8111-111111111111',
    generation: '22222222-2222-4222-8222-222222222222',
  };
  const env: AwsSetupEnvironment = {
    BYOC_AWS_IDS: binding.owner.userId,
    AWS_BYOC_CREDENTIALS: '{}',
    AWS_BYOC_KILO_ROLE_ARN: 'arn:aws:iam::123456789012:role/kilo',
    WORKER_URL: 'https://worker.example.com',
    AGENT_ENV_VARS_PRIVATE_KEY: keys.privateKey,
    AWS_ECS_BYOC_RELEASE: JSON.stringify({
      format: 1,
      provider: 'aws-ecs',
      templateVersion: 1,
      proxyProtocolVersion: 1,
      template: { bucket: 'kilo-releases', key: `aws/${hash}/template.json`, sha256: hash },
      runtime: {
        imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/runtime@sha256:${hash}`,
        repositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/runtime',
      },
      proxy: {
        imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/proxy@sha256:${hash}`,
        repositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/proxy',
      },
      customerAccounts: ['999999999999'],
    }),
  };
  const seal = (value: unknown, purpose: { scheme: string; aad: string }) =>
    parseKeyedEnvelope(
      encryptKeyedEnvelope(
        JSON.stringify(value),
        purpose.scheme,
        { keyId: AWS_BYOC_ENVELOPE_KEY_ID, publicKeyPem: keys.publicKey },
        purpose.aad
      ),
      purpose.scheme
    );
  const draftPurpose = awsEcsSetupEnvelope(binding);
  const readyPurpose = awsEcsConfigurationEnvelope(binding.owner, binding.credentialId);
  return { env, binding, seal, draftPurpose, readyPurpose };
}
describe('owner-bound AWS setup intent', () => {
  it('creates a unique ExternalId and reads the persisted encrypted intent without changing pins', () => {
    const f = fixture();
    const intent = createAwsSetupIntent(f.env, f.binding, '999999999999');
    expect(intent.provider).toBe('aws-ecs');
    expect(intent.externalId).toMatch(/^[a-f0-9]{64}$/);
    expect(intent.stackName).toBe('kilo-' + f.binding.credentialId.replaceAll('-', ''));
    const other = createAwsSetupIntent(
      f.env,
      { ...f.binding, credentialId: '33333333-3333-4333-8333-333333333333' },
      '999999999999'
    );
    expect(other.externalId).not.toBe(intent.externalId);
    const encrypted = f.seal(intent, f.draftPurpose);
    expect(readAwsSetupIntent(f.env, f.binding, encrypted)).toEqual(intent);
    const changedRelease = JSON.parse(f.env.AWS_ECS_BYOC_RELEASE ?? '{}');
    changedRelease.customerAccounts.push('888888888888');
    expect(
      readAwsSetupIntent(
        { ...f.env, AWS_ECS_BYOC_RELEASE: JSON.stringify(changedRelease) },
        f.binding,
        encrypted
      )
    ).toEqual(intent);
  });
  it('rejects owner and generation substitution using real authenticated encryption', () => {
    const f = fixture();
    const intent = createAwsSetupIntent(f.env, f.binding, '999999999999');
    const encrypted = f.seal(intent, f.draftPurpose);
    expect(() =>
      readAwsSetupIntent(f.env, { ...f.binding, owner: { userId: 'other-user' } }, encrypted)
    ).toThrow('setup changed');
    expect(() =>
      readAwsSetupIntent(
        f.env,
        { ...f.binding, generation: '33333333-3333-4333-8333-333333333333' },
        encrypted
      )
    ).toThrow('setup changed');
    expect(() =>
      readAwsSetupIntent(
        { ...f.env, AWS_BYOC_KILO_ROLE_ARN: 'arn:aws:iam::123456789012:role/other' },
        f.binding,
        encrypted
      )
    ).toThrow('setup changed');
  });
  it('keeps draft credentials separate from runtime configuration authority', () => {
    const f = fixture();
    const intent = createAwsSetupIntent(f.env, f.binding, '999999999999');
    const draft = f.seal(intent, f.draftPurpose);
    expect(() => readReadyAwsConfiguration(f.env, f.binding, draft)).toThrow(
      'setup is unavailable'
    );
    const ready = f.seal(ECS_TEST_CONFIG, f.readyPurpose);
    expect(readReadyAwsConfiguration(f.env, f.binding, ready)).toEqual(ECS_TEST_CONFIG);
    expect(() => readAwsSetupIntent(f.env, f.binding, ready)).toThrow('setup changed');
    // Even an envelope sealed with the draft purpose must contain an intent.
    const substituted = f.seal(ECS_TEST_CONFIG, f.draftPurpose);
    expect(() => readAwsSetupIntent(f.env, f.binding, substituted)).toThrow('setup changed');
  });
  it('rejects drafts from a retired envelope scheme', () => {
    const f = fixture();
    const intent = createAwsSetupIntent(f.env, f.binding, '999999999999');
    const retired = f.seal(intent, {
      scheme: 'byoc-aws-setup-rsa-aes-256-gcm',
      aad: f.draftPurpose.aad,
    });
    expect(() => readAwsSetupIntent(f.env, f.binding, retired)).toThrow('setup changed');
  });
  it('refuses unavailable setup and customer accounts that lack release authorization', () => {
    const f = fixture();
    expect(awsSetupEnrollment(f.env, f.binding.owner)).toEqual({ enrolled: true, available: true });
    expect(
      awsSetupEnrollment({ ...f.env, AWS_ECS_BYOC_RELEASE: '' }, f.binding.owner).available
    ).toBe(false);
    expect(() =>
      createAwsSetupIntent({ ...f.env, AWS_ECS_BYOC_RELEASE: undefined }, f.binding, '999999999999')
    ).toThrow('setup is unavailable');
    expect(() =>
      createAwsSetupIntent({ ...f.env, BYOC_AWS_IDS: '' }, f.binding, '999999999999')
    ).toThrow('setup is unavailable');
    expect(() => createAwsSetupIntent(f.env, f.binding, '888888888888')).toThrow('not enabled');
  });
});
