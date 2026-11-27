import { describe, expect, it } from 'vitest';
import {
  awsEc2ByocReleaseSchema,
  awsEc2ConfigurationEnvelope,
  awsEc2SetupEnvelope,
  awsEc2SetupIntentSchema,
} from './aws-onboarding';
import { awsSetupRequestSchema } from './aws-onboarding-api';

const hash = 'a'.repeat(64);
const publisher = '123456789012';
function intent() {
  return {
    format: 1,
    provider: 'aws-ec2',
    accountId: '999999999999',
    stackName: 'kilo-' + 'b'.repeat(32),
    externalId: 'c'.repeat(64),
    kiloRoleArn: `arn:aws:iam::${publisher}:role/kilo`,
    installation: '33333333-3333-4333-8333-333333333333',
    release: {
      format: 1,
      templateVersion: 1,
      imageId: 'ami-0123456789abcdef0',
      template: { bucket: 'kilo-releases', key: `aws/${hash}/template.ec2.json`, sha256: hash },
      customerAccounts: ['999999999999'],
    },
  };
}
describe('EC2 onboarding contract', () => {
  it('requires an immutable EC2 host image', () => {
    const value = intent();
    expect(awsEc2SetupIntentSchema.parse(value)).toEqual(value);
    expect(
      awsEc2ByocReleaseSchema.safeParse({ ...value.release, imageId: undefined }).success
    ).toBe(false);
  });
  it.each([
    'mutable-template',
    'old-template',
    'mutable-runtime',
    'duplicate-account',
    'unapproved-account',
  ])('rejects %s', change => {
    const value = intent();
    if (change === 'mutable-template') value.release.template.key = 'aws/latest.json';
    if (change === 'old-template') value.release.templateVersion = 0;
    if (change === 'mutable-runtime') value.release.imageId = 'latest';
    if (change === 'duplicate-account') value.release.customerAccounts.push(value.accountId);
    if (change === 'unapproved-account') value.accountId = '888888888888';
    expect(awsEc2SetupIntentSchema.safeParse(value).success).toBe(false);
  });
  it('accepts only EC2 setup requests and rejects a missing or retired provider', () => {
    const request = {
      action: 'enrollment',
      provider: 'aws-ec2',
      owner: { userId: 'oauth/provider/user' },
    };
    expect(awsSetupRequestSchema.parse(request)).toEqual(request);
    expect(awsSetupRequestSchema.safeParse({ ...request, provider: 'aws' }).success).toBe(false);
    const { provider: _provider, ...missing } = request;
    expect(awsSetupRequestSchema.safeParse(missing).success).toBe(false);
  });
  it('binds personal OAuth owners and generation independently', () => {
    const binding = {
      owner: { userId: 'oauth/provider/user' },
      credentialId: '11111111-1111-4111-8111-111111111111',
      generation: '22222222-2222-4222-8222-222222222222',
    };
    const aad = awsEc2SetupEnvelope(binding).aad;
    expect(aad).toContain('user:oauth/provider/user');
    expect(
      awsEc2SetupEnvelope({ ...binding, generation: '33333333-3333-4333-8333-333333333333' }).aad
    ).not.toBe(aad);
    expect(
      awsEc2SetupEnvelope({
        ...binding,
        owner: { organizationId: '44444444-4444-4444-8444-444444444444' },
      }).aad
    ).not.toBe(aad);
    expect(awsEc2ConfigurationEnvelope(binding.owner, binding.credentialId).aad).not.toBe(aad);
  });
});
