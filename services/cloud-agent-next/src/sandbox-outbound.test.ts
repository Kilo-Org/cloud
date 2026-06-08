import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  class StockSandbox {}
  class ContainerProxy {}
  return { StockSandbox, ContainerProxy };
});
const logging = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    withFields: vi.fn(),
  };
  logger.withFields.mockReturnValue(logger);
  return { logger };
});

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: sdk.StockSandbox,
  ContainerProxy: sdk.ContainerProxy,
}));
vi.mock('./logger.js', () => ({ logger: logging.logger }));

import {
  ContainerProxy,
  Sandbox,
  SandboxDIND,
  SandboxSmall,
  MANAGED_SCM_OUTBOUND_HANDLER,
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

function serializedLogCalls(): string {
  return JSON.stringify({
    fields: logging.logger.withFields.mock.calls,
    debug: logging.logger.debug.mock.calls,
    info: logging.logger.info.mock.calls,
    warn: logging.logger.warn.mock.calls,
  });
}

describe('managed GitHub sandbox outbound configuration', () => {
  it('registers an inactive named handler only on per-session sandboxes', () => {
    expect(new Sandbox({} as never, {} as never)).toMatchObject({ enableInternet: true });
    expect(new SandboxSmall({} as never, {} as never)).toMatchObject({
      enableInternet: true,
      interceptHttps: true,
    });
    expect(new SandboxDIND({} as never, {} as never)).toMatchObject({ enableInternet: true });
    expect(ContainerProxy).toBe(sdk.ContainerProxy);
    expect(Sandbox.outbound).toBeUndefined();
    expect(SandboxSmall.outbound).toBeUndefined();
    expect(SandboxDIND.outbound).toBeUndefined();
    expect(Sandbox.outboundHandlers).toBeUndefined();
    expect(SandboxSmall.outboundHandlers).toEqual({
      [MANAGED_SCM_OUTBOUND_HANDLER]: handleManagedScmOutbound,
    });
    expect(SandboxDIND.outboundHandlers).toBeUndefined();
  });

  it('wires the named handler to Git and API redemption behavior', async () => {
    const redeemGitHubSessionCapability = vi.fn().mockResolvedValue({
      success: false,
      reason: 'invalid_capability',
    });
    const env = createEnv(redeemGitHubSessionCapability);
    const handler = SandboxSmall.outboundHandlers?.[MANAGED_SCM_OUTBOUND_HANDLER];
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
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('logs safe GitHub CLI request and redemption failure diagnostics', async () => {
    const redeemGitHubSessionCapability = vi.fn().mockResolvedValue({
      success: false,
      reason: 'invalid_upstream_request',
    });

    const response = await handleOutbound(
      new Request('https://api.github.com/graphql?secret=query-secret', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CAPABILITY}`,
          'User-Agent': 'GitHub CLI 2.82.1',
        },
        body: '{}',
      }),
      createEnv(redeemGitHubSessionCapability)
    );

    expect(response.status).toBe(502);
    expect(logging.logger.withFields).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationClass: 'github-managed',
        client: 'github-cli',
        method: 'POST',
        route: 'graphql',
        target: 'github-api',
      })
    );
    expect(logging.logger.withFields).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityVersion: 'kgh2',
        outboundContainerId: OUTBOUND_CONTEXT.containerId,
        reason: 'invalid_upstream_request',
      })
    );
    const logs = serializedLogCalls();
    expect(logs).not.toContain(CAPABILITY);
    expect(logs).not.toContain('query-secret');
  });

  it('logs when GitHub CLI does not send a managed capability', async () => {
    const forward = vi.fn().mockResolvedValue(new Response('forwarded'));
    vi.stubGlobal('fetch', forward);

    await handleOutbound(
      new Request('https://api.github.com/user?secret=query-secret', {
        headers: {
          Authorization: 'Bearer explicit-profile-token',
          'User-Agent': 'GitHub CLI 2.82.1',
        },
      }),
      createEnv()
    );

    expect(logging.logger.withFields).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationClass: 'unmanaged',
        client: 'github-cli',
        method: 'GET',
        route: 'user',
        target: 'github-api',
      })
    );
    const logs = serializedLogCalls();
    expect(logs).not.toContain('explicit-profile-token');
    expect(logs).not.toContain('query-secret');
  });

  it('logs mixed managed and unmanaged GitHub CLI authorization without credential values', async () => {
    const redeemGitHubSessionCapability = vi.fn().mockResolvedValue({
      success: false,
      reason: 'invalid_upstream_request',
    });

    await handleOutbound(
      new Request('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CAPABILITY}`,
          'PRIVATE-TOKEN': 'explicit-private-secret',
          'User-Agent': 'GitHub CLI 2.82.1',
        },
        body: '{}',
      }),
      createEnv(redeemGitHubSessionCapability)
    );

    expect(logging.logger.withFields).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationClass: 'mixed' })
    );
    expect(serializedLogCalls()).not.toContain('explicit-private-secret');
    expect(serializedLogCalls()).not.toContain(CAPABILITY);
  });

  it('logs conflicting managed GitHub CLI capabilities as mixed', async () => {
    const response = await handleOutbound(
      new Request('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CAPABILITY}`,
          'PRIVATE-TOKEN': GITLAB_CAPABILITY,
          'User-Agent': 'GitHub CLI 2.82.1',
        },
        body: '{}',
      }),
      createEnv()
    );

    expect(response.status).toBe(502);
    expect(logging.logger.withFields).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationClass: 'mixed' })
    );
    expect(serializedLogCalls()).not.toContain(CAPABILITY);
    expect(serializedLogCalls()).not.toContain(GITLAB_CAPABILITY);
  });

  it('redacts untrusted GitHub CLI request paths from diagnostics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('forwarded')));

    await handleOutbound(
      new Request('https://example.com/private-secret?secret=query-secret', {
        method: 'METHODSECRET',
        headers: {
          Authorization: 'Bearer explicit-profile-token',
          'User-Agent': 'GitHub CLI 2.82.1',
        },
      }),
      createEnv()
    );

    expect(logging.logger.withFields).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'other', route: 'other', target: 'other' })
    );
    const logs = serializedLogCalls();
    expect(logs).not.toContain('private-secret');
    expect(logs).not.toContain('query-secret');
    expect(logs).not.toContain('METHODSECRET');
    expect(logs).not.toContain('explicit-profile-token');
  });

  it('logs the upstream status for redeemed GitHub CLI requests', async () => {
    const redeemGitHubSessionCapability = vi.fn().mockResolvedValue({
      success: true,
      authorization: REDEEMED_GIT_AUTHORIZATION,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 })));

    const response = await handleOutbound(
      new Request('https://api.github.com/repos/acme/repo/pulls/1', {
        headers: {
          Authorization: `Bearer ${CAPABILITY}`,
          'User-Agent': 'GitHub CLI 2.82.1',
        },
      }),
      createEnv(redeemGitHubSessionCapability)
    );

    expect(response.status).toBe(403);
    expect(logging.logger.withFields).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamStatus: 403 })
    );
    expect(serializedLogCalls()).not.toContain('upstream-token');
  });

  it('keeps diagnostics failures from changing a successful forwarded response', async () => {
    const redeemGitHubSessionCapability = vi.fn().mockResolvedValue({
      success: true,
      authorization: REDEEMED_GIT_AUTHORIZATION,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    logging.logger.withFields.mockImplementationOnce(() => {
      throw new Error('diagnostics unavailable');
    });

    const response = await handleOutbound(
      new Request('https://api.github.com/repos/acme/repo/pulls/1', {
        headers: {
          Authorization: `Bearer ${CAPABILITY}`,
          'User-Agent': 'GitHub CLI 2.82.1',
        },
      }),
      createEnv(redeemGitHubSessionCapability)
    );

    expect(response.status).toBe(204);
  });

  it('distinguishes upstream forwarding failures without logging their messages', async () => {
    const redeemGitHubSessionCapability = vi.fn().mockResolvedValue({
      success: true,
      authorization: REDEEMED_GIT_AUTHORIZATION,
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('upstream-secret-message')));

    const response = await handleOutbound(
      new Request('https://api.github.com/repos/acme/repo/pulls/1', {
        headers: {
          Authorization: `Bearer ${CAPABILITY}`,
          'User-Agent': 'GitHub CLI 2.82.1',
        },
      }),
      createEnv(redeemGitHubSessionCapability)
    );

    expect(response.status).toBe(502);
    expect(logging.logger.withFields).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'error', failureStage: 'upstream-forward' })
    );
    expect(serializedLogCalls()).not.toContain('upstream-secret-message');
    expect(serializedLogCalls()).not.toContain('upstream-token');
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

  it.each([
    ['GitHub API bearer', { Authorization: 'Bearer kgh3opaque' }],
    ['GitLab Git Basic', { Authorization: basicCredential('kgl42opaque', 'Basic', 'oauth2') }],
    ['GitLab API private token', { 'PRIVATE-TOKEN': 'kgl999opaque' }],
  ])('passes non-versioned capability-like %s credential through unchanged', async (_, headers) => {
    const redeemGitHubSessionCapability = vi.fn();
    const redeemGitLabSessionCapability = vi.fn();
    const forward = vi.fn().mockResolvedValue(new Response('forwarded'));
    vi.stubGlobal('fetch', forward);
    const request = new Request('https://example.com/resource', { headers });

    await handleOutbound(
      request,
      createEnv(redeemGitHubSessionCapability, redeemGitLabSessionCapability)
    );

    expect(redeemGitHubSessionCapability).not.toHaveBeenCalled();
    expect(redeemGitLabSessionCapability).not.toHaveBeenCalled();
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

  it.each([
    ['GitHub Git Basic', { Authorization: basicCredential('kgh3.opaque') }],
    ['GitHub API bearer', { Authorization: 'Bearer kgh42.opaque' }],
    ['GitLab Git Basic', { Authorization: basicCredential('kgl3.opaque', 'Basic', 'oauth2') }],
    ['GitLab API bearer', { Authorization: 'Bearer kgl42.opaque' }],
    ['GitLab API private token', { 'PRIVATE-TOKEN': 'kgl999.opaque' }],
  ])(
    'fails closed without forwarding an unsupported future %s capability version',
    async (_, headers) => {
      const redeemGitHubSessionCapability = vi.fn();
      const redeemGitLabSessionCapability = vi.fn();
      const forward = vi.fn().mockResolvedValue(new Response('forwarded'));
      vi.stubGlobal('fetch', forward);

      const response = await handleOutbound(
        new Request('https://example.com/resource', { headers }),
        createEnv(redeemGitHubSessionCapability, redeemGitLabSessionCapability)
      );

      expect(response.status).toBe(502);
      expect(redeemGitHubSessionCapability).not.toHaveBeenCalled();
      expect(redeemGitLabSessionCapability).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();
    }
  );

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
