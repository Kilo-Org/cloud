import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import {
  checkUpstreamUrl,
  clearUpstreamUrlPolicyCache,
  isUpstreamUrlPolicyEnforced,
  validatedUpstreamAddresses,
  type ResolveHostAddresses,
} from './upstream-url-policy';

function resolvesTo(...addresses: string[]) {
  return vi.fn(async (_hostname: string) => addresses);
}

function neverResolves() {
  return vi.fn((_hostname: string) => new Promise<string[]>(() => {}));
}

function check(url: string, resolveHostAddresses: ResolveHostAddresses, signal?: AbortSignal) {
  return checkUpstreamUrl(url, { resolveHostAddresses, signal });
}

async function violationOf(
  url: string,
  resolveHostAddresses: ResolveHostAddresses,
  signal?: AbortSignal
) {
  const verdict = await check(url, resolveHostAddresses, signal);
  return verdict.allowed ? null : verdict.violation;
}

describe('checkUpstreamUrl', () => {
  beforeEach(() => {
    clearUpstreamUrlPolicyCache();
  });

  it('accepts an HTTPS URL whose host resolves only to public addresses', async () => {
    const resolve = resolvesTo('104.18.2.115', '2606:4700::6812:273');

    await expect(check('https://llm.example.com/v1/chat/completions', resolve)).resolves.toEqual({
      allowed: true,
      hostname: 'llm.example.com',
      addresses: ['104.18.2.115', '2606:4700::6812:273'],
    });
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

    await expect(violationOf(url, resolve)).resolves.toBe(violation);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('accepts a public IP literal without resolving it', async () => {
    const resolve = resolvesTo();

    await expect(check('https://104.18.2.115/v1', resolve)).resolves.toEqual({
      allowed: true,
      hostname: '104.18.2.115',
      addresses: ['104.18.2.115'],
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a host when any resolved address is not public', async () => {
    await expect(
      violationOf('https://internal.example.com/v1', resolvesTo('104.18.2.115', '10.1.2.3'))
    ).resolves.toBe('non_public_address');
  });

  it('rejects a host that still does not resolve after one retry', async () => {
    const empty = resolvesTo();
    await expect(violationOf('https://missing.example.com/v1', empty)).resolves.toBe(
      'dns_lookup_failed'
    );
    expect(empty).toHaveBeenCalledTimes(2);

    const failing = vi.fn(async (_hostname: string): Promise<string[]> => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    await expect(violationOf('https://broken.example.com/v1', failing)).resolves.toBe(
      'dns_lookup_failed'
    );
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('accepts a host whose first lookup fails transiently', async () => {
    const resolve = vi
      .fn(async (_hostname: string) => ['104.18.2.115'])
      .mockRejectedValueOnce(new Error('getaddrinfo EAI_AGAIN'));

    await expect(violationOf('https://llm.example.com/v1', resolve)).resolves.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('gives up on a stalled resolver after a deadline per attempt', async () => {
    const resolve = neverResolves();
    const startedAt = performance.now();

    await expect(violationOf('https://stalled.example.com/v1', resolve)).resolves.toBe(
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
});

describe('the approved address window', () => {
  beforeEach(() => {
    clearUpstreamUrlPolicyCache();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses the addresses it approved for a host, then resolves the host again', async () => {
    const resolve = resolvesTo('104.18.2.115');
    await check('https://llm.example.com/a', resolve);
    await check('https://llm.example.com/b', resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(validatedUpstreamAddresses('llm.example.com')).toEqual(['104.18.2.115']);

    vi.setSystemTime(new Date('2026-10-20T00:01:01.000Z'));
    expect(validatedUpstreamAddresses('llm.example.com')).toBeNull();
    await check('https://llm.example.com/c', resolve);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('keeps a host rejected while its answer is not public', async () => {
    const resolve = resolvesTo('10.1.2.3');
    await check('https://internal.example.com/a', resolve);
    await check('https://internal.example.com/b', resolve);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(validatedUpstreamAddresses('internal.example.com')).toBeNull();
  });

  it('leaves one host unapproved when another host is checked', async () => {
    await check('https://llm.example.com/v1', resolvesTo('104.18.2.115'));

    expect(validatedUpstreamAddresses('other.example.com')).toBeNull();
  });

  it('re-checks a host once its approved window ends', async () => {
    const resolve = vi
      .fn(async (_hostname: string) => ['104.18.2.115'])
      .mockResolvedValueOnce(['104.18.2.115'])
      .mockResolvedValue(['169.254.169.254']);

    await expect(violationOf('https://rotation.example.com/v1', resolve)).resolves.toBeNull();
    expect(validatedUpstreamAddresses('rotation.example.com')).toEqual(['104.18.2.115']);

    vi.setSystemTime(new Date('2026-10-20T00:01:01.000Z'));
    await expect(violationOf('https://rotation.example.com/v1', resolve)).resolves.toBe(
      'non_public_address'
    );
    expect(validatedUpstreamAddresses('rotation.example.com')).toBeNull();
  });

  it('normalizes a trailing dot when looking up an approved host', async () => {
    await check('https://llm.example.com/v1', resolvesTo('104.18.2.115'));

    expect(validatedUpstreamAddresses('LLM.example.com.')).toEqual(['104.18.2.115']);
  });
});

describe('isUpstreamUrlPolicyEnforced', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  test.each([
    ['production', true],
    ['staging', true],
    ['preview', true],
    [undefined, true],
    ['development', false],
    ['test', false],
  ])('NODE_ENV=%s enforces the policy: %s', (nodeEnv, enforced) => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;

    expect(isUpstreamUrlPolicyEnforced()).toBe(enforced);
  });
});
