import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  class StockSandbox {}
  class ContainerProxy {}
  return { StockSandbox, ContainerProxy };
});

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: sdk.StockSandbox,
  ContainerProxy: sdk.ContainerProxy,
}));

import {
  ContainerProxy,
  Sandbox,
  SandboxDIND,
  SandboxSmall,
  handleManagedScmOutbound,
} from './sandbox-outbound.js';

const CAPABILITY = 'kgh2.opaque';
const LEGACY_CAPABILITY = 'kgh1.opaque';
const GITLAB_CAPABILITY = 'kgl2.opaque';
const LEGACY_GITLAB_CAPABILITY = 'kgl1.opaque';
const OUTBOUND_CONTEXT = { containerId: 'container-test', className: 'Sandbox' };
const REDEEMED_GIT_AUTHORIZATION = `Basic ${Buffer.from('x-access-token:upstream-token').toString('base64')}`;
const REDEEMED_GITLAB_AUTHORIZATION = `Basic ${Buffer.from('oauth2:upstream-token').toString('base64')}`;

function basicCredential(password: string, scheme = 'Basic', username = 'x-access-token'): string {
  return `${scheme} ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function createEnv(
  redeemGitHubSessionCapability: ReturnType<typeof vi.fn> = vi.fn(),
  redeemGitLabSessionCapability: ReturnType<typeof vi.fn> = vi.fn()
) {
  return {
    GIT_TOKEN_SERVICE: { redeemGitHubSessionCapability, redeemGitLabSessionCapability },
  } as never;
}

function handleOutbound(request: Request, env: Cloudflare.Env): Promise<Response> {
  return handleManagedScmOutbound(request, env, OUTBOUND_CONTEXT);
}

describe('managed GitHub sandbox outbound configuration', () => {
  it('enables catch-all outbound HTTPS interception on production sandboxes', () => {
    expect(new Sandbox({} as never, {} as never)).toMatchObject({
      enableInternet: true,
      interceptHttps: true,
    });
    expect(new SandboxSmall({} as never, {} as never)).toMatchObject({
      enableInternet: true,
      interceptHttps: true,
    });
    expect(new SandboxDIND({} as never, {} as never)).toMatchObject({
      enableInternet: true,
      interceptHttps: true,
    });
    expect(ContainerProxy).toBe(sdk.ContainerProxy);
    expect(Sandbox.outbound).toBe(handleManagedScmOutbound);
    expect(SandboxSmall.outbound).toBe(handleManagedScmOutbound);
    expect(SandboxDIND.outbound).toBe(handleManagedScmOutbound);
    expect(Sandbox.outboundByHost).toBeUndefined();
    expect(SandboxSmall.outboundByHost).toBeUndefined();
    expect(SandboxDIND.outboundByHost).toBeUndefined();
  });

  it('wires the catch-all handler to Git and API redemption behavior', async () => {
    const redeemGitHubSessionCapability = vi.fn().mockResolvedValue({
      success: false,
      reason: 'invalid_capability',
    });
    const env = createEnv(redeemGitHubSessionCapability);
    const handler = Sandbox.outbound;
    if (!handler) throw new Error('Expected configured outbound handler');

    await handler(
      new Request('https://github.com/acme/repo.git/info/refs?service=git-upload-pack', {
        headers: { Authorization: basicCredential(CAPABILITY) },
      }),
      env,
      { containerId: 'container-test', className: 'Sandbox' }
    );
    await handler(
      new Request('https://api.github.com/user', {
        headers: { Authorization: `token ${CAPABILITY}` },
      }),
      env,
      { containerId: 'container-test', className: 'Sandbox' }
    );

    expect(redeemGitHubSessionCapability).toHaveBeenCalledTimes(2);
  });
});

describe('handleManagedScmOutbound', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('redeems a managed Git credential, rewrites authorization and uses manual redirects', async () => {
    const redeemGitHubSessionCapability = vi.fn().mockResolvedValue({
      success: true,
      authorization: REDEEMED_GIT_AUTHORIZATION,
    });
    const forward = vi.fn().mockResolvedValue(new Response('forwarded'));
    vi.stubGlobal('fetch', forward);
    const request = new Request('https://github.com/acme/repo.git/git-receive-pack', {
      method: 'POST',
      headers: {
        Authorization: basicCredential(CAPABILITY),
        'PRIVATE-TOKEN': 'explicit-unrelated-token',
      },
      body: 'git-body',
    });

    await handleOutbound(request, createEnv(redeemGitHubSessionCapability));

    expect(redeemGitHubSessionCapability).toHaveBeenCalledWith({
      capability: CAPABILITY,
      outboundContainerId: OUTBOUND_CONTEXT.containerId,
      requestMethod: 'POST',
      requestUrl: 'https://github.com/acme/repo.git/git-receive-pack',
    });
    const forwarded = forward.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get('Authorization')).toBe(REDEEMED_GIT_AUTHORIZATION);
    expect(forwarded.headers.get('PRIVATE-TOKEN')).toBe('explicit-unrelated-token');
    expect(forwarded.redirect).toBe('manual');
    expect(await forwarded.text()).toBe('git-body');
  });

  it('fails closed for a managed capability using alternate Basic scheme casing', async () => {
    const redeemGitHubSessionCapability = vi.fn().mockResolvedValue({
      success: false,
      reason: 'expired_capability',
    });
    const forward = vi.fn();
    vi.stubGlobal('fetch', forward);

    const response = await handleOutbound(
      new Request('https://github.com/acme/repo.git/info/refs?service=git-upload-pack', {
        headers: { Authorization: basicCredential(CAPABILITY, 'bAsIc') },
      }),
      createEnv(redeemGitHubSessionCapability)
    );

    expect(redeemGitHubSessionCapability).toHaveBeenCalledWith({
      capability: CAPABILITY,
      outboundContainerId: OUTBOUND_CONTEXT.containerId,
      requestMethod: 'GET',
      requestUrl: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
    });
    expect(response.status).toBe(502);
    expect(forward).not.toHaveBeenCalled();
  });

  it('passes non-capability or malformed Basic credentials through unchanged', async () => {
    const redeemGitHubSessionCapability = vi.fn();
    const forward = vi.fn().mockResolvedValue(new Response('forwarded'));
    vi.stubGlobal('fetch', forward);
    const authorization = basicCredential('explicit-profile-token');

    await handleOutbound(
      new Request('https://github.com/acme/repo.git/info/refs?service=git-upload-pack', {
        headers: { Authorization: authorization },
      }),
      createEnv(redeemGitHubSessionCapability)
    );

    expect(redeemGitHubSessionCapability).not.toHaveBeenCalled();
    const forwarded = forward.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get('Authorization')).toBe(authorization);
    expect(forwarded.redirect).toBe('follow');

    await handleOutbound(
      new Request('https://github.com/acme/repo.git/info/refs?service=git-upload-pack', {
        headers: { Authorization: 'Basic %not-base64%' },
      }),
      createEnv(redeemGitHubSessionCapability)
    );
    expect(redeemGitHubSessionCapability).not.toHaveBeenCalled();
  });

  it('redeems a GitHub LFS Basic capability request', async () => {
    const redeemGitHubSessionCapability = vi.fn().mockResolvedValue({
      success: true,
      authorization: REDEEMED_GIT_AUTHORIZATION,
    });
    const forward = vi.fn().mockResolvedValue(new Response('forwarded'));
    vi.stubGlobal('fetch', forward);

    await handleOutbound(
      new Request('https://github.com/acme/repo.git/info/lfs/objects/batch', {
        method: 'POST',
        headers: { Authorization: basicCredential(CAPABILITY) },
        body: '{}',
      }),
      createEnv(redeemGitHubSessionCapability)
    );

    expect(redeemGitHubSessionCapability).toHaveBeenCalledWith({
      capability: CAPABILITY,
      outboundContainerId: OUTBOUND_CONTEXT.containerId,
      requestMethod: 'POST',
      requestUrl: 'https://github.com/acme/repo.git/info/lfs/objects/batch',
    });
    const forwarded = forward.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get('Authorization')).toBe(REDEEMED_GIT_AUTHORIZATION);
    expect(forwarded.redirect).toBe('manual');
    expect(await forwarded.text()).toBe('{}');
  });

  it('passes an ordinary unrelated outbound request through unchanged', async () => {
    const redeemGitHubSessionCapability = vi.fn();
    const forward = vi.fn().mockResolvedValue(new Response('forwarded'));
    vi.stubGlobal('fetch', forward);
    const request = new Request('https://example.com/resource', {
      headers: { Authorization: 'Bearer explicit-profile-token' },
    });

    await handleOutbound(request, createEnv(redeemGitHubSessionCapability));

    expect(redeemGitHubSessionCapability).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledWith(request);
  });

  it('continues redeeming legacy capabilities during staged rollout', async () => {
    const redeemGitHubSessionCapability = vi.fn().mockResolvedValue({
      success: false,
      reason: 'invalid_capability',
    });
    const redeemGitLabSessionCapability = vi.fn().mockResolvedValue({
      success: false,
      reason: 'invalid_capability',
    });
    const env = createEnv(redeemGitHubSessionCapability, redeemGitLabSessionCapability);

    await handleOutbound(
      new Request('https://github.com/acme/repo.git/info/refs?service=git-upload-pack', {
        headers: { Authorization: basicCredential(LEGACY_CAPABILITY) },
      }),
      env
    );
    await handleOutbound(
      new Request('https://gitlab.com/api/v4/projects', {
        headers: { Authorization: `Bearer ${LEGACY_GITLAB_CAPABILITY}` },
      }),
      env
    );

    expect(redeemGitHubSessionCapability).toHaveBeenCalledWith({
      capability: LEGACY_CAPABILITY,
      outboundContainerId: OUTBOUND_CONTEXT.containerId,
      requestMethod: 'GET',
      requestUrl: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
    });
    expect(redeemGitLabSessionCapability).toHaveBeenCalledWith({
      capability: LEGACY_GITLAB_CAPABILITY,
      outboundContainerId: OUTBOUND_CONTEXT.containerId,
      requestMethod: 'GET',
      requestUrl: 'https://gitlab.com/api/v4/projects',
    });
  });

  it.each([
    basicCredential(CAPABILITY, 'bAsIc', 'oauth2'),
    basicCredential(GITLAB_CAPABILITY, 'BaSiC', 'x-access-token'),
  ])(
    'fails closed without forwarding a cross-provider Basic capability carrier: %s',
    async authorization => {
      const redeemGitHubSessionCapability = vi.fn();
      const redeemGitLabSessionCapability = vi.fn();
      const forward = vi.fn();
      vi.stubGlobal('fetch', forward);

      const response = await handleOutbound(
        new Request('https://example.com/resource', { headers: { Authorization: authorization } }),
        createEnv(redeemGitHubSessionCapability, redeemGitLabSessionCapability)
      );

      expect(response.status).toBe(502);
      expect(redeemGitHubSessionCapability).not.toHaveBeenCalled();
      expect(redeemGitLabSessionCapability).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();
    }
  );

  it('fails closed without forwarding a GitHub capability in PRIVATE-TOKEN', async () => {
    const redeemGitHubSessionCapability = vi.fn();
    const redeemGitLabSessionCapability = vi.fn();
    const forward = vi.fn();
    vi.stubGlobal('fetch', forward);

    const response = await handleOutbound(
      new Request('https://example.com/resource', {
        headers: { 'PRIVATE-TOKEN': ` \t${CAPABILITY}\t ` },
      }),
      createEnv(redeemGitHubSessionCapability, redeemGitLabSessionCapability)
    );

    expect(response.status).toBe(502);
    expect(redeemGitHubSessionCapability).not.toHaveBeenCalled();
    expect(redeemGitLabSessionCapability).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('fails closed without forwarding a GitHub capability sent to an unrelated host', async () => {
    const redeemGitHubSessionCapability = vi.fn().mockResolvedValue({
      success: false,
      reason: 'upstream_host_not_allowed',
    });
    const forward = vi.fn();
    vi.stubGlobal('fetch', forward);

    const response = await handleOutbound(
      new Request('https://example.com/resource', {
        headers: { Authorization: `Bearer ${CAPABILITY}` },
      }),
      createEnv(redeemGitHubSessionCapability)
    );

    expect(redeemGitHubSessionCapability).toHaveBeenCalledWith({
      capability: CAPABILITY,
      outboundContainerId: OUTBOUND_CONTEXT.containerId,
      requestMethod: 'GET',
      requestUrl: 'https://example.com/resource',
    });
    expect(response.status).toBe(502);
    expect(forward).not.toHaveBeenCalled();
  });

  it.each([
    `Basic   ${Buffer.from(`x-access-token:${CAPABILITY}`).toString('base64')}`,
    `token   ${CAPABILITY}`,
    `Bearer   ${CAPABILITY}`,
    `Basic\t${Buffer.from(`x-access-token:${CAPABILITY}`).toString('base64')}`,
    `token \t ${CAPABILITY}`,
    `Bearer\t \t${CAPABILITY}`,
  ])(
    'fails closed without forwarding a whitespace-separated capability credential: %s',
    async authorization => {
      const redeemGitHubSessionCapability = vi.fn().mockResolvedValue({
        success: false,
        reason: 'upstream_host_not_allowed',
      });
      const forward = vi.fn();
      vi.stubGlobal('fetch', forward);

      const response = await handleOutbound(
        new Request('https://example.com/resource', { headers: { Authorization: authorization } }),
        createEnv(redeemGitHubSessionCapability)
      );

      expect(redeemGitHubSessionCapability).toHaveBeenCalledWith({
        capability: CAPABILITY,
        outboundContainerId: OUTBOUND_CONTEXT.containerId,
        requestMethod: 'GET',
        requestUrl: 'https://example.com/resource',
      });
      expect(response.status).toBe(502);
      expect(forward).not.toHaveBeenCalled();
    }
  );

  it('fails closed without forwarding when redemption fails or throws', async () => {
    const forward = vi.fn();
    vi.stubGlobal('fetch', forward);
    const request = () =>
      new Request('https://github.com/acme/repo.git/info/refs?service=git-upload-pack', {
        headers: { Authorization: basicCredential(CAPABILITY) },
      });
    const rejected = await handleOutbound(
      request(),
      createEnv(vi.fn().mockResolvedValue({ success: false, reason: 'expired_capability' }))
    );
    const thrown = await handleOutbound(
      request(),
      createEnv(vi.fn().mockRejectedValue(new Error('RPC unavailable')))
    );

    expect(rejected.status).toBe(502);
    expect(thrown.status).toBe(502);
    expect(forward).not.toHaveBeenCalled();
  });
});

describe('handleManagedScmOutbound GitLab authorization', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('redeems GitLab Git and LFS Basic capabilities with exact method and URL', async () => {
    const redeemGitLabSessionCapability = vi.fn().mockResolvedValue({
      success: true,
      headers: { authorization: REDEEMED_GITLAB_AUTHORIZATION },
    });
    const forward = vi.fn().mockResolvedValue(new Response('forwarded'));
    vi.stubGlobal('fetch', forward);
    const urls = [
      'https://gitlab.example.com/acme/platform/repo.git/info/refs?service=git-upload-pack',
      'https://gitlab.example.com/acme/platform/repo.git/info/lfs/objects/batch',
    ];

    for (const [index, url] of urls.entries()) {
      await handleOutbound(
        new Request(url, {
          method: index === 0 ? 'GET' : 'POST',
          headers: { Authorization: basicCredential(GITLAB_CAPABILITY, 'bAsIc', 'oauth2') },
          ...(index === 0 ? {} : { body: '{}' }),
        }),
        createEnv(vi.fn(), redeemGitLabSessionCapability)
      );
    }

    expect(redeemGitLabSessionCapability).toHaveBeenNthCalledWith(1, {
      capability: GITLAB_CAPABILITY,
      outboundContainerId: OUTBOUND_CONTEXT.containerId,
      requestMethod: 'GET',
      requestUrl: urls[0],
    });
    expect(redeemGitLabSessionCapability).toHaveBeenNthCalledWith(2, {
      capability: GITLAB_CAPABILITY,
      outboundContainerId: OUTBOUND_CONTEXT.containerId,
      requestMethod: 'POST',
      requestUrl: urls[1],
    });
    const forwarded = forward.mock.calls[1]?.[0] as Request;
    expect(forwarded.headers.get('Authorization')).toBe(REDEEMED_GITLAB_AUTHORIZATION);
    expect(forwarded.redirect).toBe('manual');
  });

  it.each([
    ['Authorization', `bEaReR\t ${GITLAB_CAPABILITY}`],
    ['PRIVATE-TOKEN', ` \t${GITLAB_CAPABILITY}\t `],
  ])('redeems mixed-case whitespace-separated GitLab API %s capabilities', async (name, value) => {
    const redeemGitLabSessionCapability = vi.fn().mockResolvedValue({
      success: true,
      headers: { authorization: 'Bearer upstream-token' },
    });
    const forward = vi.fn().mockResolvedValue(new Response('forwarded'));
    vi.stubGlobal('fetch', forward);

    await handleOutbound(
      new Request('https://gitlab.com/api/v4/projects/1/merge_requests', {
        method: 'POST',
        headers: { [name]: value },
        body: '{}',
      }),
      createEnv(vi.fn(), redeemGitLabSessionCapability)
    );

    expect(redeemGitLabSessionCapability).toHaveBeenCalledWith({
      capability: GITLAB_CAPABILITY,
      outboundContainerId: OUTBOUND_CONTEXT.containerId,
      requestMethod: 'POST',
      requestUrl: 'https://gitlab.com/api/v4/projects/1/merge_requests',
    });
    const forwarded = forward.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get('Authorization')).toBe('Bearer upstream-token');
    expect(forwarded.headers.get('PRIVATE-TOKEN')).toBeNull();
    expect(forwarded.redirect).toBe('manual');
  });

  it('redeems a GitLab PRIVATE-TOKEN capability to only the raw upstream project token', async () => {
    const redeemGitLabSessionCapability = vi.fn().mockResolvedValue({
      success: true,
      headers: { 'PRIVATE-TOKEN': 'project-access-token' },
    });
    const forward = vi.fn().mockResolvedValue(new Response('forwarded'));
    vi.stubGlobal('fetch', forward);

    await handleOutbound(
      new Request('https://gitlab.com/api/v4/projects/42/merge_requests', {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': GITLAB_CAPABILITY },
        body: '{}',
      }),
      createEnv(vi.fn(), redeemGitLabSessionCapability)
    );

    expect(redeemGitLabSessionCapability).toHaveBeenCalledWith({
      capability: GITLAB_CAPABILITY,
      outboundContainerId: OUTBOUND_CONTEXT.containerId,
      requestMethod: 'POST',
      requestUrl: 'https://gitlab.com/api/v4/projects/42/merge_requests',
    });
    const forwarded = forward.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get('Authorization')).toBeNull();
    expect(forwarded.headers.get('PRIVATE-TOKEN')).toBe('project-access-token');
    expect(forwarded.headers.get('PRIVATE-TOKEN')).not.toBe(GITLAB_CAPABILITY);
    expect(forwarded.redirect).toBe('manual');
  });

  it('fails closed for conflicting managed GitLab API headers', async () => {
    const redeemGitLabSessionCapability = vi.fn();
    const forward = vi.fn();
    vi.stubGlobal('fetch', forward);

    const response = await handleOutbound(
      new Request('https://gitlab.com/api/v4/user', {
        headers: {
          Authorization: `Bearer ${GITLAB_CAPABILITY}`,
          'PRIVATE-TOKEN': 'kgl1.different',
        },
      }),
      createEnv(vi.fn(), redeemGitLabSessionCapability)
    );

    expect(response.status).toBe(502);
    expect(redeemGitLabSessionCapability).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it.each([
    `token ${GITLAB_CAPABILITY}`,
    `ToKeN   ${GITLAB_CAPABILITY}`,
    `TOKEN\t \t${GITLAB_CAPABILITY}`,
    basicCredential(GITLAB_CAPABILITY, 'Basic', 'x-access-token'),
  ])(
    'fails closed without forwarding a GitLab capability in unsupported authorization carrier: %s',
    async authorization => {
      const redeemGitLabSessionCapability = vi.fn();
      const forward = vi.fn();
      vi.stubGlobal('fetch', forward);

      const response = await handleOutbound(
        new Request('https://example.com/resource', { headers: { Authorization: authorization } }),
        createEnv(vi.fn(), redeemGitLabSessionCapability)
      );

      expect(response.status).toBe(502);
      expect(redeemGitLabSessionCapability).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();
    }
  );

  it('fails closed without forwarding a GitLab capability sent to an arbitrary host', async () => {
    const redeemGitLabSessionCapability = vi.fn().mockResolvedValue({
      success: false,
      reason: 'upstream_origin_not_allowed',
    });
    const forward = vi.fn();
    vi.stubGlobal('fetch', forward);

    const response = await handleOutbound(
      new Request('https://example.com/resource', {
        headers: { Authorization: `Bearer ${GITLAB_CAPABILITY}` },
      }),
      createEnv(vi.fn(), redeemGitLabSessionCapability)
    );

    expect(response.status).toBe(502);
    expect(forward).not.toHaveBeenCalled();
  });

  it('fails closed without forwarding when GitLab redemption rejects or throws', async () => {
    const forward = vi.fn();
    vi.stubGlobal('fetch', forward);
    const request = () =>
      new Request('https://gitlab.com/api/v4/user', {
        headers: { Authorization: `Bearer ${GITLAB_CAPABILITY}` },
      });

    const rejected = await handleOutbound(
      request(),
      createEnv(
        vi.fn(),
        vi.fn().mockResolvedValue({ success: false, reason: 'invalid_capability' })
      )
    );
    const thrown = await handleOutbound(
      request(),
      createEnv(vi.fn(), vi.fn().mockRejectedValue(new Error('RPC unavailable')))
    );

    expect(rejected.status).toBe(502);
    expect(thrown.status).toBe(502);
    expect(forward).not.toHaveBeenCalled();
  });

  it.each([
    { headers: [['PRIVATE-TOKEN', 'explicit-profile-token']] },
    { headers: [['Authorization', 'Bearer explicit-profile-token']] },
  ])('passes explicit raw GitLab credentials through unchanged', async ({ headers }) => {
    const redeemGitLabSessionCapability = vi.fn();
    const forward = vi.fn().mockResolvedValue(new Response('forwarded'));
    vi.stubGlobal('fetch', forward);
    const request = new Request('https://gitlab.com/api/v4/user', { headers });

    await handleOutbound(request, createEnv(vi.fn(), redeemGitLabSessionCapability));

    expect(redeemGitLabSessionCapability).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledWith(request);
  });
});

describe('handleManagedScmOutbound API authorization', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['token', 'TOKEN', 'Bearer', 'bEaReR'])(
    'redeems managed `%s` GH_TOKEN requests',
    async scheme => {
      const redeemGitHubSessionCapability = vi.fn().mockResolvedValue({
        success: true,
        authorization: 'Bearer upstream-token',
      });
      const forward = vi.fn().mockResolvedValue(new Response('forwarded'));
      vi.stubGlobal('fetch', forward);

      await handleOutbound(
        new Request('https://api.github.com/repos/acme/repo/issues/1/comments', {
          method: 'POST',
          headers: { Authorization: `${scheme} ${CAPABILITY}` },
          body: '{}',
        }),
        createEnv(redeemGitHubSessionCapability)
      );

      expect(redeemGitHubSessionCapability).toHaveBeenCalledWith({
        capability: CAPABILITY,
        outboundContainerId: OUTBOUND_CONTEXT.containerId,
        requestMethod: 'POST',
        requestUrl: 'https://api.github.com/repos/acme/repo/issues/1/comments',
      });
      const forwarded = forward.mock.calls[0]?.[0] as Request;
      expect(forwarded.headers.get('Authorization')).toBe('Bearer upstream-token');
      expect(forwarded.redirect).toBe('manual');
    }
  );

  it('passes explicit profile authorization through without redemption', async () => {
    const redeemGitHubSessionCapability = vi.fn();
    const forward = vi.fn().mockResolvedValue(new Response('forwarded'));
    vi.stubGlobal('fetch', forward);

    await handleOutbound(
      new Request('https://api.github.com/user', {
        headers: { Authorization: 'token explicit-profile-token' },
      }),
      createEnv(redeemGitHubSessionCapability)
    );

    expect(redeemGitHubSessionCapability).not.toHaveBeenCalled();
    const forwarded = forward.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get('Authorization')).toBe('token explicit-profile-token');
  });

  it('fails closed without forwarding when managed API redemption is rejected', async () => {
    const forward = vi.fn();
    vi.stubGlobal('fetch', forward);

    const response = await handleOutbound(
      new Request('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${CAPABILITY}` },
      }),
      createEnv(vi.fn().mockResolvedValue({ success: false, reason: 'invalid_capability' }))
    );

    expect(response.status).toBe(502);
    expect(forward).not.toHaveBeenCalled();
  });
});
