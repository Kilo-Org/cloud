import { Resolver } from 'node:dns/promises';
import { captureMessage } from '@sentry/nextjs';
import {
  clearUpstreamUrlPolicyCache,
  findUpstreamUrlViolation,
  isUpstreamUrlPolicyEnforced,
  rejectDisallowedUpstreamUrls,
  type ResolveHostAddresses,
  type UpstreamUrlViolation,
} from './upstream-url-policy';

jest.mock('node:dns/promises', () => ({ Resolver: jest.fn() }));

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

function resolvesTo(...addresses: string[]) {
  return jest.fn(async (_hostname: string, _signal: AbortSignal) => addresses);
}

function neverResolves() {
  return jest.fn((_hostname: string, _signal: AbortSignal) => new Promise<string[]>(() => {}));
}

function after(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function dnsError(code: string): Error {
  return Object.assign(new Error(`queryA ${code}`), { code });
}

function check(url: string, resolveHostAddresses: ResolveHostAddresses, signal?: AbortSignal) {
  return findUpstreamUrlViolation(url, { resolveHostAddresses, signal });
}

function allowedUrl(hostname: string, addresses: string[]) {
  return { allowed: true, hostname, addresses, expiresAt: expect.any(Number) };
}

function rejectedUrl(violation: UpstreamUrlViolation) {
  return { allowed: false, violation };
}

type ResolverAnswers = {
  resolve4?: () => Promise<string[]>;
  resolve6?: () => Promise<string[]>;
};

/** Makes `new Resolver()` return a fake whose queries answer as given. */
function mockResolver({ resolve4, resolve6 }: ResolverAnswers) {
  const instance = {
    resolve4: jest.fn(resolve4 ?? (async () => [])),
    resolve6: jest.fn(resolve6 ?? (async () => [])),
    cancel: jest.fn(),
  };
  jest.mocked(Resolver).mockImplementation(function () {
    return instance;
  } as unknown as () => Resolver);
  return instance;
}

describe('findUpstreamUrlViolation', () => {
  beforeEach(() => {
    clearUpstreamUrlPolicyCache();
  });

  it('accepts an HTTPS URL whose host resolves only to public addresses', async () => {
    const resolve = resolvesTo('104.18.2.115', '2606:4700::6812:273');

    await expect(check('https://llm.example.com/v1/chat/completions', resolve)).resolves.toEqual(
      allowedUrl('llm.example.com', ['104.18.2.115', '2606:4700::6812:273'])
    );
    expect(resolve).toHaveBeenCalledWith('llm.example.com', expect.any(AbortSignal));
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
    ['https://[2002:7f00:1::]/v1', 'non_public_host'],
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

  it('does not retry an empty address list', async () => {
    const empty = resolvesTo();

    await expect(check('https://missing.example.com/v1', empty)).resolves.toEqual(
      rejectedUrl('dns_lookup_failed')
    );
    expect(empty).toHaveBeenCalledTimes(1);
  });

  it('retries a failure that is not a definitive no-records answer once', async () => {
    const failing = jest.fn(async (_hostname: string, _signal: AbortSignal): Promise<string[]> => {
      throw new Error('getaddrinfo EAI_AGAIN');
    });
    await expect(check('https://broken.example.com/v1', failing)).resolves.toEqual(
      rejectedUrl('dns_lookup_failed')
    );
    expect(failing).toHaveBeenCalledTimes(2);

    const servfail = jest.fn(async (_hostname: string, _signal: AbortSignal): Promise<string[]> => {
      throw dnsError('ESERVFAIL');
    });
    await expect(check('https://servfail.example.com/v1', servfail)).resolves.toEqual(
      rejectedUrl('dns_lookup_failed')
    );
    expect(servfail).toHaveBeenCalledTimes(2);
  });

  it.each(['ENOTFOUND', 'ENODATA'])('does not retry a %s failure', async code => {
    const failing = jest.fn(async (_hostname: string, _signal: AbortSignal): Promise<string[]> => {
      throw dnsError(code);
    });

    await expect(check('https://missing.example.com/v1', failing)).resolves.toEqual(
      rejectedUrl('dns_lookup_failed')
    );
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('retries a resolver that throws before returning a promise', async () => {
    let calls = 0;
    const resolve = jest.fn((_hostname: string, _signal: AbortSignal): Promise<string[]> => {
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
    const resolve = resolvesTo('104.18.2.115').mockRejectedValueOnce(
      new Error('getaddrinfo EAI_AGAIN')
    );

    await expect(check('https://llm.example.com/v1', resolve)).resolves.toEqual(
      allowedUrl('llm.example.com', ['104.18.2.115'])
    );
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('resolves each validation on its own, without sharing a lookup', async () => {
    const resolve = resolvesTo('10.1.2.3');
    await expect(check('https://internal.example.com/v1', resolve)).resolves.toEqual(
      rejectedUrl('non_public_address')
    );

    const publicResolve = resolvesTo('104.18.2.115');
    await expect(check('https://internal.example.com/v1', publicResolve)).resolves.toEqual(
      allowedUrl('internal.example.com', ['104.18.2.115'])
    );
    expect(publicResolve).toHaveBeenCalledTimes(1);

    const stalled = neverResolves();
    const other = resolvesTo('104.18.3.5');
    const pending = check('https://stalled.example.com/v1', stalled);
    await expect(check('https://stalled.example.com/v1', other)).resolves.toEqual(
      allowedUrl('stalled.example.com', ['104.18.3.5'])
    );
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
    void pending;
  });

  it('reports dns_lookup_failed once the deadline passes for a stalled resolver', async () => {
    const resolve = neverResolves();
    const startedAt = performance.now();

    await expect(check('https://stalled.example.com/v1', resolve)).resolves.toEqual(
      rejectedUrl('dns_lookup_failed')
    );
    const elapsed = performance.now() - startedAt;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeGreaterThanOrEqual(4_900);
    expect(elapsed).toBeLessThan(6_500);
    const [, signal] = resolve.mock.calls[0];
    expect(signal.aborted).toBe(true);
  }, 15_000);

  it('reports dns_lookup_failed when the retry runs into the deadline', async () => {
    const resolve = jest
      .fn((_hostname: string, _signal: AbortSignal) => new Promise<string[]>(() => {}))
      .mockImplementationOnce(async () => {
        await after(4_800);
        throw new Error('getaddrinfo EAI_AGAIN');
      });
    const startedAt = performance.now();

    await expect(check('https://slow.example.com/v1', resolve)).resolves.toEqual(
      rejectedUrl('dns_lookup_failed')
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(performance.now() - startedAt).toBeLessThan(6_500);
  }, 15_000);

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

  it('rejects with the abort reason when the signal aborts between attempts', async () => {
    const controller = new AbortController();
    const reason = new Error('budget exceeded');
    const resolve = jest.fn(async (_hostname: string, _signal: AbortSignal): Promise<string[]> => {
      setTimeout(() => controller.abort(reason), 20);
      throw new Error('getaddrinfo EAI_AGAIN');
    });

    await expect(check('https://llm.example.com/v1', resolve, controller.signal)).rejects.toBe(
      reason
    );
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

  it('gives the resolver a signal that aborts when the caller aborts', async () => {
    const resolve = neverResolves();
    const controller = new AbortController();
    const pending = check('https://stalled.example.com/v1', resolve, controller.signal);
    await after(10);

    const [, signal] = resolve.mock.calls[0];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    const reason = new DOMException('client went away', 'AbortError');
    controller.abort(reason);

    expect(signal.aborted).toBe(true);
    await expect(pending).rejects.toBe(reason);
  });

  it('gives the resolver a deadline signal when the caller passes none', async () => {
    const resolve = resolvesTo('104.18.2.115');

    await check('https://llm.example.com/v1', resolve);

    const [, signal] = resolve.mock.calls[0];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('resolves each hostname separately', async () => {
    const resolve = jest.fn(async (hostname: string, _signal: AbortSignal) =>
      hostname === 'a.example.com' ? ['104.18.2.115'] : ['10.1.2.3']
    );

    await expect(
      Promise.all([
        check('https://a.example.com/v1', resolve),
        check('https://b.example.com/v1', resolve),
      ])
    ).resolves.toEqual([
      allowedUrl('a.example.com', ['104.18.2.115']),
      rejectedUrl('non_public_address'),
    ]);
  });

  it('returns the first checked addresses inside the TTL and re-resolves after it', async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const resolve = jest.fn(async (_hostname: string, _signal: AbortSignal) =>
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

  it('stamps an allowed decision with the check time plus the cache TTL', async () => {
    jest.useFakeTimers();
    try {
      const now = Date.now();

      await expect(check('https://llm.example.com/a', resolvesTo('104.18.2.115'))).resolves.toEqual(
        {
          allowed: true,
          hostname: 'llm.example.com',
          addresses: ['104.18.2.115'],
          expiresAt: now + 60_000,
        }
      );
      await expect(check('https://104.18.2.115/a', resolvesTo())).resolves.toMatchObject({
        expiresAt: now + 60_000,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns the original expiresAt on a cache hit', async () => {
    jest.useFakeTimers();
    try {
      const first = await check('https://llm.example.com/a', resolvesTo('104.18.2.115'));
      await jest.advanceTimersByTimeAsync(20_000);
      const second = await check('https://llm.example.com/b', resolvesTo('104.18.3.5'));

      if (!first.allowed || !second.allowed) throw new Error('expected allowed decisions');
      expect(second.addresses).toEqual(['104.18.2.115']);
      expect(second.expiresAt).toBe(first.expiresAt);
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

describe('the default resolver', () => {
  beforeEach(() => {
    clearUpstreamUrlPolicyCache();
    jest.mocked(Resolver).mockReset();
  });

  it('creates a resolver with bounded query timeouts', async () => {
    mockResolver({ resolve4: async () => ['104.18.2.115'] });

    await findUpstreamUrlViolation('https://llm.example.com/v1');

    expect(Resolver).toHaveBeenCalledWith({ timeout: 1_000, tries: 2 });
  });

  it('merges the A and AAAA answers', async () => {
    const resolver = mockResolver({
      resolve4: async () => ['104.18.2.115'],
      resolve6: async () => ['2606:4700::6812:273'],
    });

    await expect(findUpstreamUrlViolation('https://llm.example.com/v1')).resolves.toEqual(
      allowedUrl('llm.example.com', ['104.18.2.115', '2606:4700::6812:273'])
    );
    expect(resolver.resolve4).toHaveBeenCalledWith('llm.example.com');
    expect(resolver.resolve6).toHaveBeenCalledWith('llm.example.com');
  });

  it('rejects when the AAAA answer holds a non-public address', async () => {
    mockResolver({
      resolve4: async () => ['104.18.2.115'],
      resolve6: async () => ['fd00::1'],
    });

    await expect(findUpstreamUrlViolation('https://llm.example.com/v1')).resolves.toEqual(
      rejectedUrl('non_public_address')
    );
  });

  it('succeeds when only the A query answers', async () => {
    mockResolver({
      resolve4: async () => ['104.18.2.115'],
      resolve6: async () => Promise.reject(dnsError('ENODATA')),
    });

    await expect(findUpstreamUrlViolation('https://llm.example.com/v1')).resolves.toEqual(
      allowedUrl('llm.example.com', ['104.18.2.115'])
    );
  });

  it('succeeds when only the AAAA query answers', async () => {
    mockResolver({
      resolve4: async () => Promise.reject(dnsError('ENODATA')),
      resolve6: async () => ['2606:4700::6812:273'],
    });

    await expect(findUpstreamUrlViolation('https://llm.example.com/v1')).resolves.toEqual(
      allowedUrl('llm.example.com', ['2606:4700::6812:273'])
    );
  });

  it('reports dns_lookup_failed without a retry when both queries answer ENODATA', async () => {
    mockResolver({
      resolve4: async () => Promise.reject(dnsError('ENODATA')),
      resolve6: async () => Promise.reject(dnsError('ENODATA')),
    });

    await expect(findUpstreamUrlViolation('https://missing.example.com/v1')).resolves.toEqual(
      rejectedUrl('dns_lookup_failed')
    );
    expect(Resolver).toHaveBeenCalledTimes(1);
  });

  it('reports dns_lookup_failed without a retry when both queries answer empty lists', async () => {
    mockResolver({});

    await expect(findUpstreamUrlViolation('https://empty.example.com/v1')).resolves.toEqual(
      rejectedUrl('dns_lookup_failed')
    );
    expect(Resolver).toHaveBeenCalledTimes(1);
  });

  it('retries once when a query fails transiently and none answered', async () => {
    mockResolver({
      resolve4: async () => Promise.reject(dnsError('ENODATA')),
      resolve6: async () => Promise.reject(dnsError('ESERVFAIL')),
    });

    await expect(findUpstreamUrlViolation('https://flaky.example.com/v1')).resolves.toEqual(
      rejectedUrl('dns_lookup_failed')
    );
    expect(Resolver).toHaveBeenCalledTimes(2);
  });

  it('cancels the queries when the caller aborts', async () => {
    const resolver = mockResolver({
      resolve4: () => new Promise<string[]>(() => {}),
      resolve6: () => new Promise<string[]>(() => {}),
    });
    const controller = new AbortController();
    const reason = new DOMException('client went away', 'AbortError');
    const pending = findUpstreamUrlViolation('https://stalled.example.com/v1', {
      signal: controller.signal,
    });
    await after(10);
    expect(resolver.cancel).not.toHaveBeenCalled();

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(resolver.cancel).toHaveBeenCalledTimes(1);
  });

  it('does not create a resolver when the signal has already aborted', async () => {
    mockResolver({ resolve4: async () => ['104.18.2.115'] });
    const reason = new Error('budget exceeded');

    await expect(
      findUpstreamUrlViolation('https://llm.example.com/v1', { signal: AbortSignal.abort(reason) })
    ).rejects.toBe(reason);
    expect(Resolver).not.toHaveBeenCalled();
  });
});

describe('rejectDisallowedUpstreamUrls', () => {
  beforeEach(() => {
    clearUpstreamUrlPolicyCache();
    jest.mocked(Resolver).mockReset();
    jest.mocked(captureMessage).mockReset();
  });

  it('returns the dialled URL with its checked addresses and their expiry', async () => {
    jest.mocked(Resolver).mockImplementation(function () {
      return {
        resolve4: jest.fn(async (name: string) => [
          name === 'second.example.com' ? '104.18.3.5' : '104.18.2.115',
        ]),
        resolve6: jest.fn(async () => []),
        cancel: jest.fn(),
      };
    } as unknown as () => Resolver);

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
        expiresAt: expect.any(Number),
      },
    });
  });

  it('returns the response for the first violating URL with its host', async () => {
    mockResolver({ resolve4: async () => ['10.1.2.3'] });

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
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_TARGET_ENV: process.env.VERCEL_TARGET_ENV,
  };

  function setEnv(name: keyof typeof original, value: string | undefined) {
    const env: Record<string, string | undefined> = process.env;
    if (value === undefined) delete env[name];
    else env[name] = value;
  }

  afterEach(() => {
    setEnv('NODE_ENV', original.NODE_ENV);
    setEnv('VERCEL_TARGET_ENV', original.VERCEL_TARGET_ENV);
  });

  it.each([
    ['production', true],
    [undefined, true],
    ['development', false],
    ['test', false],
  ])('NODE_ENV=%s enforces the policy: %s', (nodeEnv, enforced) => {
    setEnv('NODE_ENV', nodeEnv);

    expect(isUpstreamUrlPolicyEnforced()).toBe(enforced);
  });

  it('enforces the policy on a preview deployment', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('VERCEL_TARGET_ENV', 'preview');

    expect(isUpstreamUrlPolicyEnforced()).toBe(true);
  });

  it('ignores VERCEL_TARGET_ENV', () => {
    setEnv('NODE_ENV', 'test');
    setEnv('VERCEL_TARGET_ENV', 'production');

    expect(isUpstreamUrlPolicyEnforced()).toBe(false);
  });
});
