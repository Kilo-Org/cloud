import { Agent, fetch as undiciFetch } from 'undici';
import type { Dispatcher } from 'undici';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { LookupOptions } from 'node:dns';
import {
  clearUpstreamConnectionCache,
  lookupPinnedUpstreamAddress,
  normalizeUpstreamHostname,
  UpstreamAddressUnverifiedError,
  upstreamDispatcherFor,
} from './upstream-connection';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));

/** The `{ all: true }` overload the policy awaits. */
const lookupMock = jest.mocked(
  lookup as unknown as (
    hostname: string,
    options: { all: true; verbatim: true }
  ) => Promise<Array<{ address: string; family: number }>>
);

const PUBLIC_IPV4 = '104.18.2.115';
const PUBLIC_IPV6 = '2606:4700::6812:273';

type LookupCall = [error: unknown, address: unknown, family: unknown];

/**
 * Runs the pinned lookup and records what it answered. It resolves nothing
 * itself: the callback is the only way an address leaves the module.
 */
function runLookup(hostname: string, options: LookupOptions): LookupCall[] {
  const calls: LookupCall[] = [];
  lookupPinnedUpstreamAddress(hostname, options, (error, address, family) => {
    calls.push([error, address, family]);
  });
  return calls;
}

function refusalOf(calls: LookupCall[]): UpstreamAddressUnverifiedError {
  const [error, address] = calls[0];
  if (!(error instanceof UpstreamAddressUnverifiedError)) {
    throw new Error(`expected a refusal, got ${String(error)}`);
  }
  expect(address).toBe('');
  return error;
}

/**
 * The lookup can answer later: a stale-pin refresh resolves a fresh check
 * before it calls back. This collects the first answer, whenever it lands.
 */
function runLookupAsync(hostname: string, options: LookupOptions): Promise<LookupCall[]> {
  const { promise, resolve } = Promise.withResolvers<LookupCall[]>();
  lookupPinnedUpstreamAddress(hostname, options, (error, address, family) => {
    resolve([[error, address, family]]);
  });
  return promise;
}

function causeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'cause' in error ? error.cause : undefined;
}

describe('normalizeUpstreamHostname', () => {
  it('lowercases the name and strips one trailing dot', () => {
    expect(normalizeUpstreamHostname('LLM.Example.COM.')).toBe('llm.example.com');
    expect(normalizeUpstreamHostname('llm.example.com')).toBe('llm.example.com');
  });
});

describe('lookupPinnedUpstreamAddress', () => {
  beforeEach(() => {
    clearUpstreamConnectionCache();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('answers the first pinned address for a single-address lookup', () => {
    upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4, PUBLIC_IPV6]);

    const calls = runLookup('PINNED.Example.', { all: false });

    expect(calls).toEqual([[null, PUBLIC_IPV4, 4]]);
  });

  it('answers every pinned address with its family when the resolver asks for all', () => {
    upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4, PUBLIC_IPV6]);

    const calls = runLookup('pinned.example', { all: true });

    expect(calls).toEqual([
      [
        null,
        [
          { address: PUBLIC_IPV4, family: 4 },
          { address: PUBLIC_IPV6, family: 6 },
        ],
        undefined,
      ],
    ]);
  });

  it('re-checks and answers a host with no pin, instead of resolving it itself', async () => {
    lookupMock.mockResolvedValue([{ address: PUBLIC_IPV4, family: 4 }]);

    const calls = await runLookupAsync('unpinned.example', { all: false });

    expect(calls).toEqual([[null, PUBLIC_IPV4, 4]]);
    expect(calls[0][1]).toBe(PUBLIC_IPV4);
  });

  it('refreshes an expired pin from a fresh check instead of refusing', async () => {
    upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4]);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 60_001);
    lookupMock.mockResolvedValue([{ address: PUBLIC_IPV4, family: 4 }]);

    // The refresh runs a fresh DNS check of the host and answers the fresh list.
    expect(await runLookupAsync('pinned.example', { all: false })).toEqual([
      [null, PUBLIC_IPV4, 4],
    ]);
    expect(lookupMock).toHaveBeenCalledWith('pinned.example', { all: true, verbatim: true });

    // The refreshed check stored a fresh list for the policy cache, so a new
    // dispatcher call re-pins the host from that list without another lookup.
    jest.clearAllMocks();
    lookupMock.mockResolvedValue([{ address: PUBLIC_IPV4, family: 4 }]);
    upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4]);
    jest.restoreAllMocks();
    expect(runLookup('pinned.example', { all: false })).toEqual([[null, PUBLIC_IPV4, 4]]);
  });

  it('refuses a stale pin whose fresh check answers a non-public address', async () => {
    upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4]);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    lookupMock.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);

    const calls = await runLookupAsync('pinned.example', { all: false });

    const error = refusalOf(calls);
    expect(error.message).toContain('the refreshed check found no address');
  });

  it('refuses a stale pin whose fresh check cannot resolve the host', async () => {
    upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4]);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    lookupMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    const calls = await runLookupAsync('pinned.example', { all: false });

    const error = refusalOf(calls);
    expect(error.message).toContain('the refreshed check found no address');
  });

  it('refuses an unpinned host whose fresh check answers a non-public address', async () => {
    lookupMock.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);

    const calls = await runLookupAsync('unpinned.example', { all: false });

    const error = refusalOf(calls);
    expect(error.message).toContain('the refreshed check found no address');
  });
});

