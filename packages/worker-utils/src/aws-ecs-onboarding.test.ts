import { describe, expect, it } from 'vitest';
import { awsByocReleaseSchema, awsSetupIntentSchema } from './aws-onboarding';
import { awsEcsByocReleaseSchema, awsEcsSetupIntentSchema } from './aws-ecs-onboarding';
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
describe('independent ECS onboarding contract', () => {
  it('requires a digest-pinned image release and cannot become a MicroVM draft', () => {
    const value = intent();
    expect(awsEcsSetupIntentSchema.parse(value)).toEqual(value);
    expect(awsSetupIntentSchema.safeParse(value).success).toBe(false);
    expect(awsByocReleaseSchema.safeParse(value.release).success).toBe(false);
    expect(
      awsEcsByocReleaseSchema.safeParse({ ...value.release, provider: undefined }).success
    ).toBe(false);
  });
  it.each([
    'mutable-runtime',
    'foreign-runtime',
    'foreign-publisher',
    'traversal-runtime',
    'duplicate-account',
    'unapproved-account',
  ])('rejects %s', change => {
    const value = intent();
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
  it('defaults legacy API requests only to MicroVM and rejects unknown engines', () => {
    const request = { action: 'enrollment', owner: { userId: 'oauth/provider/user' } };
    expect(awsSetupRequestSchema.parse(request).provider).toBe('aws');
    expect(awsSetupRequestSchema.parse({ ...request, provider: 'aws-ecs' }).provider).toBe(
      'aws-ecs'
    );
    expect(awsSetupRequestSchema.safeParse({ ...request, provider: 'unknown' }).success).toBe(
      false
    );
  });
});
