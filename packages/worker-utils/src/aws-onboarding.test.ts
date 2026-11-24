import { describe, expect, it } from 'vitest';
import {
  awsEcsByocReleaseSchema,
  awsEcsConfigurationEnvelope,
  awsEcsSetupEnvelope,
  awsEcsSetupIntentSchema,
} from './aws-onboarding';
import { awsSetupRequestSchema } from './aws-onboarding-api';

const hash = 'a'.repeat(64);
const publisher = '123456789012';
function intent() {
  return {
    format: 1,
    provider: 'aws-ecs',
    accountId: '999999999999',
    stackName: 'kilo-' + 'b'.repeat(32),
    externalId: 'c'.repeat(64),
    kiloRoleArn: `arn:aws:iam::${publisher}:role/kilo`,
    controlPlaneUrl: 'https://worker.example.com',
    release: {
      format: 1,
      provider: 'aws-ecs',
      templateVersion: 1,
      proxyProtocolVersion: 1,
      template: { bucket: 'kilo-releases', key: `aws/${hash}/template.ecs.json`, sha256: hash },
      runtime: {
        imageUri: `${publisher}.dkr.ecr.us-east-1.amazonaws.com/runtime@sha256:${hash}`,
        repositoryArn: `arn:aws:ecr:us-east-1:${publisher}:repository/runtime`,
      },
      proxy: {
        imageUri: `${publisher}.dkr.ecr.us-east-1.amazonaws.com/proxy@sha256:${hash}`,
        repositoryArn: `arn:aws:ecr:us-east-1:${publisher}:repository/proxy`,
      },
      customerAccounts: ['999999999999'],
    },
  };
}
describe('ECS onboarding contract', () => {
  it('requires a digest-pinned image release with the ECS provider', () => {
    const value = intent();
    expect(awsEcsSetupIntentSchema.parse(value)).toEqual(value);
    expect(
      awsEcsByocReleaseSchema.safeParse({ ...value.release, provider: undefined }).success
    ).toBe(false);
  });
  it.each([
    'mutable-template',
    'foreign-proxy',
    'old-template',
    'mutable-runtime',
    'foreign-runtime',
    'foreign-publisher',
    'traversal-runtime',
    'duplicate-account',
    'unapproved-account',
  ])('rejects %s', change => {
    const value = intent();
    if (change === 'mutable-template') value.release.template.key = 'aws/latest.json';
    if (change === 'foreign-proxy')
      value.release.proxy.imageUri = value.release.proxy.imageUri.replace('/proxy@', '/foreign@');
    if (change === 'old-template') value.release.templateVersion = 0;
    if (change === 'mutable-runtime')
      value.release.runtime.imageUri = value.release.runtime.imageUri.split('@')[0] + ':latest';
    if (change === 'foreign-runtime')
      value.release.runtime.repositoryArn = value.release.runtime.repositoryArn.replace(
        '/runtime',
        '/foreign'
      );
    if (change === 'foreign-publisher') {
      value.release.runtime.imageUri = value.release.runtime.imageUri.replace(
        publisher,
        '888888888888'
      );
      value.release.runtime.repositoryArn = value.release.runtime.repositoryArn.replace(
        publisher,
        '888888888888'
      );
    }
    if (change === 'traversal-runtime') {
      value.release.runtime.imageUri = value.release.runtime.imageUri.replace(
        '/runtime@',
        '/runtime/../foreign@'
      );
      value.release.runtime.repositoryArn += '/../foreign';
    }
    if (change === 'duplicate-account') value.release.customerAccounts.push(value.accountId);
    if (change === 'unapproved-account') value.accountId = '888888888888';
    expect(awsEcsSetupIntentSchema.safeParse(value).success).toBe(false);
  });
  it('accepts only ECS setup requests and rejects a missing or retired provider', () => {
    const request = {
      action: 'enrollment',
      provider: 'aws-ecs',
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
    const aad = awsEcsSetupEnvelope(binding).aad;
    expect(aad).toContain('user:oauth/provider/user');
    expect(
      awsEcsSetupEnvelope({ ...binding, generation: '33333333-3333-4333-8333-333333333333' }).aad
    ).not.toBe(aad);
    expect(
      awsEcsSetupEnvelope({
        ...binding,
        owner: { organizationId: '44444444-4444-4444-8444-444444444444' },
      }).aad
    ).not.toBe(aad);
    expect(awsEcsConfigurationEnvelope(binding.owner, binding.credentialId).aad).not.toBe(aad);
  });
});
