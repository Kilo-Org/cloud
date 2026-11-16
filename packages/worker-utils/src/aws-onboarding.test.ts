import { describe, expect, it } from 'vitest';
import { awsByocReleaseSchema, awsSetupIntentSchema, awsSetupEnvelopeAad } from './aws-onboarding';
const hash = 'a'.repeat(64);
const release = {
  format: 1,
  templateVersion: 2,
  proxyProtocolVersion: 1,
  template: { bucket: 'kilo-releases', key: `aws/${hash}/template.json`, sha256: hash },
  runtime: {
    bucket: 'kilo-releases',
    key: `aws/${hash}/runtime.zip`,
    sha256: hash,
    repositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/runtime',
  },
  proxy: {
    imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/proxy@sha256:${hash}`,
    repositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/proxy',
  },
  customerAccounts: ['999999999999'],
};
const intent = () => ({
  format: 1,
  accountId: '999999999999',
  stackName: 'kilo-' + 'b'.repeat(32),
  externalId: 'c'.repeat(64),
  kiloRoleArn: 'arn:aws:iam::123456789012:role/kilo',
  controlPlaneUrl: 'https://worker.example.com',
  release: structuredClone(release),
});
describe('AWS setup intent pins', () => {
  it('accepts a pinned release for a preauthorized account', () => {
    expect(awsSetupIntentSchema.safeParse(intent()).success).toBe(true);
  });
  it.each([
    'mutable-template',
    'foreign-proxy',
    'duplicate-account',
    'unapproved-account',
    'foreign-runtime',
  ])('rejects %s', change => {
    const value = intent();
    if (change === 'mutable-template') value.release.template.key = 'aws/latest.json';
    if (change === 'foreign-proxy')
      value.release.proxy.imageUri = value.release.proxy.imageUri.replace('/proxy@', '/foreign@');
    if (change === 'duplicate-account') value.release.customerAccounts.push('999999999999');
    if (change === 'unapproved-account') value.accountId = '888888888888';
    if (change === 'foreign-runtime')
      value.release.runtime.repositoryArn = value.release.runtime.repositoryArn.replace(
        '123456789012',
        '888888888888'
      );
    expect(awsSetupIntentSchema.safeParse(value).success).toBe(false);
  });
  it('rejects old template/proxy versions and unsafe artifact paths', () => {
    expect(awsByocReleaseSchema.safeParse({ ...release, templateVersion: 1 }).success).toBe(false);
    expect(awsByocReleaseSchema.safeParse({ ...release, proxyProtocolVersion: 99 }).success).toBe(
      false
    );
    expect(
      awsByocReleaseSchema.safeParse({
        ...release,
        runtime: { ...release.runtime, key: `../${hash}.zip` },
      }).success
    ).toBe(false);
  });
  it('binds personal OAuth owners and generation independently', () => {
    const binding = {
      owner: { userId: 'oauth/provider/user' },
      credentialId: '11111111-1111-4111-8111-111111111111',
      generation: '22222222-2222-4222-8222-222222222222',
    };
    expect(awsSetupEnvelopeAad(binding)).toContain('user:oauth/provider/user');
    expect(
      awsSetupEnvelopeAad({ ...binding, generation: '33333333-3333-4333-8333-333333333333' })
    ).not.toBe(awsSetupEnvelopeAad(binding));
    expect(
      awsSetupEnvelopeAad({
        ...binding,
        owner: { organizationId: '44444444-4444-4444-8444-444444444444' },
      })
    ).not.toBe(awsSetupEnvelopeAad(binding));
  });
});
