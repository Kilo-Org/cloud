import { afterEach, describe, expect, it, vi } from 'vitest';
import catalogJson from '../catalog.json';
import {
  cloudAgentAuthorityInputSchema,
  cloudAgentAuthorityProcedure,
  cloudAgentAuthorityProcedureKind,
  cloudAgentAuthorityProcedures,
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
const childSessionId = 'workspace_33333333-3333-4333-8333-333333333333';
const messageId = 'msg_0123456789abABCDEFGHIJKLMN';
const promptPayload = {
  type: 'prompt' as const,
  prompt: 'Continue the bounded child task',
  mode: 'code' as const,
  model: 'kilo/test-model',
};
const personalLifecycle = [
  {
    path: 'cloudAgentNext.prepareSession',
    kind: 'mutation',
    method: 'POST',
    input: launch,
  },
  {
    path: 'cloudAgentNext.listChildSessions',
    kind: 'query',
    method: 'GET',
    input: { limit: 5 },
  },
  {
    path: 'cloudAgentNext.getSession',
    kind: 'query',
    method: 'GET',
    input: { cloudAgentSessionId: childSessionId },
  },
  {
    path: 'cloudAgentNext.getMessageResult',
    kind: 'query',
    method: 'GET',
    input: { cloudAgentSessionId: childSessionId, messageId },
  },
  {
    path: 'cloudAgentNext.interruptSession',
    kind: 'mutation',
    method: 'POST',
    input: { sessionId: childSessionId },
  },
  {
    path: 'cloudAgentNext.sendMessage',
    kind: 'mutation',
    method: 'POST',
    input: { cloudAgentSessionId: childSessionId, messageId, payload: promptPayload },
  },
] as const;
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
const organizationId = '11111111-1111-4111-8111-111111111111';
const organizationScope: CloudAgentAuthority = { ...scope, organizationId };
const organizationAuth: ForwardedAuth = forwardedAuthFromProps({
  ...props,
  organizationId,
  cloudAgentAuthority: organizationScope,
});
const organizationLifecycle = personalLifecycle.map(({ path, kind, method, input }) => ({
  path: `organizations.${path}`,
  kind,
  method,
  input: { ...input, organizationId },
}));
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
    { callbackTarget: { url: 'session:parent' } },
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
    const fetchImpl = upstream();
    await callCatalogEndpoint({
      catalog,
      path: cloudAgentAuthorityProcedure(organizationScope),
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

  it.each(personalLifecycle)(
    'forwards the personal lifecycle procedure $path with $method',
    async ({ path, method, input }) => {
      const fetchImpl = upstream();
      await callCatalogEndpoint({
        catalog,
        path,
        input,
        auth,
        webBaseUrl: 'https://fixture.invalid',
        fetchImpl,
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(init.method).toBe(method);
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${token}` });
      expect(init.headers).not.toHaveProperty('x-kilocode-organizationid');
      if (method === 'GET') {
        expect(url).toBe(
          `https://fixture.invalid/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`
        );
        expect(init.body).toBeUndefined();
      } else {
        expect(url).toBe(`https://fixture.invalid/api/trpc/${path}`);
        expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
        expect(init.body).toBe(JSON.stringify(input));
      }
    }
  );

  it.each(organizationLifecycle)(
    'forwards the organization lifecycle procedure $path with $method',
    async ({ path, method, input }) => {
      const fetchImpl = upstream();
      await callCatalogEndpoint({
        catalog,
        path,
        input,
        auth: organizationAuth,
        webBaseUrl: 'https://fixture.invalid',
        fetchImpl,
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(init.method).toBe(method);
      expect(init.headers).toMatchObject({
        Authorization: `Bearer ${token}`,
        'x-kilocode-organizationid': organizationId,
      });
      if (method === 'GET') {
        expect(url).toBe(
          `https://fixture.invalid/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`
        );
        expect(init.body).toBeUndefined();
      } else {
        expect(url).toBe(`https://fixture.invalid/api/trpc/${path}`);
        expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
        expect(init.body).toBe(JSON.stringify(input));
      }
    }
  );

  it('forwards a scoped follow-up prompt with only the permitted nested fields', async () => {
    const fetchImpl = upstream();
    const input = {
      cloudAgentSessionId: childSessionId,
      messageId,
      payload: { ...promptPayload, variant: 'high' },
      autoCommit: true,
    };
    await callCatalogEndpoint({
      catalog,
      path: 'cloudAgentNext.sendMessage',
      input,
      auth,
      webBaseUrl: 'https://fixture.invalid',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1]?.body).toBe(JSON.stringify(input));
  });

  it.each([
    { path: 'user.getMe', input: {} },
    { path: 'cloudAgentNext.getSession', input: launch },
    {
      path: 'cloudAgentNext.getSession',
      input: { cloudAgentSessionId: 'parent-session' },
    },
    {
      path: 'cloudAgentNext.getSession',
      input: { cloudAgentSessionId: childSessionId, prompt: 'not a session field' },
    },
    {
      path: 'cloudAgentNext.initiateSession',
      input: { cloudAgentSessionId: childSessionId },
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
      path: 'cloudAgentNext.prepareSession',
      input: { ...launch, callbackTarget: { url: 'session:other' } },
    },
    {
      path: 'cloudAgentNext.prepareSession',
      input: { ...launch, callbackTarget: { url: 'session:parent', extra: true } },
    },
    {
      path: 'organizations.cloudAgentNext.prepareSession',
      input: { ...launch, organizationId: 'other-org' },
    },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, autoInitiate: false } },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, organizationId: 'other-org' } },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, allowSubagentSessions: true } },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, allowSubagentSessions: false } },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, profileId: 'profile' } },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, mcpServers: {} } },
    { path: 'cloudAgentNext.prepareSession', input: { ...launch, cloudAgentSpawn: scope } },
    {
      path: 'cloudAgentNext.listChildSessions',
      input: { limit: 51 },
    },
    {
      path: 'cloudAgentNext.listChildSessions',
      input: { limit: 5, cursor: 'not-a-uuid' },
    },
    {
      path: 'cloudAgentNext.listChildSessions',
      input: { limit: 5, unknown: true },
    },
    {
      path: 'cloudAgentNext.getMessageResult',
      input: { cloudAgentSessionId: childSessionId, messageId, expectedWorktreeId: 42 },
    },
    {
      path: 'cloudAgentNext.getMessageResult',
      input: { cloudAgentSessionId: childSessionId, messageId, extra: true },
    },
    {
      path: 'cloudAgentNext.interruptSession',
      input: { sessionId: childSessionId, force: true },
    },
    {
      path: 'cloudAgentNext.interruptSession',
      input: { sessionId: scope.parentSessionId, extra: true },
    },
    {
      path: 'cloudAgentNext.sendMessage',
      input: {
        cloudAgentSessionId: childSessionId,
        messageId,
        payload: { ...promptPayload, extra: 'nested' },
      },
    },
    {
      path: 'cloudAgentNext.sendMessage',
      input: {
        cloudAgentSessionId: childSessionId,
        messageId,
        payload: { type: 'command', command: 'review', arguments: '' },
      },
    },
    {
      path: 'cloudAgentNext.sendMessage',
      input: {
        cloudAgentSessionId: childSessionId,
        messageId,
        payload: { ...promptPayload, prompt: '   ' },
      },
    },
    {
      path: 'cloudAgentNext.sendMessage',
      input: {
        cloudAgentSessionId: childSessionId,
        messageId,
        payload: promptPayload,
        attachments: [],
      },
    },
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

  it.each(organizationLifecycle)(
    'pins organization lifecycle procedure $path to its verified organization',
    async ({ path, input }) => {
      const otherOrganizationId = '22222222-2222-4222-8222-222222222222';
      const otherOrganizationAuth = forwardedAuthFromProps({
        ...props,
        organizationId: otherOrganizationId,
        cloudAgentAuthority: { ...scope, organizationId: otherOrganizationId },
      });
      const denials: Array<{ path: string; input: unknown; auth: ForwardedAuth }> = [
        // A personal authority never reaches an organization procedure.
        { path, input, auth },
        // An organization authority pinned elsewhere never reaches this one.
        { path, input, auth: otherOrganizationAuth },
        // The personal mirror is not reachable from an organization authority.
        {
          path: path.replace(/^organizations\./, ''),
          input,
          auth: organizationAuth,
        },
        // An organization procedure without its pinned organization is denied.
        {
          path,
          input: Object.fromEntries(
            Object.entries(input as Record<string, unknown>).filter(
              ([key]) => key !== 'organizationId'
            )
          ),
          auth: organizationAuth,
        },
      ];
      for (const denied of denials) {
        const fetchImpl = upstream();
        await expect(
          callCatalogEndpoint({
            catalog,
            path: denied.path,
            input: denied.input,
            auth: denied.auth,
            webBaseUrl: 'https://fixture.invalid',
            fetchImpl,
          })
        ).rejects.toThrow('does not permit');
        expect(fetchImpl).not.toHaveBeenCalled();
      }
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

  it.each(personalLifecycle)(
    'denies every lifecycle procedure once the authority expires: $path',
    async ({ path, input }) => {
      const expiredAuth: ForwardedAuth = {
        ...auth,
        cloudAgentAuthority: { ...scope, expiresAt: 1 },
      };
      const fetchImpl = upstream();
      await expect(
        callCatalogEndpoint({
          catalog,
          path,
          input,
          auth: expiredAuth,
          webBaseUrl: 'https://fixture.invalid',
          fetchImpl,
        })
      ).rejects.toThrow('does not permit');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it.each(personalLifecycle)(
    'requires the catalog row kind to match the authority procedure: $path',
    async ({ path, input, kind }) => {
      const wrongKind = kind === 'query' ? ('mutation' as const) : ('query' as const);
      const mismatchedCatalog: Catalog = {
        ...catalog,
        [path]: { ...catalog[path]!, kind: wrongKind },
      };
      const fetchImpl = upstream();
      await expect(
        callCatalogEndpoint({
          catalog: mismatchedCatalog,
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

  it('keeps the public catalog as the allowlist for scoped authority', async () => {
    const limitedCatalog: Catalog = {
      'cloudAgentNext.prepareSession': catalog['cloudAgentNext.prepareSession']!,
    };
    const fetchImpl = upstream();
    await expect(
      callCatalogEndpoint({
        catalog: limitedCatalog,
        path: 'cloudAgentNext.getSession',
        input: { cloudAgentSessionId: childSessionId },
        auth,
        webBaseUrl: 'https://fixture.invalid',
        fetchImpl,
      })
    ).rejects.toThrow('Unknown path');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([null, organizationId])(
    'filters lexical and semantic search to lifecycle procedures with per-procedure schemas: %s',
    async organizationIdValue => {
      const authority = organizationIdValue === null ? scope : organizationScope;
      const allowedPaths = cloudAgentAuthorityProcedures(authority);
      const outcome = await searchCatalogDetailed('child session', {
        catalog,
        limit: 50,
        allowedPaths,
        cloudAgentAuthority: authority,
        semanticCandidates: async () => [
          ...allowedPaths.map(path => ({ path, score: 1 })),
          { path: 'user.getMe', score: 1 },
          { path: 'debug.getState', score: 1 },
        ],
      });
      expect(outcome.results.map(row => row.path).sort()).toEqual([...allowedPaths].sort());
      expect(outcome.hiddenGuardedMatches).toBe(false);
      for (const result of outcome.results) {
        expect(result.kind).toBe(cloudAgentAuthorityProcedureKind(result.path));
        expect(result.inputSchema).toEqual(cloudAgentAuthorityInputSchema(authority, result.path));
      }

      const prefix =
        organizationIdValue === null ? 'cloudAgentNext' : 'organizations.cloudAgentNext';
      const schemaFor = (name: string) =>
        outcome.results.find(result => result.path === `${prefix}.${name}`)!.inputSchema;
      expect(schemaFor('listChildSessions')).toMatchObject({
        properties: { limit: { type: 'integer' }, cursor: { type: 'string' } },
        additionalProperties: false,
      });
      expect(schemaFor('listChildSessions')).not.toHaveProperty('properties.githubRepo');
      expect(schemaFor('getSession')).toMatchObject({
        properties: { cloudAgentSessionId: { type: 'string' } },
      });
      expect(schemaFor('getSession')).not.toHaveProperty('properties.limit');
      expect(schemaFor('interruptSession')).toMatchObject({
        properties: { sessionId: { type: 'string' } },
      });
      expect(schemaFor('sendMessage')).not.toHaveProperty('properties.payload.properties.command');
      expect(schemaFor('sendMessage')).not.toHaveProperty(
        'properties.payload.properties.attachments'
      );
      expect(schemaFor('sendMessage')).not.toHaveProperty('properties.attachments');
      expect(schemaFor('prepareSession')).toMatchObject({
        properties: { githubRepo: { type: 'string' }, model: { type: 'string' } },
        required: expect.arrayContaining(['githubRepo', 'model', 'autoInitiate']),
      });
      expect(schemaFor('prepareSession')).not.toHaveProperty(
        'properties.parentCloudAgentSessionId'
      );
      expect(schemaFor('prepareSession')).not.toHaveProperty('properties.allowSubagentSessions');
      expect(schemaFor('prepareSession')).not.toHaveProperty('properties.githubRepo.enum');
      expect(schemaFor('prepareSession')).not.toHaveProperty('properties.model.enum');

      if (organizationIdValue !== null) {
        for (const result of outcome.results) {
          expect(result.inputSchema).toMatchObject({
            properties: { organizationId: { const: organizationIdValue } },
            required: expect.arrayContaining(['organizationId']),
          });
        }
      }
    }
  );

  it.each([null, organizationId])(
    'binds scoped instructions to the canonical workspace parent, not the invoking sibling: %s',
    async organizationIdValue => {
      const authority = organizationIdValue === null ? scope : organizationScope;
      const scopedAuth = forwardedAuthFromProps({
        ...props,
        organizationId: organizationIdValue,
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
      expect(body.result.instructions).toContain('canonical parent session');
      expect(body.result.instructions).toContain('not to the sibling chat that invoked this tool');
      expect(body.result.instructions).toContain('only when the user explicitly asks');
      expect(body.result.instructions).toContain('own sandbox and worktree');
      expect(body.result.instructions).toContain('fan out independent tasks');
      expect(body.result.instructions).toContain('callbackTarget: { url: "session:parent" }');
      expect(body.result.instructions).toContain('Do not poll or wait in a tool for a callback');
      expect(body.result.instructions).toContain('Prefer callbacks over polling');
      expect(body.result.instructions).toContain('keep any status check bounded');
      expect(body.result.instructions).toContain('direct child Cloud Agent sessions');
      expect(body.result.instructions).toContain(
        'list, inspect, check status, stop, send a follow-up to'
      );
      expect(body.result.instructions).toContain('must not access unrelated sessions');
      expect(body.result.instructions).toContain(
        'do not launch a child from a child session, and do not ask a child to launch one'
      );
      expect(body.result.instructions).toContain(cloudAgentAuthorityProcedure(authority));
    }
  );

  it.each([null, organizationId])(
    'derives search scope from the verified organization: %s',
    async organizationIdValue => {
      const authority = organizationIdValue === null ? scope : organizationScope;
      const expectedPaths = cloudAgentAuthorityProcedures(authority);
      const scopedAuth = forwardedAuthFromProps({
        ...props,
        organizationId: organizationIdValue,
        cloudAgentAuthority: authority,
      });
      const handler = createMcpHandler({
        catalog,
        webBaseUrl: 'https://fixture.invalid',
        semanticCandidates: async () => [
          { path: 'user.getMe', score: 1 },
          { path: 'cloudAgentNext.prepareSession', score: 1 },
          { path: 'organizations.cloudAgentNext.prepareSession', score: 1 },
          ...expectedPaths.map(path => ({ path, score: 1 })),
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
      expect(payload.results.map(row => row.path).sort()).toEqual([...expectedPaths].sort());
      for (const row of payload.results) {
        expect(row.inputSchema).toEqual(cloudAgentAuthorityInputSchema(authority, row.path));
        expect(row.inputSchema).not.toHaveProperty('properties.parentCloudAgentSessionId');
        if (organizationIdValue !== null) {
          expect(row.inputSchema).toMatchObject({
            properties: { organizationId: { const: organizationIdValue } },
            required: expect.arrayContaining(['organizationId']),
          });
        }
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
