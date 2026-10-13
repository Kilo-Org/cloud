import { afterEach, describe, expect, it, vi } from 'vitest';
import catalogJson from '../catalog.json';
import { type CloudAgentAuthority } from '../../../packages/worker-utils/src/cloud-agent-authority';
import { forwardedAuthFromProps, verifyKiloSessionToken } from './auth';
import { callCatalogEndpoint, executeProtectedCall, requestProtectedCall } from './call';
import { apiHandler, canUseProtectedActions, resolveExternalToken } from './index';
import { searchCatalogDetailed } from './search';
import type { Catalog, ForwardedAuth, GrantProps } from './types';

const scope: CloudAgentAuthority = {
  version: 1,
  ownerId: 'oauth/fixture-user',
  parentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
  organizationId: null,
  procedures: ['cloudAgentNext.prepareSession'],
  repositories: ['acme/widgets'],
  models: ['kilo/test-model'],
  remainingDepth: 1,
  expiresAt: Math.floor(Date.now() / 1000) + 900,
};
const launch = {
  parentCloudAgentSessionId: scope.parentSessionId,
  githubRepo: 'acme/widgets',
  model: 'kilo/test-model',
  mode: 'code',
  prompt: 'Perform a bounded child task',
  autoInitiate: true,
};
const token = `header.${btoa(JSON.stringify({ cloudAgentAuthority: scope }))}.fixture`;
const props: GrantProps = {
  kiloUserId: scope.ownerId,
  organizationId: null,
  kiloToken: token,
  clientId: 'fixture-client',
  cloudAgentAuthority: scope,
  adminEnabled: true,
  adminEligible: true,
  sessionId: 'fixture-connection',
};
const auth: ForwardedAuth = forwardedAuthFromProps(props);
const catalog: Catalog = catalogJson as Catalog;
const upstream = () =>
  vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ result: { data: { cloudAgentSessionId: 'fixture-child' } } })
    );

afterEach(() => vi.unstubAllGlobals());