describe('upstreamDispatcherFor', () => {
  beforeEach(() => {
    clearUpstreamConnectionCache();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refuses an empty address list', () => {
    expect(() => upstreamDispatcherFor('pinned.example', [])).toThrow(
      UpstreamAddressUnverifiedError
    );
  });

  it.each(['10.1.2.3', '127.0.0.1', '169.254.169.254', 'fd00::1'])(
    'refuses the non-public address %s',
    address => {
      expect(() => upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4, address])).toThrow(
        UpstreamAddressUnverifiedError
      );
    }
  );

  it('returns the same dispatcher for the same host and another for another host', () => {
    const first = upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4]);
    const again = upstreamDispatcherFor('PINNED.example.', [PUBLIC_IPV4]);
    const other = upstreamDispatcherFor('other.example', [PUBLIC_IPV4]);

    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });

  it('closes the oldest dispatcher when the pool passes its bound', () => {
    const closeSpy = jest.spyOn(Agent.prototype, 'close');

    const oldest = upstreamDispatcherFor('h0.example', [PUBLIC_IPV4]);
    for (let index = 1; index < 64; index += 1) {
      upstreamDispatcherFor(`h${index}.example`, [PUBLIC_IPV4]);
    }
    expect(closeSpy).not.toHaveBeenCalled();

    upstreamDispatcherFor('h64.example', [PUBLIC_IPV4]);

    // `close()` re-enters itself for its promise, so count the distinct agents.
    const closed = new Set(closeSpy.mock.contexts);
    expect(closed.size).toBe(1);
    expect(closed.has(oldest)).toBe(true);

    expect(runLookup('h64.example', { all: false })).toEqual([[null, PUBLIC_IPV4, 4]]);
  });

  it('returns the same agent instance on a repeated call', () => {
    const first = upstreamDispatcherFor('reuse.example', [PUBLIC_IPV4]);
    expect(upstreamDispatcherFor('reuse.example', [PUBLIC_IPV4])).toBe(first);
  });

  it('evicts the pool unused longest when a host passes the bound after reuse', () => {
    const closeSpy = jest.spyOn(Agent.prototype, 'close');

    const reused = upstreamDispatcherFor('keep.example', [PUBLIC_IPV4]);
    for (let index = 1; index < 64; index += 1) {
      upstreamDispatcherFor(`h${index}.example`, [PUBLIC_IPV4]);
    }
    // Touch the kept host so its pool becomes the newest entry.
    expect(upstreamDispatcherFor('keep.example', [PUBLIC_IPV4])).toBe(reused);

    upstreamDispatcherFor('h64.example', [PUBLIC_IPV4]);

    const closed = new Set(closeSpy.mock.contexts);
    expect(closed.size).toBe(1);
    expect(closed.has(reused)).toBe(false);
    expect(runLookup('keep.example', { all: false })).toEqual([[null, PUBLIC_IPV4, 4]]);
  });
});

describe('pinned connections and fetch', () => {
  beforeEach(() => {
    clearUpstreamConnectionCache();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fails the fetch with the unverified code when the refresh cannot verify the host', async () => {
    const dispatcher = upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4]);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    lookupMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    // The package's fetch, not the global one: both live in this module realm,
    // so the rejection's cause keeps the error object the lookup threw.
    const error = await undiciFetch('https://pinned.example/v1', { dispatcher }).then(
      () => null,
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(causeOf(error)).toBeInstanceOf(UpstreamAddressUnverifiedError);
    expect(causeOf(error)).toMatchObject({ code: 'ERR_UPSTREAM_ADDRESS_UNVERIFIED' });
  });

  it('makes the runtime fetch dial the address the dispatcher lookup answers', async () => {
    const receivedHosts: string[] = [];
    const lookedUpHostnames: string[] = [];
    const server = createServer((request, response) => {
      receivedHosts.push(request.headers.host ?? '');
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('pinned');
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const { port } = server.address() as AddressInfo;

    const dispatcher = new Agent({
      connect: {
        lookup: (hostname, options, callback) => {
          lookedUpHostnames.push(hostname);
          if (options.all === true) {
            callback(null, [{ address: '127.0.0.1', family: 4 }]);
            return;
          }
          callback(null, '127.0.0.1', 4);
        },
      },
    });

    try {
      const init: RequestInit & { dispatcher: Dispatcher } = { dispatcher };
      const response = await globalThis.fetch(`http://pinned-guard.test:${port}/`, init);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('pinned');
      expect(receivedHosts).toEqual([`pinned-guard.test:${port}`]);
      expect(lookedUpHostnames).toContain('pinned-guard.test');
    } finally {
      await dispatcher.close();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
  });
});
