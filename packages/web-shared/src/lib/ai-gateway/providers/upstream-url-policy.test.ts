import {
  clearUpstreamUrlPolicyCache,
  findUpstreamUrlViolation,
  isUpstreamUrlPolicyEnforced,
  type ResolveHostAddresses,
} from './upstream-url-policy';

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

describe('findUpstreamUrlViolation', () => {
  beforeEach(() => {
    clearUpstreamUrlPolicyCache();
  });

  it('accepts an HTTPS URL whose host resolves only to public addresses', async () => {
    const resolve = resolvesTo('104.18.2.115', '2606:4700::6812:273');

    await expect(check('https://llm.example.com/v1/chat/completions', resolve)).resolves.toBeNull();
    expect(resolve).toHaveBeenCalledWith('llm.example.com');
  });

  it.each([
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

    await expect(check(url, resolve)).resolves.toBe(violation);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('accepts a public IP literal without resolving it', async () => {
    const resolve = resolvesTo();

    await expect(check('https://104.18.2.115/v1', resolve)).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a host when any resolved address is not public', async () => {
    await expect(
      check('https://internal.example.com/v1', resolvesTo('104.18.2.115', '10.1.2.3'))
    ).resolves.toBe('non_public_address');
  });

  it('rejects a host that still does not resolve after one retry', async () => {
    const empty = resolvesTo();
    await expect(check('https://missing.example.com/v1', empty)).resolves.toBe('dns_lookup_failed');
    expect(empty).toHaveBeenCalledTimes(2);

    const failing = jest.fn(async (_hostname: string): Promise<string[]> => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    await expect(check('https://broken.example.com/v1', failing)).resolves.toBe(
      'dns_lookup_failed'
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

    await expect(check('https://llm.example.com/v1', resolve)).resolves.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('accepts a host whose first lookup fails transiently', async () => {
    const resolve = jest
      .fn(async (_hostname: string) => ['104.18.2.115'])
      .mockRejectedValueOnce(new Error('getaddrinfo EAI_AGAIN'));

    await expect(check('https://llm.example.com/v1', resolve)).resolves.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('reports dns_lookup_failed after one deadline for a stalled resolver', async () => {
    const resolve = neverResolves();
    const startedAt = performance.now();

    await expect(check('https://stalled.example.com/v1', resolve)).resolves.toBe(
      'dns_lookup_failed'
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  }, 10_000);

  it('keeps a single attempt when the resolution settles after its deadline', async () => {
    const resolve = jest.fn(async (_hostname: string) => {
      await after(2_600);
      return ['104.18.2.115'];
    });

    await expect(check('https://late.example.com/v1', resolve)).resolves.toBe('dns_lookup_failed');
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

    expect(verdicts).toEqual(['dns_lookup_failed', 'dns_lookup_failed', 'dns_lookup_failed']);
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  }, 10_000);

  it('resolves again after a stalled resolution outlives its deadline', async () => {
    let calls = 0;
    const resolve = jest.fn((_hostname: string): Promise<string[]> => {
      calls += 1;
      if (calls === 1) return new Promise<string[]>(() => {});
      return Promise.resolve(['104.18.2.115']);
    });

    await expect(check('https://stalled.example.com/v1', resolve)).resolves.toBe(
      'dns_lookup_failed'
    );
    await expect(check('https://stalled.example.com/v1', resolve)).resolves.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('resolves again after every caller of a stalled resolution aborts', async () => {
    let calls = 0;
    const resolve = jest.fn((_hostname: string): Promise<string[]> => {
      calls += 1;
      if (calls === 1) return new Promise<string[]>(() => {});
      return Promise.resolve(['104.18.2.115']);
    });
    const controller = new AbortController();
    const reason = new DOMException('client went away', 'AbortError');

    const aborted = check('https://stalled.example.com/v1', resolve, controller.signal);
    await after(10);
    controller.abort(reason);
    await expect(aborted).rejects.toBe(reason);

    // The aborted caller never reaches a deadline, so only the bounded
    // retention of the entry can free the host, one deadline after it started.
    await after(2_100);
    await expect(check('https://stalled.example.com/v1', resolve)).resolves.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('keeps a replacement resolution when the stalled one settles late', async () => {
    const stalled = Promise.withResolvers<string[]>();
    const replacement = Promise.withResolvers<string[]>();
    let calls = 0;
    const resolve = jest.fn((_hostname: string): Promise<string[]> => {
      calls += 1;
      return calls === 1 ? stalled.promise : replacement.promise;
    });

    await expect(check('https://stalled.example.com/v1', resolve)).resolves.toBe(
      'dns_lookup_failed'
    );

    const second = check('https://stalled.example.com/v1', resolve);
    await after(10);
    expect(resolve).toHaveBeenCalledTimes(2);

    stalled.resolve(['104.18.2.115']);
    await after(10);

    const third = check('https://stalled.example.com/v1', resolve);
    await after(10);
    expect(resolve).toHaveBeenCalledTimes(2);

    replacement.resolve(['104.18.2.115']);
    await expect(second).resolves.toBeNull();
    await expect(third).resolves.toBeNull();
  }, 10_000);

  it('keeps a shared resolution for a caller that outlives the first deadline', async () => {
    const { resolveHostAddresses, resolve } = pendingResolution();

    const first = check('https://pending.example.com/v1', resolveHostAddresses);
    await after(1_500);
    const second = check('https://pending.example.com/v1', resolveHostAddresses);

    await expect(first).resolves.toBe('dns_lookup_failed');
    resolve(['104.18.2.115']);
    await expect(second).resolves.toBeNull();
    expect(resolveHostAddresses).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('resolves again for a later validation after the resolution settled', async () => {
    const privateResolve = resolvesTo('10.1.2.3');
    await expect(check('https://internal.example.com/v1', privateResolve)).resolves.toBe(
      'non_public_address'
    );

    const publicResolve = resolvesTo('104.18.2.115');
    await expect(check('https://internal.example.com/v1', publicResolve)).resolves.toBeNull();
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
    await expect(pending).resolves.toEqual([null, null, null, null, null]);
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
    await expect(other).resolves.toBeNull();
  });

  it('retries once for overlapping validations of a host whose resolution fails once', async () => {
    const resolve = jest.fn(async (_hostname: string): Promise<string[]> => {
      await after(0);
      throw new Error('getaddrinfo EAI_AGAIN');
    });

    const verdicts = await Promise.all(
      [0, 1, 2, 3].map(() => check('https://broken.example.com/v1', resolve))
    );

    expect(verdicts).toEqual([
      'dns_lookup_failed',
      'dns_lookup_failed',
      'dns_lookup_failed',
      'dns_lookup_failed',
    ]);
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
    await expect(pending).resolves.toEqual([null, 'non_public_address']);
  });

  it('reuses a public verdict but re-resolves a rejected host', async () => {
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