describe('Cloud Agent MCP authority', () => {
  it('forwards an allowed launch through the existing catalog and token', async () => {
    const fetchImpl = upstream();
    await callCatalogEndpoint({
      catalog,
      path: 'cloudAgentNext.prepareSession',
      input: launch,
      auth,
      webBaseUrl: 'https://fixture.invalid',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(launch),
    });
  });

  it('forwards an allowed organization launch without changing its organization', async () => {
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const organizationScope: CloudAgentAuthority = {
      ...scope,
      organizationId,
      procedures: ['organizations.cloudAgentNext.prepareSession'],
    };
    const organizationAuth = forwardedAuthFromProps({
      ...props,
      organizationId,
      cloudAgentAuthority: organizationScope,
    });
    const fetchImpl = upstream();
    await callCatalogEndpoint({
      catalog,
      path: organizationScope.procedures[0],
      input: { ...launch, organizationId },
      auth: organizationAuth,
      webBaseUrl: 'https://fixture.invalid',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      'x-kilocode-organizationid': organizationId,
    });
  });

  it.each([
    { path: 'user.getMe', input: {} },
    { path: 'cloudAgentNext.getSession', input: { cloudAgentSessionId: scope.parentSessionId } },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, githubRepo: 'acme/other' } },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, model: 'kilo/other' } },
    {
      path: 'cloudAgentNext.prepareSession',
      input: { ...launch, parentCloudAgentSessionId: 'other-parent' },
    },
    {
      path: 'organizations.cloudAgentNext.prepareSession',
      input: { ...launch, organizationId: 'other-org' },
    },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, autoInitiate: false } },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, profileId: 'profile' } },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, mcpServers: {} } },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, cloudAgentSpawn: scope } },
  ])(
    'denies procedure or request escalation without forwarding: $path',
    async ({ path, input }) => {
      const fetchImpl = upstream();
      await expect(
        callCatalogEndpoint({
          catalog,
          path,
          input,
          auth,
          webBaseUrl: 'https://fixture.invalid',
          fetchImpl,
        })
      ).rejects.toThrow('does not permit');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it('denies expired authority and mismatched authenticated identity', async () => {
    for (const denied of [
      { ...auth, cloudAgentAuthority: { ...scope, expiresAt: 1 } },
      { ...auth, kiloUserId: 'other-owner' },
    ]) {
      const fetchImpl = upstream();
      await expect(
        callCatalogEndpoint({
          catalog,
          path: 'cloudAgentNext.prepareSession',
          input: launch,
          auth: denied,
          webBaseUrl: 'https://fixture.invalid',
          fetchImpl,
        })
      ).rejects.toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('filters lexical and semantic search before limits and hidden-admin signals', async () => {
    const outcome = await searchCatalogDetailed('session', {
      catalog,
      limit: 50,
      allowedPaths: scope.procedures,
      cloudAgentAuthority: scope,
      semanticCandidates: async () => [
        { path: 'user.getMe', score: 1 },
        { path: 'debug.getState', score: 1 },
        { path: 'cloudAgentNext.prepareSession', score: 1 },
      ],
    });
    expect(outcome.results.map(row => row.path)).toEqual(scope.procedures);
    expect(outcome.hiddenGuardedMatches).toBe(false);
    expect(outcome.results[0].inputSchema).toMatchObject({
      properties: {
        parentCloudAgentSessionId: { const: scope.parentSessionId },
        githubRepo: { enum: scope.repositories },
        model: { enum: scope.models },
      },
      required: expect.arrayContaining(['parentCloudAgentSessionId', 'autoInitiate']),
    });
  });

  it('disables protected actions regardless of account admin props', async () => {
    expect(canUseProtectedActions(auth)).toBe(false);
    const fetchImpl = upstream();
    await expect(
      requestProtectedCall({
        catalog,
        path: 'debug.getState',
        input: {},
        auth,
        webBaseUrl: 'https://fixture.invalid',
        fetchImpl,
      })
    ).rejects.toThrow();
    await expect(
      executeProtectedCall({
        catalog,
        path: 'debug.getState',
        inputJson: '{}',
        auth,
        webBaseUrl: 'https://fixture.invalid',
        fetchImpl,
      })
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retains scope only from the trusted identity endpoint', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: scope.ownerId, cloudAgentAuthority: scope }));
    expect(
      await verifyKiloSessionToken({ token, webBaseUrl: 'https://fixture.invalid', fetchImpl })
    ).toEqual({ kiloUserId: scope.ownerId, cloudAgentAuthority: scope });
    fetchImpl.mockResolvedValue(Response.json({ id: scope.ownerId }));
    expect(
      await verifyKiloSessionToken({ token, webBaseUrl: 'https://fixture.invalid', fetchImpl })
    ).toBeNull();
    fetchImpl.mockResolvedValue(Response.json({ id: 'other-owner', cloudAgentAuthority: scope }));
    expect(
      await verifyKiloSessionToken({ token, webBaseUrl: 'https://fixture.invalid', fetchImpl })
    ).toBeNull();
  });

  it('rejects an organization header that widens verified scope', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ id: scope.ownerId, cloudAgentAuthority: scope }))
    );
    const request = new Request('https://fixture.invalid/mcp', {
      headers: { 'x-kilocode-organizationid': 'other-org' },
    });
    const result = await resolveExternalToken({
      token,
      request,
      env: { WEB_BASE_URL: 'https://fixture.invalid' } as unknown as Env,
    } as Parameters<typeof resolveExternalToken>[0]);
    expect(result).toBeNull();
  });

  it('revalidates scope when an OAuth-wrapped grant omitted the restriction', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ id: scope.ownerId, cloudAgentAuthority: scope }))
    );
    const { cloudAgentAuthority: omitted, ...wrappedProps } = props;
    expect(omitted).toEqual(scope);
    const ctx = {
      props: wrappedProps,
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    const response = await apiHandler.fetch(
      new Request('https://fixture.invalid/mcp', {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'search', arguments: { query: 'user', limit: 50 } },
        }),
      }),
      { WEB_BASE_URL: 'https://fixture.invalid' } as unknown as Env,
      ctx
    );
    const body = await response.text();
    expect(body).not.toContain('user.getMe');
  });
});
