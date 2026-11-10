import { beforeEach, describe, expect, it, vi } from 'vitest';
import catalogJson from '../catalog.json';
import type { CloudAgentAuthority } from '../../../packages/worker-utils/src/cloud-agent-authority';
import { isCanonicalMessageId } from '../../../packages/session-ingest-contracts/src/message-id';
import { childSessionTools, runChildSessionTool } from './child-session-tools';
import { createMcpHandler } from './index';
import type { Catalog, ForwardedAuth } from './types';

const catalog = catalogJson as Catalog;
const authority: CloudAgentAuthority = {
  version: 1,
  ownerId: 'fixture-user',
  parentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
  organizationId: null,
  authorizationId: '22222222-2222-4222-8222-222222222222',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};
const auth: ForwardedAuth = {
  authorization: 'Bearer fixture-token',
  kiloUserId: authority.ownerId,
  clientId: 'fixture-client',
  cloudAgentAuthority: authority,
};
const organizationId = '44444444-4444-4444-8444-444444444444';
const childId = 'workspace_33333333-3333-4333-8333-333333333333';
const messageId = 'msg_0123456789abABCDEFGHIJKLMN';
const launch = {
  githubRepo: 'acme/repo',
  model: 'provider/model',
  mode: 'code',
  prompt: 'Implement an independent task, verify it, and report results.',
  operationKey: '55555555-5555-4555-8555-555555555555',
  callbackTarget: { url: 'workspace:new-chat' },
};
const model = {
  id: 'provider/model',
  name: 'Provider: Model',
  supportsVision: false,
  isPreferred: false,
  variants: ['low', 'high'],
};
const fetchImpl = vi.fn<typeof fetch>();

function run(name: string, args: Record<string, unknown> = {}, connection = auth) {
  return runChildSessionTool({
    name,
    args,
    auth: connection,
    catalog,
    webBaseUrl: 'https://fixture.invalid',
    fetchImpl,
  });
}

