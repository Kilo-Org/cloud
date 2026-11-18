import { beforeEach, describe, expect, it, vi } from 'vitest';
import catalogJson from '../catalog.json';
import type { CloudAgentAuthority } from '../../../packages/worker-utils/src/cloud-agent-authority';
import { SETUP_SCRIPT_LIMITS } from '../../../packages/worker-utils/src/setup-script';
import { childSessionTools, runChildSessionTool } from './child-session-tools';
import { environmentSetupTools, runEnvironmentSetupTool } from './environment-setup-tools';
import { createMcpHandler } from './index';
import type { Catalog, ForwardedAuth } from './types';

const catalog = catalogJson as Catalog;
const authority: CloudAgentAuthority = {
  version: 1,
  ownerId: 'setup-user',
  parentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
  organizationId: null,
  authorizationId: '22222222-2222-4222-8222-222222222222',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  environmentSetup: {
    runId: '33333333-3333-4333-8333-333333333333',
    environmentId: '44444444-4444-4444-8444-444444444444',
  },
};
const auth: ForwardedAuth = {
  authorization: 'Bearer fixture-token',
  kiloUserId: authority.ownerId,
  clientId: 'fixture-client',
  cloudAgentAuthority: authority,
};
const fetchImpl = vi.fn<typeof fetch>();

