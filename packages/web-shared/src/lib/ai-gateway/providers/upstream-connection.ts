/**
 * Connects AI gateway upstream requests to addresses the URL policy validated.
 *
 * The policy resolves and checks an upstream host once (see
 * upstream-url-policy.ts). This module holds that checked address list, called a
 * pin, and hands it to undici as the `lookup` of the connection, so a connection
 * dials an address the policy approved and checks it again as it opens. The
 * lookup never resolves a name.
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

export { normalizeUpstreamHostname };

/** How long a checked address list stays usable for a connection. */
const UPSTREAM_PIN_TTL_MS = 60 * 1000;
const UPSTREAM_PIN_MAX_HOSTS = 1000;
const UPSTREAM_AGENT_MAX_ENTRIES = 64;
/** Sockets one host's pool may keep open at once. */
const UPSTREAM_AGENT_CONNECTIONS_PER_HOST = 64;

type UpstreamPin = { addresses: string[]; expiresAt: number };

/**
 * Checked addresses per normalized hostname, oldest insertion first. A name with
 * no entry here is refused at connect time.
 */
const pinnedAddresses = new Map<string, UpstreamPin>();
/** One connection pool per normalized hostname, oldest insertion first. */
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
 * pinned addresses, or refuses: a missing, expired or no longer public pin ends
 * the connection with `UpstreamAddressUnverifiedError`. It never resolves a
 * name.
 */
export const lookupPinnedUpstreamAddress: LookupFunction = (hostname, options, callback) => {
  const normalized = normalizeUpstreamHostname(hostname);
  const pin = pinnedAddresses.get(normalized);
  const unverified = (detail: string) => {
    callback(new UpstreamAddressUnverifiedError(hostname, detail), '');
  };

  if (!pin) {
    unverified('no live pin');
    return;
  }
  if (pin.expiresAt <= Date.now()) {
    pinnedAddresses.delete(normalized);
    unverified('no live pin');
    return;
  }
  if (pin.addresses.some(address => !isPublicIp(address))) {
    unverified('a pinned address is not public');
    return;
  }

  if (options.all === true) {
    callback(
      null,
      pin.addresses.map(address => ({ address, family: familyOf(address) }))
    );
    return;
  }
  const [address] = pin.addresses;
  callback(null, address, familyOf(address));
};

/** Test hook. Closes every pool and forgets every pin. */
export function clearUpstreamConnectionCache(): void {
  for (const dispatcher of upstreamDispatchers.values()) void dispatcher.close().catch(() => {});
  upstreamDispatchers.clear();
  pinnedAddresses.clear();
}
