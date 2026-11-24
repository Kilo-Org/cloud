import { describe, expect, it } from 'vitest';
import { awsEcsSetupIntentSchema } from '@kilocode/worker-utils/aws-onboarding';
import type { AwsStack } from '@kilocode/worker-utils/aws-cloudformation';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import { ECS_TEST_CONFIG as config } from '../../test/fixtures/aws-ecs.js';
import {
  assertAwsEcsAllocationStack,
  assertAwsStackVersions,
  awsEcsResourcesFromSetupStack,
  awsEcsSetupParameters,
} from './aws-stack-validation.js';
import { validateAwsEcsStartupStack } from './aws-startup-stack.js';

const hash = 'a'.repeat(64);
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
function setup() {
  const intent = awsEcsSetupIntentSchema.parse({
    format: 1,
    provider: 'aws-ecs',
    accountId: '123456789012',
    stackName: 'kilo-' + 'b'.repeat(32),
    externalId: config.externalId,
    kiloRoleArn: 'arn:aws:iam::999999999999:role/kilo',
    controlPlaneUrl: 'https://worker.example.com',
    release: {
      format: 1,
      provider: 'aws-ecs',
      templateVersion: 1,
      proxyProtocolVersion: 1,
      template: { bucket: 'kilo-releases', key: `aws/${hash}/template.json`, sha256: hash },
      runtime: {
        imageUri: config.runtimeImage,
        repositoryArn: 'arn:aws:ecr:us-east-1:999999999999:repository/runtime',
      },
      proxy: {
        imageUri: `999999999999.dkr.ecr.us-east-1.amazonaws.com/proxy@sha256:${hash}`,
        repositoryArn: 'arn:aws:ecr:us-east-1:999999999999:repository/proxy',
      },
      customerAccounts: ['123456789012'],
    },
  });
  const value = stack();
  value.stackName = intent.stackName;
  value.stackId = `arn:aws:cloudformation:us-east-1:123456789012:stack/${intent.stackName}/12345678-abcd`;
  value.parameters = awsEcsSetupParameters(intent);
  return { intent, roleArn: config.roleArn, stack: value };
}

describe('AWS stack version and resource contract', () => {
  it('builds the ECS resources from an approved owner-bound stack', () => {
    const f = setup();
    const { proxy: _proxy, ...resources } = config;
    expect(awsEcsResourcesFromSetupStack(f)).toEqual({ ...resources, stackId: f.stack.stackId });
  });
  it.each(['version', 'protocol', 'not-ready', 'account', 'role', 'name', 'release', 'provider'])(
    'refuses %s before Save',
    change => {
      const f = setup();
      if (change === 'version') f.stack.outputs.TemplateVersion = '0';
      if (change === 'protocol') f.stack.outputs.ProxyProtocolVersion = '99';
      if (change === 'not-ready') f.stack.status = 'CREATE_IN_PROGRESS';
      if (change === 'account')
        f.stack.stackId = f.stack.stackId.replace('123456789012', '888888888888');
      if (change === 'role') f.stack.outputs.RoleArn += '-other';
      if (change === 'name') f.stack.stackName += '-other';
      if (change === 'release')
        f.stack.parameters.ProxyImageUri = f.stack.parameters.ProxyImageUri.replace(
          hash,
          'c'.repeat(64)
        );
      if (change === 'provider') f.stack.outputs.Provider = 'aws';
      expect(() => awsEcsResourcesFromSetupStack(f)).toThrow();
    }
  );
  it('requires a supported protocol even on a newer template', () => {
    const value = stack();
    value.outputs.TemplateVersion = '3';
    value.outputs.ProxyProtocolVersion = '2';
    expect(() => assertAwsStackVersions(value, 1)).toThrow('proxy release');
  });
});

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
  it('reports an actual below-minimum version before checking stale resource pins', () => {
    const value = stack();
    value.outputs.TemplateVersion = '0';
    value.outputs.RuntimeImage = 'changed';
    expect(() => assertAwsEcsAllocationStack(value, config)).toThrow(
      expect.objectContaining({ code: 'byoc_aws_stack_outdated' })
    );
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
