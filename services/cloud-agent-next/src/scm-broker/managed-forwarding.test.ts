import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlPlaneCredential } from '../sandbox-control/managed-credential.js';
import type { ResolvedScmCapability } from './authorization.js';
import { forwardResolvedScmCapability } from './managed-forwarding.js';

const logging = vi.hoisted(() => {
  const logger = { withFields: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  logger.withFields.mockReturnValue(logger);
  return logger;
});
vi.mock('../logger.js', () => ({ logger: logging }));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const providers = [
  {
    provider: 'github',
    capability: 'kgh2.resolved',
    method: 'redeemGitHubSessionCapability',
    url: 'https://api.github.com/graphql?synthetic=query-secret',
    result: { success: true, authorization: 'Bearer synthetic-upstream-secret' },
  },
  {
    provider: 'gitlab',
    capability: 'kgl2.resolved',
    method: 'redeemGitLabSessionCapability',
    url: 'https://gitlab.com:8443/api/v4/projects/acme%2Frepo/issues?synthetic=query-secret',
    result: { success: true, headers: { 'PRIVATE-TOKEN': 'synthetic-upstream-secret' } },
  },
  {
    provider: 'bitbucket',
    capability: 'kbb1.resolved',
    method: 'redeemBitbucketSessionCapability',
    url: 'https://api.bitbucket.org/2.0/repositories/acme/repo/pullrequests?synthetic=query-secret',
    result: { success: true, headers: { authorization: 'Bearer synthetic-upstream-secret' } },
  },
] as const;

describe('forwardResolvedScmCapability', () => {
  it.each(providers)(
    'forwards $provider with resolved authority, without following the request alias',
    async ({ provider, capability, method, url, result }) => {
      const alias = createControlPlaneCredential('sbx_other_authority', provider);
      const redeem = vi.fn().mockResolvedValue(result);
      const getByName = vi.fn(() => {
        throw new Error('Must not route using the request alias');
      });
      const tokenService = { [method]: redeem, SANDBOX_CONTROL: { getByName } };
      const redirect = new Response(null, {
        status: 302,
        headers: { Location: 'https://unapproved.example/redirect' },
      });
      const forward = vi.fn(async (_request: Request) => redirect);
      vi.stubGlobal('fetch', forward);
      const request = new Request(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${alias}`,
          ...(provider === 'gitlab' ? { 'PRIVATE-TOKEN': alias } : {}),
          'Content-Type': 'application/json',
          Host: 'guest-supplied.invalid',
        },
        body: '{"synthetic":"body"}',
      });

      const response = await forwardResolvedScmCapability(
        request,
        tokenService,
        { provider, capability },
        'trusted-admitted-container'
      );

      expect(response).toBe(redirect);
      expect(getByName).not.toHaveBeenCalled();
      expect(redeem).toHaveBeenCalledExactlyOnceWith({
        capability,
        outboundContainerId: 'trusted-admitted-container',
        requestMethod: 'POST',
        requestUrl: url,
      });
      expect(forward).toHaveBeenCalledOnce();
      const forwarded = forward.mock.calls[0]?.[0];
      expect(forwarded?.url).toBe(url);
      expect(forwarded?.method).toBe('POST');
      expect(forwarded?.headers.get('Host')).toBe(new URL(url).host);
      expect(forwarded?.redirect).toBe('manual');
      expect(await forwarded?.text()).toBe('{"synthetic":"body"}');
      expect(forwarded?.headers.get('Authorization')).toBe(
        provider === 'gitlab' ? null : 'Bearer synthetic-upstream-secret'
      );
      expect(forwarded?.headers.get('PRIVATE-TOKEN')).toBe(
        provider === 'gitlab' ? 'synthetic-upstream-secret' : null
      );
      expect(request.headers.get('Authorization')).toBe(`Bearer ${alias}`);
      const logs = JSON.stringify(logging.withFields.mock.calls);
      for (const secret of [alias, capability, 'query-secret', 'synthetic-upstream-secret']) {
        expect(logs).not.toContain(secret);
      }
    }
  );

  it.each(providers)('fails closed for $provider without a redemption binding', async fixture => {
    const forward = vi.fn();
    vi.stubGlobal('fetch', forward);
    const response = await forwardResolvedScmCapability(
      new Request(fixture.url),
      {},
      fixture,
      'trusted-container'
    );
    expect(response.status).toBe(502);
    expect(forward).not.toHaveBeenCalled();
  });

  it.each(providers)('does not forward rejected $provider authority', async fixture => {
    const redeem = vi.fn().mockResolvedValue({ success: false, reason: 'container_mismatch' });
    const forward = vi.fn();
    vi.stubGlobal('fetch', forward);
    const capability: ResolvedScmCapability = fixture;
    const response = await forwardResolvedScmCapability(
      new Request(fixture.url),
      { [fixture.method]: redeem },
      capability,
      'wrong-container'
    );
    expect(response.status).toBe(502);
    expect(redeem).toHaveBeenCalledOnce();
    expect(forward).not.toHaveBeenCalled();
  });
});
