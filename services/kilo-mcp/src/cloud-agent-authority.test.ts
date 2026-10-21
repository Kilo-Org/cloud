import { afterEach, describe, expect, it, vi } from 'vitest';
import catalogJson from '../catalog.json';
import {
  cloudAgentAuthorityProcedure,
  type CloudAgentAuthority,
} from '../../../packages/worker-utils/src/cloud-agent-authority';
import { forwardedAuthFromProps, verifyKiloSessionToken } from './auth';
import { callCatalogEndpoint, executeProtectedCall, requestProtectedCall } from './call';
import {
  apiHandler,
  canUseProtectedActions,
  createMcpHandler,
  resolveExternalToken,
} from './index';
import { searchCatalogDetailed } from './search';
import type { Catalog, ForwardedAuth, GrantProps } from './types';

const scope: CloudAgentAuthority = {
  version: 1,
  ownerId: 'oauth/fixture-user',
  parentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
  organizationId: null,
  authorizationId: '22222222-2222-4222-8222-222222222222',
  expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
};
const launch = {
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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

  it.each([
    { githubRepo: 'Other-Owner/Another_Repo', model: 'other-provider/another-model' },
    { allowSubagentSessions: true },
    { allowSubagentSessions: false },
    {
      variant: 'high',
      upstreamBranch: 'feature/child-task',
      autoCommit: true,
      operationKey: '33333333-3333-4333-8333-333333333333',
    },
  ])('forwards normally-valid child options without additional restrictions: %j', async options => {
    const fetchImpl = upstream();
    const input = { ...launch, ...options };
    await callCatalogEndpoint({
      catalog,
      path: 'cloudAgentNext.prepareSession',
      input,
      auth,
      webBaseUrl: 'https://fixture.invalid',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1]?.body).toBe(JSON.stringify(input));
  });

  it('forwards an allowed organization launch without changing its organization', async () => {
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const organizationScope: CloudAgentAuthority = {
      ...scope,
      organizationId,
    };
    const organizationAuth = forwardedAuthFromProps({
      ...props,
      organizationId,
      cloudAgentAuthority: organizationScope,
    });
    const fetchImpl = upstream();
    await callCatalogEndpoint({
      catalog,
      path: cloudAgentAuthorityProcedure(organizationScope),
      input: { ...launch, organizationId, allowSubagentSessions: true },
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
    {
      path: 'cloudAgentNext.initiateSession',
      input: { cloudAgentSessionId: scope.parentSessionId },
    },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, githubRepo: 'not-a-repository' } },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, model: '' } },
    {
      path: 'cloudAgentNext.prepareSession',
      input: { ...launch, parentCloudAgentSessionId: scope.parentSessionId },
    },
    {
      path: 'cloudAgentNext.prepareSession',
      input: { ...launch, parentCloudAgentSessionId: 'other-parent' },
    },
    {
      path: 'organizations.cloudAgentNext.prepareSession',
      input: { ...launch, organizationId: 'other-org' },
    },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, autoInitiate: false } },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, organizationId: 'other-org' } },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, allowSubagentSessions: 'true' } },
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

  it.each([
    {
      path: 'cloudAgentNext.prepareSession',
      organizationId: '11111111-1111-4111-8111-111111111111',
    },
    { path: 'organizations.cloudAgentNext.prepareSession', organizationId: undefined },
    { path: 'organizations.cloudAgentNext.prepareSession', organizationId: 'other-org' },
  ])(
    'denies organization authority outside its pinned context: %j',
    async ({ path, organizationId }) => {
      const pinnedOrganizationId = '11111111-1111-4111-8111-111111111111';
      const organizationAuth = forwardedAuthFromProps({
        ...props,
        organizationId: pinnedOrganizationId,
        cloudAgentAuthority: { ...scope, organizationId: pinnedOrganizationId },
      });
      const fetchImpl = upstream();
      await expect(
        callCatalogEndpoint({
          catalog,
          path,
          input: { ...launch, organizationId },
          auth: organizationAuth,
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
      { ...auth, organizationId: 'other-org' },
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

  it('permits calls until the credential expiry without an additional MCP deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date((scope.expiresAt - 1) * 1000));
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
    vi.setSystemTime(new Date(scope.expiresAt * 1000));
    await expect(
      callCatalogEndpoint({
        catalog,
        path: 'cloudAgentNext.prepareSession',
        input: launch,
        auth,
        webBaseUrl: 'https://fixture.invalid',
        fetchImpl,
      })
    ).rejects.toThrow('does not permit');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('filters lexical and semantic search before limits and hidden-admin signals', async () => {
    const allowedPaths = [cloudAgentAuthorityProcedure(scope)];
    const outcome = await searchCatalogDetailed('session', {
      catalog,
      limit: 50,
      allowedPaths,
      cloudAgentAuthority: scope,
      semanticCandidates: async () => [
        { path: 'user.getMe', score: 1 },
        { path: 'debug.getState', score: 1 },
        { path: 'cloudAgentNext.prepareSession', score: 1 },
      ],
    });
    expect(outcome.results.map(row => row.path)).toEqual(allowedPaths);
    expect(outcome.hiddenGuardedMatches).toBe(false);
    expect(outcome.results[0].inputSchema).toMatchObject({
      properties: {
        githubRepo: { type: 'string' },
        model: { type: 'string' },
        allowSubagentSessions: { type: 'boolean' },
      },
      required: expect.arrayContaining(['githubRepo', 'model', 'autoInitiate']),
      additionalProperties: false,
    });
    expect(outcome.results[0].inputSchema).not.toHaveProperty(
      'properties.parentCloudAgentSessionId'
    );
    expect(outcome.results[0].inputSchema).not.toHaveProperty('properties.githubRepo.enum');
    expect(outcome.results[0].inputSchema).not.toHaveProperty('properties.model.enum');
  });

  it.each([null, '11111111-1111-4111-8111-111111111111'])(
    'tells scoped sessions they may launch child sessions only on explicit request: %s',
    async organizationId => {
      const authority = { ...scope, organizationId };
      const scopedAuth = forwardedAuthFromProps({
        ...props,
        organizationId,
        cloudAgentAuthority: authority,
      });
      const handler = createMcpHandler({ catalog, webBaseUrl: 'https://fixture.invalid' });
      const response = await handler(
        new Request('https://fixture.invalid/mcp', {
          method: 'POST',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {} },
          }),
        }),
        scopedAuth
      );
      const body = (await response.json()) as { result: { instructions: string } };
      expect(body.result.instructions).toContain('may launch child Cloud Agent sessions');
      expect(body.result.instructions).toContain('only when the user explicitly asks');
      expect(body.result.instructions).toContain('own sandbox and worktree');
      expect(body.result.instructions).toContain('fan out independent tasks');
      expect(body.result.instructions).toContain(cloudAgentAuthorityProcedure(authority));
    }
  );

  it.each([null, '11111111-1111-4111-8111-111111111111'])(
    'derives search scope from the verified organization: %s',
    async organizationId => {
      const authority = { ...scope, organizationId };
      const scopedAuth = forwardedAuthFromProps({
        ...props,
        organizationId,
        cloudAgentAuthority: authority,
      });
      const handler = createMcpHandler({
        catalog,
        webBaseUrl: 'https://fixture.invalid',
        semanticCandidates: async () => [
          { path: 'user.getMe', score: 1 },
          { path: 'cloudAgentNext.prepareSession', score: 1 },
          { path: 'organizations.cloudAgentNext.prepareSession', score: 1 },
        ],
      });
      const response = await handler(
        new Request('https://fixture.invalid/mcp', {
          method: 'POST',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'search', arguments: { query: 'session', limit: 50 } },
          }),
        }),
        scopedAuth
      );
      const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
      const payload = JSON.parse(body.result.content[0].text) as {
        results: Array<{ path: string; inputSchema: Record<string, unknown> }>;
      };
      expect(payload.results.map(row => row.path)).toEqual([
        cloudAgentAuthorityProcedure(authority),
      ]);
      expect(payload.results[0].inputSchema).not.toHaveProperty(
        'properties.parentCloudAgentSessionId'
      );
      if (organizationId !== null) {
        expect(payload.results[0].inputSchema).toMatchObject({
          properties: { organizationId: { const: organizationId } },
          required: expect.arrayContaining(['organizationId']),
        });
      }
    }
  );

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
    for (const cloudAgentAuthority of [
      { ...scope, expiresAt: 1 },
      { ...scope, authorizationId: 'not-a-uuid' },
    ]) {
      fetchImpl.mockResolvedValue(Response.json({ id: scope.ownerId, cloudAgentAuthority }));
      expect(
        await verifyKiloSessionToken({ token, webBaseUrl: 'https://fixture.invalid', fetchImpl })
      ).toBeNull();
    }
  });

  it.each([
    { kiloUserId: 'other-owner' },
    { organizationId: 'other-org' },
    { cloudAgentAuthority: { ...scope, expiresAt: 1 } },
    { cloudAgentAuthority: { ...scope, authorizationId: 'not-a-uuid' } },
  ])('rejects invalid authority grant bindings: %j', override => {
    expect(() => forwardedAuthFromProps({ ...props, ...override })).toThrow();
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

  it.each([null, '11111111-1111-4111-8111-111111111111'])(
    'pins external token props to the verified organization: %s',
    async organizationId => {
      const cloudAgentAuthority = { ...scope, organizationId };
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({ id: scope.ownerId, cloudAgentAuthority }))
      );
      const result = await resolveExternalToken({
        token,
        request: new Request('https://fixture.invalid/mcp'),
        env: { WEB_BASE_URL: 'https://fixture.invalid' } as unknown as Env,
      } as Parameters<typeof resolveExternalToken>[0]);
      expect(result?.props).toEqual({
        kiloToken: token,
        kiloUserId: scope.ownerId,
        ...(organizationId === null ? {} : { organizationId }),
        cloudAgentAuthority,
        adminEnabled: false,
        adminEligible: false,
      });
    }
  );

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
