import { Agent, fetch as undiciFetch } from 'undici';
import type { Dispatcher } from 'undici';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupOptions } from 'node:dns';
import {
  clearUpstreamConnectionCache,
  lookupPinnedUpstreamAddress,
  normalizeUpstreamHostname,
  UpstreamAddressUnverifiedError,
  upstreamDispatcherFor,
} from './upstream-connection';

const mockResolve4 = jest.fn<Promise<string[]>, [string]>();

// The refresh path resolves A and AAAA records through c-ares; the tests answer
// the A query and leave the AAAA query empty.
jest.mock('node:dns/promises', () => ({
  Resolver: jest.fn(function () {
    return {
      resolve4: (hostname: string) => mockResolve4(hostname),
      resolve6: async () => [],
      cancel: jest.fn(),
    };
  }),
}));

const PUBLIC_IPV4 = '104.18.2.115';
const PUBLIC_IPV6 = '2606:4700::6812:273';

/** The expiry an allowed URL policy decision carries for a check made now. */
function checkExpiry(): number {
  return Date.now() + 60_000;
}

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
    mockResolve4.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('answers the first pinned address for a single-address lookup', () => {
    upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4, PUBLIC_IPV6], checkExpiry());

    const calls = runLookup('PINNED.Example.', { all: false });

    expect(calls).toEqual([[null, PUBLIC_IPV4, 4]]);
  });

  it('answers every pinned address with its family when the resolver asks for all', () => {
    upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4, PUBLIC_IPV6], checkExpiry());

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
    mockResolve4.mockResolvedValue([PUBLIC_IPV4]);

    const calls = await runLookupAsync('unpinned.example', { all: false });

    expect(calls).toEqual([[null, PUBLIC_IPV4, 4]]);
    expect(calls[0][1]).toBe(PUBLIC_IPV4);
  });

  it('refreshes an expired pin from a fresh check instead of refusing', async () => {
    upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4], checkExpiry());
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 60_001);
    mockResolve4.mockResolvedValue([PUBLIC_IPV4]);

    // The refresh runs a fresh DNS check of the host and answers the fresh list.
    expect(await runLookupAsync('pinned.example', { all: false })).toEqual([
      [null, PUBLIC_IPV4, 4],
    ]);
    expect(mockResolve4).toHaveBeenCalledWith('pinned.example');
    const callsAfterRefresh = mockResolve4.mock.calls.length;

    // The refreshed check registered the fresh list as the host's pin, so the
    // pool's next connection answers from it without another system lookup.
    expect(runLookup('pinned.example', { all: false })).toEqual([[null, PUBLIC_IPV4, 4]]);
    expect(mockResolve4.mock.calls.length).toBe(callsAfterRefresh);

    // A later dispatcher call for the same host also returns the same pool whose
    // lookup answers the pinned list.
    jest.clearAllMocks();
    mockResolve4.mockResolvedValue([PUBLIC_IPV4]);
    upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4], checkExpiry());
    jest.restoreAllMocks();
    expect(runLookup('pinned.example', { all: false })).toEqual([[null, PUBLIC_IPV4, 4]]);
  });

  it('refuses a stale pin whose fresh check answers a non-public address', async () => {
    upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4], checkExpiry());
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    mockResolve4.mockResolvedValue(['10.1.2.3']);

    const calls = await runLookupAsync('pinned.example', { all: false });

    const error = refusalOf(calls);
    expect(error.message).toContain('the refreshed check found no address');
  });

  it('refuses a stale pin whose fresh check cannot resolve the host', async () => {
    upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4], checkExpiry());
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    mockResolve4.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    const calls = await runLookupAsync('pinned.example', { all: false });

    const error = refusalOf(calls);
    expect(error.message).toContain('the refreshed check found no address');
  });

  it('refuses an unpinned host whose fresh check answers a non-public address', async () => {
    mockResolve4.mockResolvedValue(['10.1.2.3']);

    const calls = await runLookupAsync('unpinned.example', { all: false });

    const error = refusalOf(calls);
    expect(error.message).toContain('the refreshed check found no address');
  });

  describe('pin expiry', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('expires the pin with the check that produced its addresses', async () => {
      jest.useFakeTimers();
      upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4], Date.now() + 5_000);
      mockResolve4.mockResolvedValue(['104.18.9.9']);

      jest.setSystemTime(Date.now() + 4_000);
      expect(runLookup('pinned.example', { all: false })).toEqual([[null, PUBLIC_IPV4, 4]]);
      expect(mockResolve4).not.toHaveBeenCalled();

      jest.setSystemTime(Date.now() + 2_000);
      expect(await runLookupAsync('pinned.example', { all: false })).toEqual([
        [null, '104.18.9.9', 4],
      ]);
      expect(mockResolve4).toHaveBeenCalledTimes(1);
      expect(mockResolve4).toHaveBeenCalledWith('pinned.example');
    });

    it('caps the pin at its own lifetime when the check outlasts it', async () => {
      jest.useFakeTimers();
      upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4], Date.now() + 10 * 60_000);
      mockResolve4.mockResolvedValue(['104.18.9.9']);

      jest.setSystemTime(Date.now() + 59_000);
      expect(runLookup('pinned.example', { all: false })).toEqual([[null, PUBLIC_IPV4, 4]]);
      expect(mockResolve4).not.toHaveBeenCalled();

      jest.setSystemTime(Date.now() + 2_000);
      expect(await runLookupAsync('pinned.example', { all: false })).toEqual([
        [null, '104.18.9.9', 4],
      ]);
    });

    it('refuses a pin from a check that had already expired', async () => {
      upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4], Date.now() - 1);
      mockResolve4.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

      refusalOf(await runLookupAsync('pinned.example', { all: false }));
    });
  });

  describe('address family', () => {
    it('answers only the pinned IPv4 address when the lookup asks for family 4', () => {
      upstreamDispatcherFor('pinned.example', [PUBLIC_IPV6, PUBLIC_IPV4], checkExpiry());

      expect(runLookup('pinned.example', { all: false, family: 4 })).toEqual([
        [null, PUBLIC_IPV4, 4],
      ]);
      expect(runLookup('pinned.example', { all: true, family: 4 })).toEqual([
        [null, [{ address: PUBLIC_IPV4, family: 4 }], undefined],
      ]);
    });

    it.each([6, 'IPv6'] as const)(
      'answers only the pinned IPv6 address when the lookup asks for family %s',
      family => {
        upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4, PUBLIC_IPV6], checkExpiry());

        expect(runLookup('pinned.example', { all: false, family })).toEqual([
          [null, PUBLIC_IPV6, 6],
        ]);
        expect(runLookup('pinned.example', { all: true, family })).toEqual([
          [null, [{ address: PUBLIC_IPV6, family: 6 }], undefined],
        ]);
      }
    );

    it.each([4, 'IPv4'] as const)(
      'refuses family %s when only an IPv6 address is pinned',
      family => {
        upstreamDispatcherFor('pinned.example', [PUBLIC_IPV6], checkExpiry());

        const error = refusalOf(runLookup('pinned.example', { all: false, family }));

        expect(error.message).toContain('no checked IPv4 address');
        expect(refusalOf(runLookup('pinned.example', { all: true, family })).message).toContain(
          'no checked IPv4 address'
        );
      }
    );

    it('refuses family 6 when only an IPv4 address is pinned', () => {
      upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4], checkExpiry());

      const error = refusalOf(runLookup('pinned.example', { all: false, family: 6 }));

      expect(error.message).toContain('no checked IPv6 address');
    });

    it('answers the first pinned address when the lookup names no family', () => {
      upstreamDispatcherFor('pinned.example', [PUBLIC_IPV6, PUBLIC_IPV4], checkExpiry());

      expect(runLookup('pinned.example', { all: false, family: 0 })).toEqual([
        [null, PUBLIC_IPV6, 6],
      ]);
    });

    it('filters a refreshed answer by family too', async () => {
      mockResolve4.mockResolvedValue([PUBLIC_IPV4]);

      const calls = await runLookupAsync('unpinned.example', { all: false, family: 6 });

      expect(refusalOf(calls).message).toContain('no checked IPv6 address');
    });
  });
});

