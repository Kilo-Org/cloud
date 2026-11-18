import { describe, expect, it, vi } from 'vitest';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import type { AwsStack } from '@kilocode/worker-utils/aws-cloudformation';
import { AWS_TEST_CONFIGURATION } from '../../test/fixtures/aws-provider.js';
import { validateAwsStartupStack } from './aws-startup-stack.js';
function fixture() {
  const config = AWS_TEST_CONFIGURATION;
  const stack: AwsStack = {
    stackId: config.stackId,
    stackName: 'customer',
    status: 'UPDATE_COMPLETE',
    parameters: {},
    outputs: {
      TemplateVersion: '2',
      ProxyProtocolVersion: '1',
      RoleArn: config.roleArn,
      Bucket: config.bucket,
      ImageArn: config.imageIdentifier,
      ImageVersion: config.imageVersion,
      ConnectorArn: config.connectorArn,
    },
  };
  return {
    config,
    stack,
    read: vi.fn(async () => structuredClone(stack)),
    pause: vi.fn(async () => {}),
  };
}
describe('AWS new-allocation stack admission', () => {
  it('retries an updating stack within a bound and resumes when it completes', async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce({ ...f.stack, status: 'UPDATE_IN_PROGRESS' });
    await validateAwsStartupStack({ configuration: f.config, ...f });
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.pause).toHaveBeenCalledWith(1000);
    f.read.mockClear();
    f.pause.mockClear();
    f.read.mockResolvedValue({ ...f.stack, status: 'UPDATE_IN_PROGRESS' });
    await expect(validateAwsStartupStack({ configuration: f.config, ...f })).rejects.toMatchObject({
      reason: 'byoc_aws_stack_unavailable',
    });
    expect(f.read).toHaveBeenCalledTimes(3);
    expect(f.pause.mock.calls).toEqual([[1000], [2000]]);
  });

  it('retries a transient read and checks current resources', async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new AwsRequestError(503, 'Unavailable'));
    await validateAwsStartupStack({ configuration: f.config, ...f });
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.pause).toHaveBeenCalledWith(100);
  });
  it('bounds unavailable reads and refuses forbidden access immediately', async () => {
    const f = fixture();
    f.read.mockRejectedValue(new AwsRequestError(503, 'Unavailable'));
    await expect(validateAwsStartupStack({ configuration: f.config, ...f })).rejects.toMatchObject({
      reason: 'byoc_aws_stack_unavailable',
    });
    expect(f.read).toHaveBeenCalledTimes(3);
    f.read.mockClear();
    f.read.mockRejectedValue(new AwsRequestError(403, 'Forbidden'));
    await expect(validateAwsStartupStack({ configuration: f.config, ...f })).rejects.toMatchObject({
      reason: 'byoc_aws_forbidden',
    });
    expect(f.read).toHaveBeenCalledOnce();
    f.read.mockClear();
    f.read.mockRejectedValue(new AwsRequestError(422, 'InvalidStackResponse'));
    await expect(validateAwsStartupStack({ configuration: f.config, ...f })).rejects.toMatchObject({
      reason: 'byoc_aws_not_ready',
    });
    expect(f.read).toHaveBeenCalledOnce();
  });
  it.each(['version', 'protocol', 'changed-image'])(
    'refuses %s without transient retries',
    async change => {
      const f = fixture();
      if (change === 'version') f.stack.outputs.TemplateVersion = '1';
      if (change === 'protocol') f.stack.outputs.ProxyProtocolVersion = '2';
      if (change === 'changed-image') f.stack.outputs.ImageVersion = '99.0';
      await expect(
        validateAwsStartupStack({ configuration: f.config, ...f })
      ).rejects.toMatchObject({
        reason:
          change === 'changed-image' ? 'byoc_aws_connection_changed' : 'byoc_aws_stack_outdated',
      });
      expect(f.read).toHaveBeenCalledOnce();
      expect(f.pause).not.toHaveBeenCalled();
    }
  );
});