async function rpc(method: string, params: Record<string, unknown>, connection = auth) {
  const handler = createMcpHandler({ catalog, webBaseUrl: 'https://fixture.invalid', fetchImpl });
  const response = await handler(
    new Request('https://fixture.invalid/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    connection
  );
  return response.json() as Promise<{
    result: { tools: Array<{ name: string }>; content: Array<{ text: string }> };
    error: { message: string };
  }>;
}

beforeEach(() => {
  fetchImpl.mockReset().mockImplementation(async () =>
    Response.json({
      result: { data: { cloudAgentSessionId: childId, kiloSessionId: 'ses_fixture' } },
    })
  );
});

describe('dedicated child session tools', () => {
  it('exposes dedicated tools only to parent-scoped connections, retaining general tools elsewhere', async () => {
    const scoped = await rpc('tools/list', {});
    expect(scoped.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'search_models',
      'generate_message_id',
      'list_environments',
      'spawn_session',
      'list_child_sessions',
      'get_session',
      'get_message_result',
      'send_message',
      'interrupt_session',
      'list_folders',
      'assign_workspace_to_folder',
    ]);
    const { cloudAgentAuthority: omitted, ...generalAuth } = auth;
    expect(omitted).toEqual(authority);
    const general = await rpc('tools/list', {}, generalAuth);
    expect(general.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'search',
      'call',
    ]);
    expect(
      (await rpc('tools/call', { name: 'spawn_session', arguments: launch }, generalAuth)).error
        .message
    ).toContain('Unknown tool');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not expose message ID generation to general connections', async () => {
    const { cloudAgentAuthority: omitted, ...generalAuth } = auth;
    expect(omitted).toEqual(authority);
    const result = await rpc(
      'tools/call',
      { name: 'generate_message_id', arguments: {} },
      generalAuth
    );
    expect(result.error.message).toContain('Unknown tool');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([null, organizationId])(
    'generates fresh canonical message IDs locally for scope %s',
    async org => {
      const connection = {
        ...auth,
        ...(org ? { organizationId: org } : {}),
        cloudAgentAuthority: { ...authority, organizationId: org },
      };
      const first = await rpc(
        'tools/call',
        { name: 'generate_message_id', arguments: {} },
        connection
      );
      const second = await rpc(
        'tools/call',
        { name: 'generate_message_id', arguments: {} },
        connection
      );
      const firstId = JSON.parse(first.result.content[0].text).messageId;
      const secondId = JSON.parse(second.result.content[0].text).messageId;
      expect(isCanonicalMessageId(firstId)).toBe(true);
      expect(isCanonicalMessageId(secondId)).toBe(true);
      expect(secondId).not.toBe(firstId);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it.each([{ messageId }, { cloudAgentSessionId: childId }, { count: 2 }])(
    'rejects message ID generation arguments: %j',
    async args => {
      await expect(run('generate_message_id', args)).rejects.toThrow(
        'Invalid generate_message_id arguments'
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it('uses a generated ID unchanged for a follow-up and its durable result', async () => {
    const generated = JSON.parse((await run('generate_message_id')).text) as { messageId: string };
    const input = {
      cloudAgentSessionId: childId,
      messageId: generated.messageId,
      payload: { type: 'prompt', prompt: 'Run additional checks', mode: 'code', model: model.id },
      autoCommit: false,
    };
    await run('send_message', input);
    expect(await new Request(...fetchImpl.mock.calls[0]!).json()).toEqual(input);
    await run('get_message_result', {
      cloudAgentSessionId: childId,
      messageId: generated.messageId,
    });
    const resultUrl = new URL(new Request(...fetchImpl.mock.calls[1]!).url);
    expect(JSON.parse(resultUrl.searchParams.get('input')!)).toEqual({
      cloudAgentSessionId: childId,
      messageId: generated.messageId,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(['call_protected', 'submit_otp', 'delete_session'])(
    'refuses the unpublished scoped tool %s without forwarding',
    async name => {
      const body = await rpc('tools/call', { name, arguments: { path: 'user.getMe' } });
      expect(body.error.message).toContain('Unknown tool');
      expect(body.error.message).toContain('spawn_session');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it('keeps cached search/call clients working without publishing those tools or widening scope', async () => {
    const result = await rpc('tools/call', {
      name: 'search',
      arguments: { query: 'child session', limit: 50 },
    });
    const paths = JSON.parse(result.result.content[0].text).results.map(
      (row: { path: string }) => row.path
    );
    expect(paths).toContain('cloudAgentNext.prepareSession');
    expect(paths).not.toContain('user.getMe');
    const status = await rpc('tools/call', {
      name: 'call',
      arguments: { path: 'cloudAgentNext.getSession', input: { cloudAgentSessionId: childId } },
    });
    expect(JSON.parse(status.result.content[0].text).cloudAgentSessionId).toBe(childId);
    expect(fetchImpl).toHaveBeenCalledOnce();
    fetchImpl.mockClear();
    const denied = await rpc('tools/call', { name: 'call', arguments: { path: 'user.getMe' } });
    expect(denied.error.message).toContain('does not permit');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([null, organizationId])(
    'pins launch authority and auto-initiation for scope %s',
    async org => {
      const connection = {
        ...auth,
        ...(org ? { organizationId: org } : {}),
        cloudAgentAuthority: { ...authority, organizationId: org },
      };
      const body = await rpc(
        'tools/call',
        { name: 'spawn_session', arguments: launch },
        connection
      );
      expect(JSON.parse(body.result.content[0].text)).toEqual({
        cloudAgentSessionId: childId,
        kiloSessionId: 'ses_fixture',
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe(
        `https://fixture.invalid/api/trpc/${org ? 'organizations.' : ''}cloudAgentNext.prepareSession`
      );
      expect(init?.headers).toMatchObject({
        Authorization: auth.authorization,
        ...(org ? { 'x-kilocode-organizationid': org } : {}),
      });
      expect(await new Request(url, init).json()).toEqual({
        ...launch,
        autoInitiate: true,
        ...(org ? { organizationId: org } : {}),
      });
    }
  );

  it.each(['workspace:new-chat'])('forwards the %s callback destination', async url => {
    const body = await rpc(
      'tools/call',
      { name: 'spawn_session', arguments: { ...launch, callbackTarget: { url } } },
      auth
    );
    expect(JSON.parse(body.result.content[0].text)).toEqual({
      cloudAgentSessionId: childId,
      kiloSessionId: 'ses_fixture',
    });
    const [requestUrl, init] = fetchImpl.mock.calls[0]!;
    expect(await new Request(requestUrl, init).json()).toMatchObject({
      callbackTarget: { url },
    });
  });

  it.each([null, organizationId])('forwards a selected environment for scope %s', async org => {
    const connection = {
      ...auth,
      ...(org ? { organizationId: org } : {}),
      cloudAgentAuthority: { ...authority, organizationId: org },
    };
    const requestedEnvironment = {
      id: '88888888-8888-4888-8888-888888888888',
      repositories: [
        { repoFullName: 'acme/other', branch: 'feature/child' },
        { repoFullName: 'acme/third' },
      ],
    };
    const args = { ...launch, requestedEnvironment };
    await run('spawn_session', args, connection);
    const request = new Request(...fetchImpl.mock.calls[0]!);
    expect(new URL(request.url).pathname).toBe(
      `/api/trpc/${org ? 'organizations.' : ''}cloudAgentNext.prepareSession`
    );
    expect(await request.json()).toEqual({
      ...args,
      autoInitiate: true,
      ...(org ? { organizationId: org } : {}),
    });
  });

  it('forwards a workspace session callback target', async () => {
    const callbackTarget = {
      url: 'workspace:workspace_22345678-1234-4234-8234-123456789abc',
    };
    const body = await rpc(
      'tools/call',
      { name: 'spawn_session', arguments: { ...launch, callbackTarget } },
      auth
    );
    expect(JSON.parse(body.result.content[0].text)).toEqual({
      cloudAgentSessionId: childId,
      kiloSessionId: 'ses_fixture',
    });
    const [requestUrl, init] = fetchImpl.mock.calls[0]!;
    expect(await new Request(requestUrl, init).json()).toMatchObject({ callbackTarget });
  });

  it.each([
    { organizationId },
    { autoInitiate: false },
    { autoInitiate: true },
    { createdOnPlatform: 'desktop' },
    { parentCloudAgentSessionId: childId },
    { allowSubagentSessions: true },
    { callbackTarget: { url: 'https://other.invalid' } },
    {
      callbackTarget: {
        url: 'workspace:workspace_22345678-1234-4234-8234-123456789abc',
        token: 'short',
      },
    },
    {
      callbackTarget: {
        url: 'workspace:not-a-session',
        token: 'a'.repeat(64),
      },
    },
    { requestedEnvironment: { id: 'not-a-uuid' } },
    {
      requestedEnvironment: {
        id: '88888888-8888-4888-8888-888888888888',
        repositories: [{ repoFullName: 'acme/other', branch: '' }],
      },
    },
    {
      requestedEnvironment: {
        id: '88888888-8888-4888-8888-888888888888',
        repositories: [{ repoFullName: 'acme/other', extra: true }],
      },
    },
    { requestedEnvironment: { id: '88888888-8888-4888-8888-888888888888', extra: true } },
    { requireEnvironmentChoice: true },
    { requireEnvironmentChoice: false },
    { operationKey: 'invalid' },
  ])('rejects extra or invalid launch arguments before forwarding: %j', async override => {
    await expect(run('spawn_session', { ...launch, ...override })).rejects.toThrow('schema');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires a caller-retained launch operation key', async () => {
    const { operationKey: omitted, ...missingKey } = launch;
    expect(omitted).toBeTruthy();
    await expect(run('spawn_session', missingKey)).rejects.toThrow('operationKey');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['list_child_sessions', 'listChildSessions', { limit: 5 }, 'GET'],
    ['get_session', 'getSession', { cloudAgentSessionId: childId }, 'GET'],
    ['get_message_result', 'getMessageResult', { cloudAgentSessionId: childId, messageId }, 'GET'],
    [
      'send_message',
      'sendMessage',
      {
        cloudAgentSessionId: childId,
        messageId,
        payload: { type: 'prompt', prompt: 'Continue', mode: 'code', model: model.id },
      },
      'POST',
    ],
    ['interrupt_session', 'interruptSession', { sessionId: childId }, 'POST'],
  ] as const)('routes %s to its fixed backend operation', async (name, procedure, args, method) => {
    await run(name, args);
    const [url, init] = fetchImpl.mock.calls[0]!;
    const request = new Request(url, init);
    expect(new URL(request.url).pathname).toBe(`/api/trpc/cloudAgentNext.${procedure}`);
    expect(init?.method).toBe(method);
    expect(
      method === 'GET'
        ? JSON.parse(new URL(request.url).searchParams.get('input')!)
        : await request.json()
    ).toEqual(args);
  });

  it('keeps mutation transport failures ambiguous rather than suggesting a fresh launch', async () => {
    fetchImpl.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(run('spawn_session', launch)).rejects.toMatchObject({ data: { ambiguous: true } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects expired or mismatched scoped credentials before model or session fetches', async () => {
    for (const name of [
      'search_models',
      'generate_message_id',
      'list_environments',
      'spawn_session',
    ]) {
      for (const override of [
        { cloudAgentAuthority: { ...authority, expiresAt: 1 } },
        { kiloUserId: 'other-user' },
        { organizationId },
      ]) {
        await expect(
          run(name, name === 'spawn_session' ? launch : {}, { ...auth, ...override })
        ).rejects.toThrow('does not permit');
      }
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('publishes usage guidance, strict schemas, and safe read/write annotations', () => {
    const tools = childSessionTools(authority);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(100);
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.inputSchema).not.toHaveProperty('properties.organizationId');
      expect(tool.inputSchema).not.toHaveProperty('properties.autoInitiate');
    }
    expect(tools.find(tool => tool.name === 'spawn_session')?.inputSchema).toMatchObject({
      required: expect.arrayContaining(['operationKey', 'model', 'prompt']),
      properties: {
        requestedEnvironment: { type: 'object' },
      },
    });
    expect(tools.find(tool => tool.name === 'spawn_session')?.inputSchema).not.toHaveProperty(
      'properties.requireEnvironmentChoice'
    );
    expect(tools.find(tool => tool.name === 'list_environments')?.inputSchema).toMatchObject({
      properties: { repository: { type: 'object' } },
      required: ['repository'],
    });
    expect(tools.find(tool => tool.name === 'list_environments')?.annotations.readOnlyHint).toBe(
      true
    );
    expect(
      tools.find(tool => tool.name === 'search_models')?.inputSchema.required ?? []
    ).not.toContain('limit');
    expect(tools.find(tool => tool.name === 'search_models')?.annotations.readOnlyHint).toBe(true);
    expect(tools.find(tool => tool.name === 'generate_message_id')?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tools.find(tool => tool.name === 'spawn_session')?.annotations.readOnlyHint).toBe(false);
    expect(tools.find(tool => tool.name === 'interrupt_session')?.annotations.destructiveHint).toBe(
      true
    );
  });
});

describe('scoped workspace folder tools', () => {
  const worktreeId = 'worktree_66666666-6666-4666-8666-666666666666';
  const folderId = '77777777-7777-4777-8777-777777777777';

  it.each([null, organizationId])('pins folder listing to the signed scope %s', async org => {
    const connection = {
      ...auth,
      ...(org ? { organizationId: org } : {}),
      cloudAgentAuthority: { ...authority, organizationId: org },
    };
    await run('list_folders', {}, connection);
    const request = new Request(...fetchImpl.mock.calls[0]!);
    expect(request.method).toBe('GET');
    expect(new URL(request.url).pathname).toBe('/api/trpc/workspaceFolders.list');
    expect(JSON.parse(new URL(request.url).searchParams.get('input')!)).toEqual({
      organizationId: org,
    });
  });

  it.each([null, organizationId])(
    'forwards the direct child and worktree tuple for scope %s',
    async org => {
      const connection = {
        ...auth,
        ...(org ? { organizationId: org } : {}),
        cloudAgentAuthority: { ...authority, organizationId: org },
      };
      const input = { cloudAgentSessionId: childId, worktreeId, folderId };
      await run('assign_workspace_to_folder', input, connection);
      const request = new Request(...fetchImpl.mock.calls[0]!);
      expect(request.method).toBe('POST');
      expect(new URL(request.url).pathname).toBe('/api/trpc/workspaceFolders.moveWorktree');
      expect(await request.json()).toEqual({ ...input, organizationId: org });
    }
  );

  it('can remove only the identified child workspace folder assignment', async () => {
    await run('assign_workspace_to_folder', {
      cloudAgentSessionId: childId,
      worktreeId,
      folderId: null,
    });
    expect(await new Request(...fetchImpl.mock.calls[0]!).json()).toEqual({
      cloudAgentSessionId: childId,
      worktreeId,
      folderId: null,
      organizationId: null,
    });
  });

  it.each([
    { worktreeId, folderId },
    { cloudAgentSessionId: childId, folderId },
    { cloudAgentSessionId: childId, worktreeId },
    { cloudAgentSessionId: childId, worktreeId, folderId: 'not-a-folder' },
    { cloudAgentSessionId: childId, worktreeId: 'not-a-worktree', folderId },
    { cloudAgentSessionId: childId, worktreeId, folderId, organizationId },
  ])('rejects missing identifiers, guessed identifiers, and scope overrides: %j', async input => {
    await expect(run('assign_workspace_to_folder', input)).rejects.toThrow('schema');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not let folder listing take caller-selected account scope', async () => {
    await expect(run('list_folders', { organizationId })).rejects.toThrow('schema');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves ambiguous mutation errors without silently retrying folder assignment', async () => {
    fetchImpl.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(
      run('assign_workspace_to_folder', { cloudAgentSessionId: childId, worktreeId, folderId })
    ).rejects.toMatchObject({ data: { ambiguous: true } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('marks folder listing read-only and explains the whole-workspace scope of assignment', () => {
    const tools = childSessionTools(authority);
    expect(tools.find(tool => tool.name === 'list_folders')?.annotations.readOnlyHint).toBe(true);
    const assignment = tools.find(tool => tool.name === 'assign_workspace_to_folder');
    expect(assignment?.annotations.readOnlyHint).toBe(false);
    expect(assignment?.description).toContain('all sibling chats');
    expect(assignment?.description).toContain('Cannot move the parent workspace');
  });
});

describe('scoped environment discovery tool', () => {
  const repository = { platform: 'github', fullName: 'acme/repo' } as const;

  it.each([null, organizationId])('pins environment listing to the signed scope %s', async org => {
    const connection = {
      ...auth,
      ...(org ? { organizationId: org } : {}),
      cloudAgentAuthority: { ...authority, organizationId: org },
    };
    await run('list_environments', { repository }, connection);
    const request = new Request(...fetchImpl.mock.calls[0]!);
    expect(request.method).toBe('GET');
    expect(new URL(request.url).pathname).toBe('/api/trpc/cloudEnvironments.list');
    expect(JSON.parse(new URL(request.url).searchParams.get('input')!)).toEqual({
      repository,
      ...(org ? { organizationId: org } : {}),
    });
    expect(request.headers.get('x-kilocode-organizationid')).toBe(org);
  });

  it.each([
    {},
    { repository, extra: true },
    { repository, organizationId },
    { repository, organizationId: null },
    { repository: { platform: 'github' } },
    { repository: { platform: 'github', fullName: '' } },
    { repository: { platform: 'github', fullName: 'acme/repo', organizationId } },
    { repository: { platform: 'local', fullName: 'acme/repo' } },
    { repository: { platform: 'gitlab', projectPath: 'group/project' } },
    {
      repository: {
        platform: 'bitbucket',
        workspaceUuid: '88888888-8888-4888-8888-888888888888',
        repositoryUuid: '99999999-9999-4999-8999-999999999999',
      },
    },
  ])('rejects invalid environment listing input before fetching: %j', async args => {
    await expect(run('list_environments', args)).rejects.toThrow('schema');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['cloudEnvironments.listAll', 'cloudEnvironments.get', 'cloudEnvironments.create'])(
    'does not publish the adjacent environment operation %s as a tool',
    async name => {
      await expect(run(name, { repository })).rejects.toThrow('Unknown tool');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it('marks environment listing read-only and names the launch handoff', () => {
    const tools = childSessionTools(authority);
    const listing = tools.find(tool => tool.name === 'list_environments');
    expect(listing?.annotations.readOnlyHint).toBe(true);
    expect(listing?.annotations.destructiveHint).toBe(false);
    expect(listing?.annotations.idempotentHint).toBe(true);
    expect(listing?.description).toContain('requestedEnvironment.id');
    expect(listing?.description).toContain('GitHub repository');
    expect(listing?.description).toContain('only for the requested repository');
    expect(listing?.description).not.toContain('cannot list other repositories');
    const spawn = tools.find(tool => tool.name === 'spawn_session');
    expect(spawn?.description).toContain('requestedEnvironment');
    expect(spawn?.description).toContain('Omit requestedEnvironment');
    expect(spawn?.description).toContain('automatic/default behavior');
  });
});

describe('model identifier discovery', () => {
  function models(data: unknown) {
    fetchImpl.mockImplementation(async () => Response.json({ result: { data } }));
  }

  it('forwards the bound organization without accepting organization input', async () => {
    models([model]);
    const connection = {
      ...auth,
      organizationId,
      cloudAgentAuthority: { ...authority, organizationId },
    };
    await run('search_models', { query: model.id }, connection);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://fixture.invalid/api/trpc/models.list');
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-kilocode-organizationid': organizationId,
    });
  });

  it('resolves names despite punctuation, spacing, case, and word order, preserving variants and aliases', async () => {
    const opus = {
      ...model,
      id: 'anthropic/claude-opus-4.6',
      name: 'Anthropic: Claude Opus 4.6',
      variants: ['low', 'max'],
      alias_target: 'anthropic/pinned-model',
    };
    models([model, opus]);
    const result = await run('search_models', { query: 'OPUS4.6 claude' });
    expect(JSON.parse(result.text)).toEqual({ models: [opus], hasMore: false });
    expect(fetchImpl.mock.calls[0]).toEqual([
      'https://fixture.invalid/api/trpc/models.list',
      { method: 'GET', headers: { Accept: 'application/json', Authorization: auth.authorization } },
    ]);
  });

  it('ranks an exact id before a preferred substring match', async () => {
    models([{ ...model, id: 'provider/model-plus', isPreferred: true }, model]);
    expect(JSON.parse((await run('search_models', { query: model.id })).text).models[0].id).toBe(
      model.id
    );
  });

  it('browses preferred models first and reports omitted candidates', async () => {
    models([model, { ...model, id: 'other/preferred', isPreferred: true }]);
    expect(JSON.parse((await run('search_models', { limit: 1 })).text)).toEqual({
      models: [{ ...model, id: 'other/preferred', isPreferred: true }],
      hasMore: true,
    });
  });

  it('finds models beyond the generic 16 KiB result cap', async () => {
    models([
      ...Array.from({ length: 500 }, (_, index) => ({ ...model, id: `provider/filler-${index}` })),
      { ...model, id: 'provider/target', name: 'Target' },
    ]);
    expect(JSON.parse((await run('search_models', { query: 'target' })).text)).toEqual({
      models: [{ ...model, id: 'provider/target', name: 'Target' }],
      hasMore: false,
    });
  });

  it('keeps bounded output parseable even for oversized model entries', async () => {
    models([{ ...model, name: 'x'.repeat(20_000) }]);
    const result = await run('search_models');
    expect(result.truncated).toBe(true);
    expect(JSON.parse(result.text)).toEqual({ models: [], hasMore: true });
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(16 * 1024);
  });

  it('returns a genuine no-match result without inventing an identifier', async () => {
    models([model]);
    expect(JSON.parse((await run('search_models', { query: 'not-a-real-model' })).text)).toEqual({
      models: [],
      hasMore: false,
    });
  });

  it('represents models without named variants honestly', async () => {
    models([{ ...model, variants: [] }]);
    expect(JSON.parse((await run('search_models')).text).models[0].variants).toEqual([]);
  });

  it.each([
    null,
    {},
    [{ id: 'incomplete' }],
    [{ id: model.id, name: model.name, supportsVision: false, isPreferred: false }],
  ])('surfaces invalid upstream catalogs instead of reporting no matches: %j', async data => {
    models(data);
    await expect(run('search_models')).rejects.toThrow('invalid model catalog');
  });

  it('surfaces upstream transport failures rather than returning an empty catalog', async () => {
    fetchImpl.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(run('search_models')).rejects.toMatchObject({ data: { retryable: true } });
  });

  it.each([
    { limit: 0 },
    { limit: 21 },
    { query: 'x'.repeat(201) },
    { organizationId },
    { path: 'user.getMe' },
  ])('refuses invalid model discovery input: %j', async args => {
    await expect(run('search_models', args)).rejects.toThrow('Invalid search_models arguments');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
