import { describe, expect, it, vi } from 'vitest';
import type { AwsEgressPolicy } from '@kilocode/worker-utils/aws-egress';
import { admitConnect } from './connect-admission.js';
import { EgressTransportError } from './destination.js';

const policy: AwsEgressPolicy = {
  protocolVersion: 1,
  generation: '22222222-2222-4222-8222-222222222222',
  stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/customer/12345678-abcd',
  sandboxId: 'sbx_test',
  allocationId: '11111111-1111-4111-8111-111111111111',
  allocationRef: 'allocation-1',
  validUntil: Date.now() + 30_000,
  audit: true,
  interceptedHosts: ['github.com'],
};
describe('destination admission', () => {
  it('refuses an unlisted hostname before DNS and intercepts only permitted SCM hosts', async () => {
    const resolve = vi.fn(async () => ['8.8.8.8']);
    const input = {
      policy: { ...policy, allowlist: ['example.com'] },
      resolve,
      signal: new AbortController().signal,
    };
    expect(await admitConnect({ ...input, hostname: 'github.com' })).toEqual({ kind: 'refuse' });
    expect(resolve).not.toHaveBeenCalled();
    expect(await admitConnect({ ...input, policy, hostname: 'github.com' })).toEqual({
      kind: 'intercept',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(
    [[], ['127.0.0.1'], ['8.8.8.8', '10.0.0.1'], ['::ffff:8.8.8.8']].map(addresses => ({
      addresses,
    }))
  )('refuses an unsafe or empty DNS result %j', async ({ addresses }) => {
    expect(
      await admitConnect({
        hostname: 'example.com',
        policy,
        resolve: async () => addresses,
        signal: new AbortController().signal,
      })
    ).toEqual({ kind: 'refuse' });
  });

  it('returns the checked address for the tunnel without another DNS lookup', async () => {
    const resolve = vi.fn(async () => ['8.8.8.8', '1.1.1.1']);
    expect(
      await admitConnect({
        hostname: 'example.com',
        policy,
        resolve,
        signal: new AbortController().signal,
      })
    ).toEqual({ kind: 'tunnel', address: '8.8.8.8' });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('distinguishes destination denial from a resolver outage', async () => {
    const input = { hostname: 'example.com', policy, signal: new AbortController().signal };
    expect(
      await admitConnect({
        ...input,
        resolve: async () => {
          throw new EgressTransportError('destination_denied');
        },
      })
    ).toEqual({ kind: 'refuse' });
    await expect(
      admitConnect({
        ...input,
        resolve: async () => {
          throw new EgressTransportError('dns_unavailable');
        },
      })
    ).rejects.toMatchObject({ code: 'dns_unavailable' });
  });
});
