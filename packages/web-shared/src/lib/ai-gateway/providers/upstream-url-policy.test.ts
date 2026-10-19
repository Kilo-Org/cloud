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

  it('accepts a host whose first lookup fails transiently', async () => {
    const resolve = jest
      .fn(async (_hostname: string) => ['104.18.2.115'])
      .mockRejectedValueOnce(new Error('getaddrinfo EAI_AGAIN'));

    await expect(check('https://llm.example.com/v1', resolve)).resolves.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('gives up on a stalled resolver after a deadline per attempt', async () => {
    const resolve = neverResolves();
    const startedAt = performance.now();

    await expect(check('https://stalled.example.com/v1', resolve)).resolves.toBe(
      'dns_lookup_failed'
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(performance.now() - startedAt).toBeLessThan(6_000);
  }, 10_000);

  it('rejects with the abort reason as soon as the signal aborts during a lookup', async () => {
    const controller = new AbortController();
    const reason = new DOMException('client went away', 'AbortError');
    const pending = check('https://stalled.example.com/v1', neverResolves(), controller.signal);

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it('does not start a lookup when the signal has already aborted', async () => {
    const resolve = resolvesTo('104.18.2.115');
    const reason = new Error('budget exceeded');

    await expect(
      check('https://llm.example.com/v1', resolve, AbortSignal.abort(reason))
    ).rejects.toBe(reason);
    expect(resolve).not.toHaveBeenCalled();
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
    ['production', false],
    ['preview', false],
    ['development', false],
    [undefined, false],
  ])('VERCEL_TARGET_ENV=%s enforces the policy: %s', (targetEnv, enforced) => {
    if (targetEnv === undefined) delete process.env.VERCEL_TARGET_ENV;
    else process.env.VERCEL_TARGET_ENV = targetEnv;

    expect(isUpstreamUrlPolicyEnforced()).toBe(enforced);
  });
});
