import { describe, expect, it } from 'vitest';
import { awsEcsByocConfigurationSchema, awsEcsTaskArnSchema } from './aws-ecs';
import { awsByocConfigurationSchema } from './aws-byoc';

const account = '123456789012';
const config = () => ({
  region: 'us-east-1',
  roleArn: `arn:aws:iam::${account}:role/customer`,
  externalId: 'a'.repeat(64),
  stackId: `arn:aws:cloudformation:us-east-1:${account}:stack/kilo-test/11111111-1111-4111-8111-111111111111`,
  bucket: 'customer-artifacts',
  templateVersion: 1,
  proxyProtocolVersion: 1,
  proxy: {
    generation: '22222222-2222-4222-8222-222222222222',
    hostname: 'proxy.internal.example.com',
    caFingerprint: 'b'.repeat(64),
  },
  clusterArn: `arn:aws:ecs:us-east-1:${account}:cluster/kilo-test`,
  taskDefinitionArn: `arn:aws:ecs:us-east-1:${account}:task-definition/kilo-test:1`,
  capacityProvider: 'kilo-test-managed',
  subnetId: 'subnet-0123456789abcdef0',
  securityGroupId: 'sg-0123456789abcdef0',
  executionRoleArn: `arn:aws:iam::${account}:role/execution`,
  runtimeImage: `999999999999.dkr.ecr.us-east-1.amazonaws.com/runtime@sha256:${'c'.repeat(64)}`,
});
describe('independent AWS ECS configuration', () => {
  it('accepts scoped customer resources and a digest-pinned private release image', () => {
    expect(awsEcsByocConfigurationSchema.parse(config())).toEqual(config());
    expect(awsByocConfigurationSchema.safeParse(config()).success).toBe(false);
  });
  it.each(['clusterArn', 'taskDefinitionArn', 'executionRoleArn', 'stackId'] as const)(
    'rejects foreign customer resource %s',
    field => {
      const value = config();
      value[field] = value[field].replace(account, '888888888888');
      expect(awsEcsByocConfigurationSchema.safeParse(value).success).toBe(false);
    }
  );
  it.each([
    'runtime:latest',
    'public.ecr.aws/runtime@sha256:' + 'c'.repeat(64),
    '123456789012.dkr.ecr.us-east-1.amazonaws.com/runtime/../other@sha256:' + 'c'.repeat(64),
  ])('rejects an unpinned or invalid runtime image', runtimeImage => {
    expect(awsEcsByocConfigurationSchema.safeParse({ ...config(), runtimeImage }).success).toBe(
      false
    );
  });
  it('requires proxy pins and rejects MicroVM fields', () => {
    expect(awsEcsByocConfigurationSchema.safeParse({ ...config(), proxy: undefined }).success).toBe(
      false
    );
    expect(
      awsEcsByocConfigurationSchema.safeParse({ ...config(), imageVersion: '1.0' }).success
    ).toBe(false);
  });
  it('accepts only long task ARNs with explicit cluster identity', () => {
    expect(
      awsEcsTaskArnSchema.safeParse(
        `arn:aws:ecs:us-east-1:${account}:task/kilo-test/${'d'.repeat(32)}`
      ).success
    ).toBe(true);
    expect(
      awsEcsTaskArnSchema.safeParse(`arn:aws:ecs:us-east-1:${account}:task/${'d'.repeat(32)}`)
        .success
    ).toBe(false);
  });
});
