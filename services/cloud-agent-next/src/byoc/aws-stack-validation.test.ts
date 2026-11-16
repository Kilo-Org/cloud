import { describe, expect, it } from 'vitest';
import { awsSetupIntentSchema } from '@kilocode/worker-utils/aws-onboarding';
import type { AwsStack } from '@kilocode/worker-utils/aws-cloudformation';
import { AWS_TEST_CONFIGURATION } from '../../test/fixtures/aws-provider.js';
import {
  assertAwsAllocationStack,
  assertAwsStackVersions,
  awsConfigurationFromSetupStack,
  awsSetupParameters,
} from './aws-stack-validation.js';
const hash = 'a'.repeat(64);
function fixture() {
  const config = { ...AWS_TEST_CONFIGURATION, templateVersion: 2 };
  const intent = awsSetupIntentSchema.parse({
    format: 1,
    accountId: '123456789012',
    stackName: 'kilo-' + 'b'.repeat(32),
    externalId: config.externalId,
    kiloRoleArn: 'arn:aws:iam::123456789012:role/kilo',
    controlPlaneUrl: 'https://worker.example.com',
    release: {
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
      customerAccounts: ['123456789012'],
    },
  });
  config.stackId = `arn:aws:cloudformation:us-east-1:123456789012:stack/${intent.stackName}/12345678-abcd`;
  const stack: AwsStack = {
    stackId: config.stackId,
    stackName: intent.stackName,
    status: 'CREATE_COMPLETE',
    parameters: awsSetupParameters(intent),
    outputs: {
      RoleArn: config.roleArn,
      Bucket: config.bucket,
      ImageArn: config.imageIdentifier,
      ImageVersion: config.imageVersion,
      ConnectorArn: config.connectorArn,
      TemplateVersion: '2',
      ProxyProtocolVersion: '1',
    },
  };
  return { config, intent, stack };
}
describe('AWS stack version and resource contract', () => {
  it('builds the runtime configuration from an approved owner-bound stack', () => {
    const f = fixture();
    expect(awsConfigurationFromSetupStack({ ...f, roleArn: f.config.roleArn })).toEqual(f.config);
    expect(() => assertAwsAllocationStack(f.stack, f.config)).not.toThrow();
  });
  it.each(['version', 'protocol', 'not-ready', 'account', 'role', 'name', 'release'])(
    'refuses %s before Save',
    change => {
      const f = fixture();
      if (change === 'version') f.stack.outputs.TemplateVersion = '1';
      if (change === 'protocol') f.stack.outputs.ProxyProtocolVersion = '99';
      if (change === 'not-ready') f.stack.status = 'CREATE_IN_PROGRESS';
      if (change === 'account')
        f.stack.stackId = f.stack.stackId.replace('123456789012', '999999999999');
      if (change === 'role') f.stack.outputs.RoleArn += '-other';
      if (change === 'name') f.stack.stackName += '-other';
      if (change === 'release')
        f.stack.parameters.ProxyImageUri = f.stack.parameters.ProxyImageUri.replace(
          hash,
          'c'.repeat(64)
        );
      expect(() => awsConfigurationFromSetupStack({ ...f, roleArn: f.config.roleArn })).toThrow();
    }
  );
  it('reports an actual below-minimum version before checking stale resource pins', () => {
    const f = fixture();
    f.stack.outputs.TemplateVersion = '1';
    f.stack.outputs.ImageVersion = '9.0';
    try {
      assertAwsAllocationStack(f.stack, f.config);
      throw new Error('Expected refusal');
    } catch (error) {
      expect(error).toMatchObject({ code: 'byoc_aws_stack_outdated' });
    }
  });
  it('rejects changed live resources before allocating new compute', () => {
    const f = fixture();
    f.stack.outputs.ImageVersion = '9.0';
    expect(() => assertAwsAllocationStack(f.stack, f.config)).toThrow('does not match');
    f.stack.outputs.ImageVersion = f.config.imageVersion;
    expect(() =>
      assertAwsAllocationStack(f.stack, {
        ...f.config,
        proxy: {
          generation: crypto.randomUUID(),
          hostname: 'expected.proxy.internal',
          caFingerprint: 'd'.repeat(64),
        },
      })
    ).toThrow('does not match');
  });
  it('requires a supported protocol even on a newer template', () => {
    const f = fixture();
    f.stack.outputs.TemplateVersion = '3';
    f.stack.outputs.ProxyProtocolVersion = '2';
    expect(() => assertAwsStackVersions(f.stack)).toThrow('proxy release');
  });
});
