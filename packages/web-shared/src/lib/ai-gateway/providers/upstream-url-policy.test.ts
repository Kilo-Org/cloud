import {
  clearUpstreamUrlPolicyCache,
  findUpstreamUrlViolation,
  isUpstreamUrlPolicyEnforced,
} from './upstream-url-policy';

function resolvesTo(...addresses: string[]) {
  return jest.fn(async (_hostname: string) => addresses);
}

describe('findUpstreamUrlViolation', () => {
  beforeEach(() => {
    clearUpstreamUrlPolicyCache();
  });

  it('accepts an HTTPS URL whose host resolves only to public addresses', async () => {
    const resolve = resolvesTo('104.18.2.115', '2606:4700::6812:273');

    await expect(
      findUpstreamUrlViolation('https://llm.example.com/v1/chat/completions', resolve)
    ).resolves.toBeNull();
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
    ['https://10.0.0.5/v1', 'non_public_host'],
    ['https://169.254.169.254/latest/meta-data', 'non_public_host'],
    ['https://[::1]/v1', 'non_public_host'],
    ['https://[::ffff:127.0.0.1]/v1', 'non_public_host'],
    ['https://[fd00::1]/v1', 'non_public_host'],
  ])('rejects %s as %s without resolving it', async (url, violation) => {
    const resolve = resolvesTo('104.18.2.115');

    await expect(findUpstreamUrlViolation(url, resolve)).resolves.toBe(violation);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('accepts a public IP literal without resolving it', async () => {
    const resolve = resolvesTo();

    await expect(findUpstreamUrlViolation('https://104.18.2.115/v1', resolve)).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a host when any resolved address is not public', async () => {
    await expect(
      findUpstreamUrlViolation(
        'https://internal.example.com/v1',
        resolvesTo('104.18.2.115', '10.1.2.3')
      )
    ).resolves.toBe('non_public_address');
  });

  it('rejects a host that does not resolve', async () => {
    await expect(
      findUpstreamUrlViolation('https://missing.example.com/v1', resolvesTo())
    ).resolves.toBe('dns_lookup_failed');
    await expect(
      findUpstreamUrlViolation(
        'https://broken.example.com/v1',
        jest.fn(async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        })
      )
    ).resolves.toBe('dns_lookup_failed');
  });

  it('reuses a public verdict but re-resolves a rejected host', async () => {
    const publicResolve = resolvesTo('104.18.2.115');
    await findUpstreamUrlViolation('https://llm.example.com/a', publicResolve);
    await findUpstreamUrlViolation('https://llm.example.com/b', publicResolve);
    expect(publicResolve).toHaveBeenCalledTimes(1);

    const privateResolve = resolvesTo('10.1.2.3');
    await findUpstreamUrlViolation('https://internal.example.com/a', privateResolve);
    await findUpstreamUrlViolation('https://internal.example.com/b', privateResolve);
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
    ['production', true],
    ['staging', false],
    ['preview', false],
    [undefined, false],
  ])('VERCEL_TARGET_ENV=%s enforces the policy: %s', (targetEnv, enforced) => {
    if (targetEnv === undefined) delete process.env.VERCEL_TARGET_ENV;
    else process.env.VERCEL_TARGET_ENV = targetEnv;

    expect(isUpstreamUrlPolicyEnforced()).toBe(enforced);
  });
});
