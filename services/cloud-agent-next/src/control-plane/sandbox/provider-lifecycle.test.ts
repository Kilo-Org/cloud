import { afterEach, describe, expect, it, vi } from 'vitest';
import { createByocAwsEc2ProviderAdapter } from '../../byoc/aws-ec2-provider.js';
import type { Env } from '../../types.js';
import { ProviderLifecycleError } from '../../sandbox-control/provider-failure.js';
import { CONTROL_PLANE_PROTOCOL_VERSION } from '../../shared/control-plane-protocol.js';
import {
  reconcileProviderLaunch,
  validateProviderHello,
  type ProviderHelloAdmission,
} from './provider-lifecycle.js';

function admission(validate: () => Promise<void>, deadlineAt: number): ProviderHelloAdmission {
  return {
    provider: {
      ...createByocAwsEc2ProviderAdapter({
        env: {} as Env,
        source: { userId: 'user-1', credentialId: crypto.randomUUID() },
        sandboxId: 'sbx-test',
        storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
        captures: { get: async () => undefined, update: async () => {}, delete: async () => {} },
      }),
      validateWrapperAdmission: validate,
    },
    providerRef: 'aws-test-ref',
    connectionId: null,
    credential: 'test-credential',
    deadlineAt,
    frame: {
      type: 'hello',
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      allocationId: '11111111-1111-4111-8111-111111111111',
      wrapperId: 'wr_test',
    },
  };
}
afterEach(() => vi.useRealTimers());

describe('provider lifecycle decisions', () => {
  it.each([
    { deadlineMs: 100, timeoutMs: 1_000, boundMs: 100 },
    { deadlineMs: 1_000, timeoutMs: 100, boundMs: 100 },
  ])(
    'bounds hello by the earlier deadline: $deadlineMs/$timeoutMs',
    async ({ deadlineMs, timeoutMs, boundMs }) => {
      vi.useFakeTimers();
      let release!: () => void;
      const validation = new Promise<void>(resolve => {
        release = resolve;
      });
      const pending = validateProviderHello(
        admission(() => validation, Date.now() + deadlineMs),
        timeoutMs
      );
      await vi.advanceTimersByTimeAsync(boundMs);
      expect(await pending).toEqual({ kind: 'retry' });
      release();
      expect(await pending).toEqual({ kind: 'retry' });
    }
  );

  it('uses the same permanent reason for hello and launch recovery', async () => {
    const denied = () => Promise.reject(new ProviderLifecycleError('byoc_aws_forbidden'));
    expect(await validateProviderHello(admission(denied, Date.now() + 1_000), 1_000)).toEqual({
      kind: 'stop',
      reason: 'byoc_aws_forbidden',
    });
    expect(await reconcileProviderLaunch(denied, 1_000)).toEqual({
      kind: 'stop',
      reason: 'byoc_aws_forbidden',
    });
  });
});
