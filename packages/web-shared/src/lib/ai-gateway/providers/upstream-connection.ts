/**
 * Connects AI gateway upstream requests to addresses the URL policy validated.
 *
 * The policy resolves and checks an upstream host once (see
 * upstream-url-policy.ts). This module holds that checked address list, called a
 * pin, and hands it to undici as the `lookup` of the connection, so a connection
 * dials an address the policy approved and checks it again as it opens. The
 * lookup never answers an address the policy did not check.
 *
 * A connection that opens after a request had to wait, for one whose pool sat
 * behind the per-host connection cap while the budget ran, can outlive the pin
 * TTL. A stale pin still refuses, but the lookup then asks the policy for a
 * fresh check of the same host and answers from it when the fresh answers are
 * public, so a long request reconnects without failing. A fresh check that
 * finds a non-public answer or a failing resolver refuses the connection.
 *
 * The gateway's `fetch` is the Node global built on undici, and Next's server
 * fetch patch rebuilds the init by spreading the fields it did not consume, so
 * a `dispatcher` reaches undici. Verified on Node v24.22.2 with `undici@7.30.1`:
 * a `Dispatcher` from that version passed as `dispatcher` makes the global
 * `fetch` connect through it, and the requested name stays the `Host`.
 * `upstream-connection.test.ts` checks that pairing on the runtime the gateway
 * ships.
 */
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';
import type { Dispatcher } from 'undici';
import { isPublicIp } from './ip-address';
import { normalizeUpstreamHostname } from './upstream-hostname';
import { refreshUpstreamHostAddresses } from './upstream-url-policy';

export { normalizeUpstreamHostname };

/** How long a checked address list stays usable for a connection. */
const UPSTREAM_PIN_TTL_MS = 60 * 1000;
const UPSTREAM_PIN_MAX_HOSTS = 1000;
const UPSTREAM_AGENT_MAX_ENTRIES = 64;
/**
 * Sockets one host's pool may keep open at once. Queued requests hold no
 * socket: undici queues in-process once the cap is reached. 64 is far above the
 * concurrency one gateway instance sends to one upstream host, so the cap
 * bounds only a degenerate single-host pile-up.
 */
const UPSTREAM_AGENT_CONNECTIONS_PER_HOST = 64;

type UpstreamPin = { addresses: string[]; expiresAt: number };

/**
 * Checked addresses per normalized hostname, unused longest first. A name with
 * no entry here is refused at connect time.
 */
const pinnedAddresses = new Map<string, UpstreamPin>();
/** One connection pool per normalized hostname, unused longest first. */
const upstreamDispatchers = new Map<string, Agent>();

export class UpstreamAddressUnverifiedError extends Error {
  readonly code = 'ERR_UPSTREAM_ADDRESS_UNVERIFIED';

  constructor(hostname: string, detail: string) {
    super(`The upstream host ${hostname} was not verified: ${detail}.`);
    this.name = 'UpstreamAddressUnverifiedError';
  }
}

function familyOf(address: string): number {
  // Resolvers answer with canonical literals, so a colon means IPv6.
  return address.includes(':') ? 6 : 4;
}

function pinUpstreamAddresses(hostname: string, addresses: readonly string[]): void {
  const normalized = normalizeUpstreamHostname(hostname);
  // Re-inserting moves the host to the newest position, so the bound evicts the
  // host that has gone unused the longest.
  pinnedAddresses.delete(normalized);
  while (pinnedAddresses.size >= UPSTREAM_PIN_MAX_HOSTS) {
    const oldest = pinnedAddresses.keys().next();
    if (oldest.done) break;
    pinnedAddresses.delete(oldest.value);
  }
  pinnedAddresses.set(normalized, {
    addresses: [...addresses],
    expiresAt: Date.now() + UPSTREAM_PIN_TTL_MS,
  });
}