describe('upstreamDispatcherFor', () => {
  beforeEach(() => {
    clearUpstreamConnectionCache();
    mockResolve4.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refuses an empty address list', () => {
    expect(() => upstreamDispatcherFor('pinned.example', [], checkExpiry())).toThrow(
      UpstreamAddressUnverifiedError
    );
  });

  it.each(['10.1.2.3', '127.0.0.1', '169.254.169.254', 'fd00::1'])(
    'refuses the non-public address %s',
    address => {
      expect(() =>
        upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4, address], checkExpiry())
      ).toThrow(UpstreamAddressUnverifiedError);
    }
  );

  it('returns the same dispatcher for the same host and another for another host', () => {
    const first = upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4], checkExpiry());
    const again = upstreamDispatcherFor('PINNED.example.', [PUBLIC_IPV4], checkExpiry());
    const other = upstreamDispatcherFor('other.example', [PUBLIC_IPV4], checkExpiry());

    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });

  it('closes the oldest dispatcher when the pool passes its bound', () => {
    const closeSpy = jest.spyOn(Agent.prototype, 'close');

    const oldest = upstreamDispatcherFor('h0.example', [PUBLIC_IPV4], checkExpiry());
    for (let index = 1; index < 64; index += 1) {
      upstreamDispatcherFor(`h${index}.example`, [PUBLIC_IPV4], checkExpiry());
    }
    expect(closeSpy).not.toHaveBeenCalled();

    upstreamDispatcherFor('h64.example', [PUBLIC_IPV4], checkExpiry());

    // `close()` re-enters itself for its promise, so count the distinct agents.
    const closed = new Set(closeSpy.mock.contexts);
    expect(closed.size).toBe(1);
    expect(closed.has(oldest)).toBe(true);

    expect(runLookup('h64.example', { all: false })).toEqual([[null, PUBLIC_IPV4, 4]]);
  });

  it('returns the same agent instance on a repeated call', () => {
    const first = upstreamDispatcherFor('reuse.example', [PUBLIC_IPV4], checkExpiry());
    expect(upstreamDispatcherFor('reuse.example', [PUBLIC_IPV4], checkExpiry())).toBe(first);
  });

  it('evicts the pool unused longest when a host passes the bound after reuse', () => {
    const closeSpy = jest.spyOn(Agent.prototype, 'close');

    const reused = upstreamDispatcherFor('keep.example', [PUBLIC_IPV4], checkExpiry());
    for (let index = 1; index < 64; index += 1) {
      upstreamDispatcherFor(`h${index}.example`, [PUBLIC_IPV4], checkExpiry());
    }
    // Touch the kept host so its pool becomes the newest entry.
    expect(upstreamDispatcherFor('keep.example', [PUBLIC_IPV4], checkExpiry())).toBe(reused);

    upstreamDispatcherFor('h64.example', [PUBLIC_IPV4], checkExpiry());

    const closed = new Set(closeSpy.mock.contexts);
    expect(closed.size).toBe(1);
    expect(closed.has(reused)).toBe(false);
    expect(runLookup('keep.example', { all: false })).toEqual([[null, PUBLIC_IPV4, 4]]);
  });
});

describe('pinned connections and fetch', () => {
  beforeEach(() => {
    clearUpstreamConnectionCache();
    mockResolve4.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fails the fetch with the unverified code when the refresh cannot verify the host', async () => {
    const dispatcher = upstreamDispatcherFor('pinned.example', [PUBLIC_IPV4], checkExpiry());
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    mockResolve4.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

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
