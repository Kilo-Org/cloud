/**
 * Binds an upstream connection to the addresses the URL check approved.
 *
 * The check reports the addresses it validated for a hostname, and this
 * dispatcher's resolver returns exactly those, so a socket only carries an
 * address that was checked. A hostname without a current approval fails the
 * connection.
 *
 * `Host` and TLS SNI still come from the URL, so the peer is verified against
 * its own certificate.
 */
import type { LookupFunction } from 'node:net';
import { Agent, type Dispatcher } from 'undici';
import { validatedUpstreamAddresses } from './upstream-url-policy';

const pinnedLookup: LookupFunction = (hostname, options, callback) => {
  const addresses = validatedUpstreamAddresses(hostname);
  if (!addresses || addresses.length === 0) {
    // Fail closed: nothing reaches a socket without an approved address.
    const error: NodeJS.ErrnoException = new Error(
      `The upstream host ${hostname} has no approved address`
    );
    error.code = 'ENOTFOUND';
    callback(error, '');
    return;
  }

  if (options.all) {
    callback(
      null,
      addresses.map(address => ({
        address,
        family: address.includes(':') ? 6 : 4,
      }))
    );
    return;
  }

  const [address] = addresses;
  callback(null, address, address.includes(':') ? 6 : 4);
};

let dispatcher: Dispatcher | undefined;

/**
 * The dispatcher every upstream fetch uses while the policy is enforced. One
 * instance keeps connections alive across requests; its sockets only ever
 * carry approved addresses.
 */
export function upstreamDispatcher(): Dispatcher {
  dispatcher ??= new Agent({ connect: { lookup: pinnedLookup } });
  return dispatcher;
}