/**
 * The connection pool for `hostname`. `addresses` must be the checked list an
 * allowed `UpstreamUrlDecision` carried; this registers it as the pin the
 * pool's lookup answers with.
 *
 * The pin lasts `UPSTREAM_PIN_TTL_MS`, shorter than the request budget: a
 * connection the request opens later asks the URL policy to re-check the host
 * (`refreshUpstreamHostAddresses`) instead of failing.
 *
 * Throws `UpstreamAddressUnverifiedError` for an empty list or a non-public
 * address: a caller that reaches this without a validated address list has a
 * bug.
 */
export function upstreamDispatcherFor(hostname: string, addresses: readonly string[]): Dispatcher {
  if (addresses.length === 0) {
    throw new UpstreamAddressUnverifiedError(hostname, 'the URL policy returned no address');
  }
  const nonPublic = addresses.find(address => !isPublicIp(address));
  if (nonPublic !== undefined) {
    throw new UpstreamAddressUnverifiedError(hostname, `${nonPublic} is not a public address`);
  }

  pinUpstreamAddresses(hostname, addresses);

  const normalized = normalizeUpstreamHostname(hostname);
  const cached = upstreamDispatchers.get(normalized);
  if (cached) {
    // Re-inserting moves the host to the newest position, so the bound evicts
    // the pool that has gone unused the longest, matching the pin map.
    upstreamDispatchers.delete(normalized);
    upstreamDispatchers.set(normalized, cached);
    return cached;
  }

  const agent = new Agent({
    connect: { lookup: lookupPinnedUpstreamAddress },
    connections: UPSTREAM_AGENT_CONNECTIONS_PER_HOST,
  });
  upstreamDispatchers.set(normalized, agent);
  while (upstreamDispatchers.size > UPSTREAM_AGENT_MAX_ENTRIES) {
    const oldest = upstreamDispatchers.keys().next();
    if (oldest.done) break;
    const evicted = upstreamDispatchers.get(oldest.value);
    upstreamDispatchers.delete(oldest.value);
    void evicted?.close().catch(() => {});
  }
  return agent;
}

/**
 * The `lookup` undici uses for every connection it opens. It answers with the
 * pinned addresses and re-checks an expired pin: when the pin is missing or
 * expired, it asks the URL policy for a fresh check of the host and answers
 * from it when the fresh answers are public, so a connection that a request
 * opens after a wait reconnects instead of failing. A refresh that fails or
 * answers a non-public address, and a live pin that does not hold public
 * addresses, end the connection with `UpstreamAddressUnverifiedError`.
 */
export const lookupPinnedUpstreamAddress: LookupFunction = (hostname, options, callback) => {
  const normalized = normalizeUpstreamHostname(hostname);
  const answer = (addresses: readonly string[]) => {
    const nonPublic = addresses.find(address => !isPublicIp(address));
    if (nonPublic !== undefined) {
      callback(new UpstreamAddressUnverifiedError(hostname, `${nonPublic} is not a public address`), '');
      return;
    }
    if (options.all === true) {
      callback(
        null,
        addresses.map(address => ({ address, family: familyOf(address) }))
      );
      return;
    }
    const [address] = addresses;
    callback(null, address, familyOf(address));
  };
  const refuse = (detail: string) => {
    callback(new UpstreamAddressUnverifiedError(hostname, detail), '');
  };

  const pin = pinnedAddresses.get(normalized);
  if (pin && pin.expiresAt > Date.now()) {
    answer(pin.addresses);
    return;
  }
  if (pin) pinnedAddresses.delete(normalized);

  // The pin is expired or absent, and the connection needs a fresh check of the
  // host. The lookup answers later, which undici accepts: the connect waits for
  // the callback until its own connect timeout.
  void refreshUpstreamHostAddresses(normalized, undefined).then(
    addresses => {
      if (!addresses || addresses.length === 0) {
        refuse('the refreshed check found no address');
        return;
      }
      answer(addresses);
    },
    error => {
      refuse(
        error instanceof Error
          ? `the refreshed check failed: ${error.message}`
          : 'the refreshed check failed'
      );
    }
  );
};

/** Test hook. Closes every pool and forgets every pin. */
export function clearUpstreamConnectionCache(): void {
  for (const dispatcher of upstreamDispatchers.values()) void dispatcher.close().catch(() => {});
  upstreamDispatchers.clear();
  pinnedAddresses.clear();
}