function run(name: string, args: Record<string, unknown> = {}, connection = auth) {
  return runEnvironmentSetupTool({
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
    result: {
      tools: Array<{ name: string }>;
      instructions?: string;
      content: Array<{ text: string }>;
    };
    error?: { code: number };
  }>;
}

beforeEach(() => {
  fetchImpl.mockReset();
});

describe('environment setup tool discovery', () => {
  it('withholds tools without the setup claim and lists only enabled tools with it', async () => {
    const { environmentSetup: _claim, ...normalAuthority } = authority;
    expect(environmentSetupTools(normalAuthority)).toEqual([]);
    const normal = await rpc('tools/list', {}, { ...auth, cloudAgentAuthority: normalAuthority });
    expect(normal.result.tools.map(tool => tool.name)).not.toContain('get_environment_draft');
    const setup = await rpc('tools/list', {});
    const names = setup.result.tools.map(tool => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'get_environment_draft',
        'update_environment_draft',
        'request_environment_secrets',
        'verify_environment_draft',
        'report_verification_results',
        'complete_environment_setup',
        'fail_environment_setup',
      ])
    );
    expect(names).toContain('get_session');
    expect(names).not.toContain('request_network_hosts');
    const update = environmentSetupTools(authority).find(
      tool => tool.name === 'update_environment_draft'
    );
    expect(update?.inputSchema.properties).not.toHaveProperty('requiredHosts');
  });
  it('includes fixed setup instructions only for a setup claim', async () => {
    const result = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fixture', version: '1' },
    });
    expect(result.result.instructions).toContain('This session is an environment setup session.');
    const { environmentSetup: _claim, ...normalAuthority } = authority;
    const normal = await rpc(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'fixture', version: '1' },
      },
      { ...auth, cloudAgentAuthority: normalAuthority }
    );
    expect(normal.result.instructions).not.toContain(
      'This session is an environment setup session.'
    );
  });
  it('advertises accurate annotations and no client supplied run id', () => {
    const tools = environmentSetupTools(authority);
    for (const tool of tools) {
      expect(tool.inputSchema.properties).not.toHaveProperty('runId');
      expect(tool.inputSchema.required).not.toContain('runId');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations).toEqual({
        readOnlyHint: tool.name === 'get_environment_draft',
        destructiveHint: false,
        idempotentHint: tool.name === 'get_environment_draft',
        openWorldHint: false,
      });
    }
  });
  it('spawn_session cannot select a draft or create verification sessions', async () => {
    const spawn = childSessionTools(authority).find(tool => tool.name === 'spawn_session');
    expect(spawn?.inputSchema.properties).not.toHaveProperty('requestedEnvironment');
    expect(spawn?.inputSchema.properties).not.toHaveProperty('verificationOf');
    await expect(
      runChildSessionTool({
        name: 'spawn_session',
        args: {
          githubRepo: 'acme/repo',
          model: 'test/model',
          mode: 'code',
          prompt: 'test',
          operationKey: '55555555-5555-4555-8555-555555555555',
          requestedEnvironment: { id: authority.environmentSetup?.environmentId },
          verificationOf: { runId: authority.environmentSetup?.runId },
        },
        auth,
        catalog,
        webBaseUrl: 'https://fixture.invalid',
        fetchImpl,
      })
    ).rejects.toMatchObject({ code: -32602 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('environment setup tool execution', () => {
  it('does not execute host requests or host edits', async () => {
    await expect(
      run('request_network_hosts', { hosts: [{ host: 'registry.npmjs.org', reason: 'install' }] })
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      run('update_environment_draft', {
        expectedRevision: 1,
        requiredHosts: ['registry.npmjs.org'],
      })
    ).rejects.toMatchObject({ code: -32602 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'call',
      arguments: {
        path: 'cloudEnvironments.setupRuns.agent.requestNetworkHosts',
        input: { hosts: [{ host: 'example.com', reason: 'test' }] },
      },
    },
    {
      name: 'call',
      arguments: {
        path: 'cloudEnvironments.setupRuns.agent.updateDraft',
        input: { expectedRevision: 1, requiredHosts: ['example.com'] },
      },
    },
    { name: 'search', arguments: { query: 'network hosts' } },
  ])('rejects generic $name calls on setup connections', async params => {
    const result = await rpc('tools/call', params);
    expect(result.error).toMatchObject({ code: -32602 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('routes getDraft through MCP with the authority run id', async () => {
    fetchImpl.mockResolvedValueOnce(Response.json({ result: { data: { status: 'running' } } }));
    const result = await rpc('tools/call', { name: 'get_environment_draft', arguments: {} });
    expect(result.error).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const request = new Request(...fetchImpl.mock.calls[0]);
    const requestUrl = new URL(request.url);
    expect(requestUrl.pathname).toBe('/api/trpc/cloudEnvironments.setupRuns.agent.getDraft');
    expect(JSON.parse(requestUrl.searchParams.get('input') ?? '{}')).toEqual({
      runId: authority.environmentSetup?.runId,
    });
    expect(result.result.content[0].text).toContain('running');
  });
  it('returns a draft with a maximum-size script in full', async () => {
    const script = 'echo "✓"\n'.repeat(Math.floor(SETUP_SCRIPT_LIMITS.MAX_LENGTH / 9));
    const draft = { status: 'running', script };
    fetchImpl.mockResolvedValueOnce(Response.json({ result: { data: draft } }));
    const result = await run('get_environment_draft');
    expect(result.truncated).toBe(false);
    expect(JSON.parse(result.text)).toEqual(draft);
  });
  it('rejects supplied run ids rather than letting a caller choose another run', async () => {
    for (const runId of [
      authority.environmentSetup?.runId,
      '55555555-5555-4555-8555-555555555555',
    ]) {
      await expect(run('get_environment_draft', { runId })).rejects.toMatchObject({ code: -32602 });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('posts draft updates to the pinned procedure and run', async () => {
    fetchImpl.mockResolvedValueOnce(
      Response.json({ result: { data: { configurationRevision: 2 } } })
    );
    const result = await run('update_environment_draft', { expectedRevision: 1, script: 'true' });
    expect(result.text).toContain('configurationRevision');
    const request = new Request(...fetchImpl.mock.calls[0]);
    expect(request.url).toBe(
      'https://fixture.invalid/api/trpc/cloudEnvironments.setupRuns.agent.updateDraft'
    );
    expect(request.method).toBe('POST');
    expect(await request.json()).toEqual({
      expectedRevision: 1,
      script: 'true',
      runId: authority.environmentSetup?.runId,
    });
  });
  it('rejects unknown, expired and mismatched authority tools', async () => {
    const { environmentSetup: _claim, ...normalAuthority } = authority;
    await expect(run('unknown')).rejects.toMatchObject({ code: -32602 });
    await expect(
      run('get_environment_draft', {}, { ...auth, cloudAgentAuthority: normalAuthority })
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      run(
        'get_environment_draft',
        {},
        { ...auth, cloudAgentAuthority: { ...authority, expiresAt: 0 } }
      )
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      run('get_environment_draft', {}, { ...auth, kiloUserId: 'other-user' })
    ).rejects.toMatchObject({ code: -32602 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
