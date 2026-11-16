import type { IncomingMessage } from 'node:http';
import type { AwsEgressPolicy } from '@kilocode/worker-utils/aws-egress';
import { parseProxyAuthorization } from './control-plane.js';
import { connectHostname, EgressTransportError, isPublicAddress } from './destination.js';
import { intercepted, permitted } from './policies.js';
import type { PublicResolver } from './https-transport.js';

type ConnectIdentity = { hostname: string; token: string };
/** Parse claimed identity; only a current control-plane policy authorizes it. */
export function connectIdentity(
  request: Pick<IncomingMessage, 'url' | 'headers' | 'rawHeaders'>
): { kind: 'refuse'; status: 403 | 407 } | { kind: 'identity'; identity: ConnectIdentity } {
  const token = parseProxyAuthorization(request.headers['proxy-authorization']);
  if (!token) return { kind: 'refuse', status: 407 };
  const hostname = connectHostname(request.url);
  if (
    !hostname ||
    request.headers['transfer-encoding'] ||
    request.headers['content-length'] ||
    request.rawHeaders.filter(
      (_, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === 'proxy-authorization'
    ).length !== 1
  )
    return { kind: 'refuse', status: 403 };
  return { kind: 'identity', identity: { hostname, token } };
}

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
