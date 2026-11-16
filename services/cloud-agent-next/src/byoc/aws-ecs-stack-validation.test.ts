import { describe, expect, it } from 'vitest';
import type { AwsStack } from '@kilocode/worker-utils/aws-cloudformation';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import { ECS_TEST_CONFIG as config } from '../../test/fixtures/aws-ecs.js';
import { assertAwsEcsAllocationStack } from './aws-ecs-stack-validation.js';
import { validateAwsEcsStartupStack } from './aws-startup-stack.js';
function stack(): AwsStack {
  return {
    stackId: config.stackId,
    stackName: 'customer',
    status: 'CREATE_COMPLETE',
    parameters: {},
    outputs: {
      Provider: 'aws-ecs',
      RoleArn: config.roleArn,
      Bucket: config.bucket,
      ClusterArn: config.clusterArn,
      TaskDefinitionArn: config.taskDefinitionArn,
      CapacityProvider: config.capacityProvider,
      ExecutionRoleArn: config.executionRoleArn,
      RuntimeImage: config.runtimeImage,
      PrivateSubnet: config.subnetId,
      SandboxSecurityGroup: config.securityGroupId,
      ProxyHostname: config.proxy.hostname,
      TemplateVersion: String(config.templateVersion),
      ProxyProtocolVersion: String(config.proxyProtocolVersion),
    },
  };
}
describe('ECS startup stack authority', () => {
  it('accepts the exact pinned ECS outputs', () => {
    expect(() => assertAwsEcsAllocationStack(stack(), config)).not.toThrow();
  });
  it.each([
    'Provider',
    'RoleArn',
    'Bucket',
    'ClusterArn',
    'TaskDefinitionArn',
    'CapacityProvider',
    'ExecutionRoleArn',
    'RuntimeImage',
    'PrivateSubnet',
    'SandboxSecurityGroup',
    'ProxyHostname',
  ])('rejects a changed %s', field => {
    const value = stack();
    value.outputs[field] = 'changed';
    expect(() => assertAwsEcsAllocationStack(value, config)).toThrow('does not match');
  });
  it('refuses old versions, incomplete stacks and another stack identity', () => {
    expect(() =>
      assertAwsEcsAllocationStack({ ...stack(), status: 'UPDATE_IN_PROGRESS' }, config)
    ).toThrow();
    const outdated = stack();
    outdated.outputs.TemplateVersion = '0';
    expect(() => assertAwsEcsAllocationStack(outdated, config)).toThrow();
    expect(() =>
      assertAwsEcsAllocationStack(
        { ...stack(), stackId: config.stackId.replace('customer', 'foreign') },
        config
      )
    ).toThrow();
  });
  it('uses the shared bounded stack read and preserves specific failures', async () => {
    let calls = 0;
    await validateAwsEcsStartupStack({
      configuration: config,
      pause: async () => {},
      read: async () => {
        if (++calls === 1) throw new AwsRequestError(503, 'ServiceUnavailable');
        return stack();
      },
    });
    expect(calls).toBe(2);
    await expect(
      validateAwsEcsStartupStack({
        configuration: config,
        read: async () => {
          throw new AwsRequestError(403, 'AccessDenied');
        },
      })
    ).rejects.toMatchObject({ reason: 'byoc_aws_forbidden' });
    const mismatch = stack();
    mismatch.outputs.Provider = 'aws';
    await expect(
      validateAwsEcsStartupStack({ configuration: config, read: async () => mismatch })
    ).rejects.toMatchObject({ reason: 'byoc_aws_connection_changed' });
  });
});
