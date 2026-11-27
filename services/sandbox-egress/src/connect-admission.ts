import type { AwsEgressPolicy } from '@kilocode/worker-utils/aws-egress';
import { EgressTransportError, isPublicAddress } from './destination.js';
import { intercepted, permitted } from './policies.js';
import type { PublicResolver } from './https-transport.js';

export type ConnectDecision =
  | { kind: 'refuse' }
  | { kind: 'intercept' }
  | { kind: 'tunnel'; address: string };

/** Policy and destination decision. DNS is the only I/O; the caller owns policy refresh and audit. */
export async function admitConnect(input: {
  hostname: string;
  policy: AwsEgressPolicy;
  resolve: PublicResolver;
  signal: AbortSignal;
}): Promise<ConnectDecision> {
  const { hostname, policy, signal } = input;
  if (!permitted(policy, hostname)) return { kind: 'refuse' };
  if (intercepted(policy, hostname)) return { kind: 'intercept' };
  let addresses: readonly string[];
  try {
    addresses = await input.resolve(
      hostname,
      AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    );
  } catch (error) {
    if (error instanceof EgressTransportError && error.code === 'destination_denied')
      return { kind: 'refuse' };
    throw error;
  }
  if (!addresses.length || addresses.some(value => !isPublicAddress(value)))
    return { kind: 'refuse' };
  return { kind: 'tunnel', address: addresses[0] };
}
