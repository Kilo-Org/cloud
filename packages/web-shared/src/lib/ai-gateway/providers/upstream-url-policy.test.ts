import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { captureMessage } from '@sentry/nextjs';
import {
  clearUpstreamUrlPolicyCache,
  findUpstreamUrlViolation,
  isUpstreamUrlPolicyEnforced,
  rejectDisallowedUpstreamUrls,
  type ResolveHostAddresses,
  type UpstreamUrlViolation,
} from './upstream-url-policy';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

function resolvesTo(...addresses: string[]) {
  return jest.fn(async (_hostname: string) => addresses);
}

function neverResolves() {
  return jest.fn((_hostname: string) => new Promise<string[]>(() => {}));
}

function pendingResolution() {
  const { promise, resolve } = Promise.withResolvers<string[]>();
  const resolveHostAddresses = jest.fn((_hostname: string) => promise);
  return { resolveHostAddresses, resolve };
}

function after(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function check(url: string, resolveHostAddresses: ResolveHostAddresses, signal?: AbortSignal) {
  return findUpstreamUrlViolation(url, { resolveHostAddresses, signal });
}

function allowedUrl(hostname: string, addresses: string[]) {
  return { allowed: true, hostname, addresses };
}

function rejectedUrl(violation: UpstreamUrlViolation) {
  return { allowed: false, violation };
}

type LookupAll = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;

// The policy awaits the `{ all: true }` overload, so the mock is typed for that
// one; `jest.mocked` would otherwise pick a single-address overload.
const lookupMock = jest.mocked(lookup as unknown as LookupAll);

describe('findUpstreamUrlViolation', () => {
  beforeEach(() => {
    clearUpstreamUrlPolicyCache();
  });

  it('accepts an HTTPS URL whose host resolves only to public addresses', async () => {
    const resolve = resolvesTo('104.18.2.115', '2606:4700::6812:273');

    await expect(check('https://llm.example.com/v1/chat/completions', resolve)).resolves.toEqual(
      allowedUrl('llm.example.com', ['104.18.2.115', '2606:4700::6812:273'])
    );
    expect(resolve).toHaveBeenCalledWith('llm.example.com');
  });

  it.each<[string, UpstreamUrlViolation]>([
    ['http://llm.example.com/v1', 'non_https'],
    ['ftp://llm.example.com/v1', 'non_https'],
    ['not a url', 'invalid_url'],
    ['https://localhost/v1', 'non_public_host'],
    ['https://LOCALHOST./v1', 'non_public_host'],
    ['https://api.localhost/v1', 'non_public_host'],
    ['https://127.0.0.1/v1', 'non_public_host'],
    ['https://2130706433/v1', 'non_public_host'],
    ['https://0x7f.1/v1', 'non_public_host'],
    ['https://10.0.0.5/v1', 'non_public_host'],
    ['https://169.254.169.254/latest/meta-data', 'non_public_host'],
    ['https://[::1]/v1', 'non_public_host'],
    ['https://[::ffff:127.0.0.1]/v1', 'non_public_host'],
    ['https://[fd00::1]/v1', 'non_public_host'],
  ])('rejects %s as %s without resolving it', async (url, violation) => {
    const resolve = resolvesTo('104.18.2.115');

    await expect(check(url, resolve)).resolves.toEqual(rejectedUrl(violation));
    expect(resolve).not.toHaveBeenCalled();
  });

  it('accepts a public IP literal without resolving it', async () => {
    const resolve = resolvesTo();

    await expect(check('https://104.18.2.115/v1', resolve)).resolves.toEqual(
      allowedUrl('104.18.2.115', ['104.18.2.115'])
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a host when any resolved address is not public', async () => {
    await expect(
      check('https://internal.example.com/v1', resolvesTo('104.18.2.115', '10.1.2.3'))
    ).resolves.toEqual(rejectedUrl('non_public_address'));
  });

  it('rejects a host that still does not resolve after one retry', async () => {
    const empty = resolvesTo();
    await expect(check('https://missing.example.com/v1', empty)).resolves.toEqual(
      rejectedUrl('dns_lookup_failed')
    );
    expect(empty).toHaveBeenCalledTimes(2);

    const failing = jest.fn(async (_hostname: string): Promise<string[]> => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    await expect(check('https://broken.example.com/v1', failing)).resolves.toEqual(
      rejectedUrl('dns_lookup_failed')
    );
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('retries a resolver that throws before returning a promise', async () => {
    let calls = 0;
    const resolve = jest.fn((_hostname: string): Promise<string[]> => {
      calls += 1;
      if (calls === 1) throw new Error('getaddrinfo EAI_AGAIN');
      return Promise.resolve(['104.18.2.115']);
    });

    await expect(check('https://llm.example.com/v1', resolve)).resolves.toEqual(
      allowedUrl('llm.example.com', ['104.18.2.115'])
    );
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('accepts a host whose first lookup fails transiently', async () => {
    const resolve = jest
      .fn(async (_hostname: string) => ['104.18.2.115'])
      .mockRejectedValueOnce(new Error('getaddrinfo EAI_AGAIN'));

    await expect(check('https://llm.example.com/v1', resolve)).resolves.toEqual(
      allowedUrl('llm.example.com', ['104.18.2.115'])
    );
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('reports dns_lookup_failed after one deadline for a stalled resolver', async () => {
    const resolve = neverResolves();
    const startedAt = performance.now();

    await expect(check('https://stalled.example.com/v1', resolve)).resolves.toEqual(
      rejectedUrl('dns_lookup_failed')
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  }, 10_000);

  it('keeps a single attempt when the resolution settles after its deadline', async () => {
    const resolve = jest.fn(async (_hostname: string) => {
      await after(2_600);
      return ['104.18.2.115'];
    });

    await expect(check('https://late.example.com/v1', resolve)).resolves.toEqual(
      rejectedUrl('dns_lookup_failed')
    );
    await after(1_000);
    expect(resolve).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('rejects with the abort reason as soon as the signal aborts during a lookup', async () => {
    const resolve = neverResolves();
    const controller = new AbortController();
    const reason = new DOMException('client went away', 'AbortError');
    const pending = check('https://stalled.example.com/v1', resolve, controller.signal);

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    await after(200);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('does not start a lookup when the signal has already aborted', async () => {
    const resolve = resolvesTo('104.18.2.115');
    const reason = new Error('budget exceeded');

    await expect(
      check('https://llm.example.com/v1', resolve, AbortSignal.abort(reason))
    ).rejects.toBe(reason);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('applies each caller its own deadline to a shared resolution', async () => {
    const stalled = neverResolves();
    const startedAt = performance.now();

    const verdicts = await Promise.all([
      check('https://pending.example.com/v1', stalled),
      check('https://pending.example.com/v1', stalled),
      check('https://pending.example.com/v1', stalled),
    ]);

    expect(verdicts).toEqual([
      rejectedUrl('dns_lookup_failed'),
      rejectedUrl('dns_lookup_failed'),
      rejectedUrl('dns_lookup_failed'),
    ]);
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  }, 10_000);

  it('submits one lookup across several caller deadlines', async () => {
    const resolve = neverResolves();

    const verdicts = [];
    for (const _ of [0, 1, 2]) {
      verdicts.push(await check('https://stalled.example.com/v1', resolve));
    }

    expect(verdicts).toEqual([
      rejectedUrl('dns_lookup_failed'),
      rejectedUrl('dns_lookup_failed'),
      rejectedUrl('dns_lookup_failed'),
    ]);
    expect(resolve).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('fails fast once the process runs the maximum number of lookups', async () => {
    const first = pendingResolution();
    const second = pendingResolution();
    const third = neverResolves();

    const outstanding = [
      check('https://a.example.com/v1', first.resolveHostAddresses),
      check('https://b.example.com/v1', second.resolveHostAddresses),
    ];
    await after(10);

    const startedAt = performance.now();
    await expect(check('https://c.example.com/v1', third)).resolves.toEqual(
      rejectedUrl('dns_lookup_failed')
    );
    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(third).not.toHaveBeenCalled();

    first.resolve(['104.18.2.115']);
    second.resolve(['104.18.2.115']);
    await expect(Promise.all(outstanding)).resolves.toEqual([
      allowedUrl('a.example.com', ['104.18.2.115']),
      allowedUrl('b.example.com', ['104.18.2.115']),
    ]);
  });

  it('keeps lookup capacity when the settle deadline forgets the entry before the resolver settles', async () => {
    jest.useFakeTimers();
    try {
      const first = pendingResolution();
      const second = pendingResolution();
      const third = neverResolves();

      const pending = Promise.all([
        check('https://a.example.com/v1', first.resolveHostAddresses),
        check('https://b.example.com/v1', second.resolveHostAddresses),
      ]);
      await jest.advanceTimersByTimeAsync(10);
      expect(first.resolveHostAddresses).toHaveBeenCalledTimes(1);
      expect(second.resolveHostAddresses).toHaveBeenCalledTimes(1);

      // The settle deadline stops further reuse of the two entries, and each
      // resolver keeps its place in the limit until it settles.
      await jest.advanceTimersByTimeAsync(30_000);

      await expect(check('https://c.example.com/v1', third)).resolves.toEqual(
        rejectedUrl('dns_lookup_failed')
      );
      expect(third).not.toHaveBeenCalled();

      first.resolve(['104.18.2.115']);
      second.resolve(['104.18.2.115']);
      await expect(pending).resolves.toEqual([
        allowedUrl('a.example.com', ['104.18.2.115']),
        allowedUrl('b.example.com', ['104.18.2.115']),
      ]);

      // A settled resolver releases its capacity for the next host.
      const fourth = resolvesTo('104.18.2.115');
      await expect(check('https://d.example.com/v1', fourth)).resolves.toEqual(
        allowedUrl('d.example.com', ['104.18.2.115'])
      );
      expect(fourth).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  }, 10_000);

  it('keeps the shared resolution when the only caller aborts', async () => {
    const { resolveHostAddresses, resolve } = pendingResolution();
    const controller = new AbortController();
    const reason = new DOMException('client went away', 'AbortError');

    const aborted = check(
      'https://stalled.example.com/v1',
      resolveHostAddresses,
      controller.signal
    );
    await after(10);
    controller.abort(reason);
    await expect(aborted).rejects.toBe(reason);

    // The next validation waits on the same pending lookup.
    const next = check('https://stalled.example.com/v1', resolveHostAddresses);
    await after(10);
    expect(resolveHostAddresses).toHaveBeenCalledTimes(1);

    resolve(['104.18.2.115']);
    await expect(next).resolves.toEqual(allowedUrl('stalled.example.com', ['104.18.2.115']));
  });

  it('keeps one lookup when a resolution settles after its callers finished', async () => {
    const stalled = Promise.withResolvers<string[]>();
    const resolve = jest.fn((_hostname: string): Promise<string[]> => stalled.promise);

    await expect(check('https://stalled.example.com/v1', resolve)).resolves.toEqual(
      rejectedUrl('dns_lookup_failed')
    );

    // The next validation waits on the same pending lookup.
    const second = check('https://stalled.example.com/v1', resolve);
    await after(10);
    expect(resolve).toHaveBeenCalledTimes(1);

    stalled.resolve(['104.18.2.115']);
    await expect(second).resolves.toEqual(allowedUrl('stalled.example.com', ['104.18.2.115']));
  }, 10_000);

  it('starts a new lookup once the shared one settles', async () => {
    const first = Promise.withResolvers<string[]>();
    const second = Promise.withResolvers<string[]>();
    let calls = 0;
    const resolve = jest.fn((_hostname: string): Promise<string[]> => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    });

    const pendingFirst = check('https://internal.example.com/v1', resolve);
    await after(10);
    first.resolve(['10.1.2.3']);
    await expect(pendingFirst).resolves.toEqual(rejectedUrl('non_public_address'));

    const pendingSecond = check('https://internal.example.com/v1', resolve);
    await after(10);
    expect(resolve).toHaveBeenCalledTimes(2);

    second.resolve(['104.18.2.115']);
    await expect(pendingSecond).resolves.toEqual(
      allowedUrl('internal.example.com', ['104.18.2.115'])
    );
  });

  it('keeps a shared resolution for a caller that outlives the first deadline', async () => {
    const { resolveHostAddresses, resolve } = pendingResolution();

    const first = check('https://pending.example.com/v1', resolveHostAddresses);
    await after(1_500);
    const second = check('https://pending.example.com/v1', resolveHostAddresses);

    await expect(first).resolves.toEqual(rejectedUrl('dns_lookup_failed'));
    resolve(['104.18.2.115']);
    await expect(second).resolves.toEqual(allowedUrl('pending.example.com', ['104.18.2.115']));
    expect(resolveHostAddresses).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('resolves again for a later validation after the resolution settled', async () => {
    const privateResolve = resolvesTo('10.1.2.3');
    await expect(check('https://internal.example.com/v1', privateResolve)).resolves.toEqual(
      rejectedUrl('non_public_address')
    );

    const publicResolve = resolvesTo('104.18.2.115');
    await expect(check('https://internal.example.com/v1', publicResolve)).resolves.toEqual(
      allowedUrl('internal.example.com', ['104.18.2.115'])
    );
    expect(publicResolve).toHaveBeenCalledWith('internal.example.com');
  });

  it('shares one resolution among validations of the same host that overlap', async () => {
    const { resolveHostAddresses, resolve } = pendingResolution();

    const pending = Promise.all(
      [0, 1, 2, 3, 4].map(() => check('https://llm.example.com/v1', resolveHostAddresses))
    );
    await after(10);
    expect(resolveHostAddresses).toHaveBeenCalledTimes(1);

    resolve(['104.18.2.115']);
    await expect(pending).resolves.toEqual(
      Array.from({ length: 5 }, () => allowedUrl('llm.example.com', ['104.18.2.115']))
    );
    expect(resolveHostAddresses).toHaveBeenCalledTimes(1);
    expect(resolveHostAddresses).toHaveBeenCalledWith('llm.example.com');
  });

  it('keeps the shared resolution for the callers that remain when one caller stops', async () => {
    const { resolveHostAddresses, resolve } = pendingResolution();
    const controller = new AbortController();
    const reason = new DOMException('client went away', 'AbortError');

    const aborted = check('https://llm.example.com/v1', resolveHostAddresses, controller.signal);
    const other = check('https://llm.example.com/v1', resolveHostAddresses);

    controller.abort(reason);
    await expect(aborted).rejects.toBe(reason);
    expect(resolveHostAddresses).toHaveBeenCalledTimes(1);

    resolve(['104.18.2.115']);
    await expect(other).resolves.toEqual(allowedUrl('llm.example.com', ['104.18.2.115']));
  });

  it('retries once for overlapping validations of a host whose resolution fails once', async () => {
    const resolve = jest.fn(async (_hostname: string): Promise<string[]> => {
      await after(0);
      throw new Error('getaddrinfo EAI_AGAIN');
    });

    const verdicts = await Promise.all(
      [0, 1, 2, 3].map(() => check('https://broken.example.com/v1', resolve))
    );

    expect(verdicts).toEqual(Array.from({ length: 4 }, () => rejectedUrl('dns_lookup_failed')));
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('resolves each hostname separately', async () => {
    const first = pendingResolution();
    const second = pendingResolution();

    const pending = Promise.all([
      check('https://a.example.com/v1', first.resolveHostAddresses),
      check('https://b.example.com/v1', second.resolveHostAddresses),
    ]);
    await after(10);
    expect(first.resolveHostAddresses).toHaveBeenCalledTimes(1);
    expect(second.resolveHostAddresses).toHaveBeenCalledTimes(1);

    first.resolve(['104.18.2.115']);
    second.resolve(['10.1.2.3']);
    await expect(pending).resolves.toEqual([
      allowedUrl('a.example.com', ['104.18.2.115']),
      rejectedUrl('non_public_address'),
    ]);
  });

  it('returns the first checked addresses inside the TTL and re-resolves after it', async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const resolve = jest.fn(async (_hostname: string) =>
        calls++ === 0 ? ['104.18.2.115'] : ['104.18.3.5']
      );

      await expect(check('https://llm.example.com/a', resolve)).resolves.toEqual(
        allowedUrl('llm.example.com', ['104.18.2.115'])
      );
      // The resolver would answer 104.18.3.5 now; the cache still returns the
      // first checked list, and the resolver is not asked again.
      await expect(check('https://llm.example.com/b', resolve)).resolves.toEqual(
        allowedUrl('llm.example.com', ['104.18.2.115'])
      );
      expect(resolve).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(60_001);

      await expect(check('https://llm.example.com/c', resolve)).resolves.toEqual(
        allowedUrl('llm.example.com', ['104.18.3.5'])
      );
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('hands out a copy of the checked list, so a caller cannot change the cache', async () => {
    const resolve = resolvesTo('104.18.2.115');

    const first = await check('https://llm.example.com/a', resolve);
    expect(first).toEqual(allowedUrl('llm.example.com', ['104.18.2.115']));
    if (!first.allowed) throw new Error('expected an allowed decision');
    first.addresses.push('10.1.2.3');

    await expect(check('https://llm.example.com/b', resolve)).resolves.toEqual(
      allowedUrl('llm.example.com', ['104.18.2.115'])
    );
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('reuses a checked address list but re-resolves a rejected host', async () => {
    const publicResolve = resolvesTo('104.18.2.115');
    await check('https://llm.example.com/a', publicResolve);
    await check('https://llm.example.com/b', publicResolve);
    expect(publicResolve).toHaveBeenCalledTimes(1);

    const privateResolve = resolvesTo('10.1.2.3');
    await check('https://internal.example.com/a', privateResolve);
    await check('https://internal.example.com/b', privateResolve);
    expect(privateResolve).toHaveBeenCalledTimes(2);
  });
});

describe('rejectDisallowedUpstreamUrls', () => {
  beforeEach(() => {
    clearUpstreamUrlPolicyCache();
    lookupMock.mockReset();
    jest.mocked(captureMessage).mockReset();
  });

  it('returns the allowed URLs with their checked addresses in order', async () => {
    lookupMock.mockImplementation(async hostname => [
      { address: hostname === 'second.example.com' ? '104.18.3.5' : '104.18.2.115', family: 4 },
    ]);

    await expect(
      rejectDisallowedUpstreamUrls({
        urls: ['https://first.example.com/v1', 'https://second.example.com/v1'],
        providerId: 'custom',
        vercelRequestId: 'fra1::abc',
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({
      rejected: null,
      dialed: {
        url: 'https://first.example.com/v1',
        hostname: 'first.example.com',
        addresses: ['104.18.2.115'],
      },
      relayed: [
        {
          url: 'https://second.example.com/v1',
          hostname: 'second.example.com',
          addresses: ['104.18.3.5'],
        },
      ],
    });
  });

  it('returns the response for the first violating URL with its host', async () => {
    lookupMock.mockImplementation(async () => [{ address: '10.1.2.3', family: 4 }]);

    const result = await rejectDisallowedUpstreamUrls({
      urls: ['https://first.example.com/v1', 'https://second.example.com/v1'],
      providerId: 'custom',
      vercelRequestId: 'fra1::abc',
      signal: new AbortController().signal,
    });

    if (!result.rejected) throw new Error('expected a rejection');

    expect(result.rejected.status).toBe(502);
    const body = await result.rejected.json();
    expect(body.error).toContain('resolves to a non-public address');
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      'AI gateway upstream URL rejected',
      expect.objectContaining({
        extra: expect.objectContaining({ targetHost: 'first.example.com' }),
      })
    );
  });
});

describe('isUpstreamUrlPolicyEnforced', () => {
  const originalTargetEnv = process.env.VERCEL_TARGET_ENV;

  afterEach(() => {
    if (originalTargetEnv === undefined) delete process.env.VERCEL_TARGET_ENV;
    else process.env.VERCEL_TARGET_ENV = originalTargetEnv;
  });

  it.each([
    ['staging', true],
    ['production', true],
    ['preview', false],
    ['development', false],
    [undefined, false],
  ])('VERCEL_TARGET_ENV=%s enforces the policy: %s', (targetEnv, enforced) => {
    if (targetEnv === undefined) delete process.env.VERCEL_TARGET_ENV;
    else process.env.VERCEL_TARGET_ENV = targetEnv;

    expect(isUpstreamUrlPolicyEnforced()).toBe(enforced);
  });
});
