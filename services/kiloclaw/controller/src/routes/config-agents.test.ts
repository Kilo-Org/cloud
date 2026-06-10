import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AgentConfigSnapshot, AgentSummary } from '../openclaw-agent-config';
import { AgentConfigError } from '../openclaw-agent-config';
import { OpenClawAgentCliError } from '../openclaw-agent-cli';
import { registerAgentConfigRoutes, type AgentRouteDeps } from './config-agents';

const snapshot: AgentConfigSnapshot = {
  raw: '{}',
  etag: 'etag-1',
  config: { agents: { list: [{ id: 'research' }] } },
};

const agent: AgentSummary = {
  id: 'research',
  name: 'Research',
  configured: true,
  workspace: '/root/.openclaw/workspace-research',
  agentDir: '/root/.openclaw/agents/research/agent',
  model: { primary: 'kilocode/default', fallbacks: [], source: 'agent' },
  rawModel: { primary: 'kilocode/default' },
  settings: {
    thinkingDefault: null,
    verboseDefault: null,
    reasoningDefault: null,
    fastModeDefault: null,
  },
  bindings: [],
};

function createDeps(overrides: Partial<AgentRouteDeps> = {}): AgentRouteDeps {
  return {
    readSnapshot: vi.fn(() => snapshot),
    readSummary: vi.fn(() => ({ snapshot, agent })),
    serializeMutation: async operation => operation(),
    summarize: vi.fn(() => ({
      defaults: {
        model: null,
        settings: {
          thinkingDefault: null,
          verboseDefault: null,
          reasoningDefault: null,
          fastModeDefault: null,
        },
      },
      agents: [agent],
    })),
    updateSettings: vi.fn(async () => ({ snapshot, agent })),
    updateDefaults: vi.fn(async () => ({
      snapshot,
      defaults: {
        model: { primary: 'kilocode/default', fallbacks: [] },
        settings: agent.settings,
      },
    })),
    createViaCli: vi.fn(async () => ({
      agentId: 'research',
      name: 'Research',
      workspace: '/root/.openclaw/workspace-research',
      agentDir: '/root/.openclaw/agents/research/agent',
    })),
    deleteViaCli: vi.fn(async () => ({
      agentId: 'research',
      workspace: '/root/.openclaw/workspace-research',
      agentDir: '/root/.openclaw/agents/research/agent',
      sessionsDir: '/root/.openclaw/agents/research/sessions',
      removedBindings: 1,
      removedAllow: 0,
    })),
    setBindings: vi.fn(async () => ({ snapshot, agent })),
    listBindingSummaries: vi.fn(
      async () => new Map([['research', [{ channel: 'slack', accountId: null, advanced: false }]]])
    ),
    ...overrides,
  };
}

function makeApp(deps: AgentRouteDeps): Hono {
  const app = new Hono();
  registerAgentConfigRoutes(app, deps);
  return app;
}

describe('agent config read routes', () => {
  it('returns normalized agent summaries with etag', async () => {
    const response = await makeApp(createDeps()).request('/_kilo/config/agents');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ etag: 'etag-1', agents: [{ id: 'research' }] });
  });

  it('returns one normalized agent summary with CLI-sourced bindings attached', async () => {
    const response = await makeApp(createDeps()).request('/_kilo/config/agents/research');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      etag: 'etag-1',
      // bindings come from listBindingSummaries (the CLI), not the config summary.
      agent: { ...agent, bindings: [{ channel: 'slack', accountId: null, advanced: false }] },
    });
  });
});

describe('agent config mutation routes', () => {
  it('creates a basic agent inside mutation serialization then returns its normalized summary', async () => {
    let serializedMutations = 0;
    const deps = createDeps({
      serializeMutation: async operation => {
        serializedMutations += 1;
        return operation();
      },
    });
    const response = await makeApp(deps).request('/_kilo/config/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Research', workspace: '/root/.openclaw/workspace-research' }),
    });

    expect(response.status).toBe(200);
    expect(serializedMutations).toBe(1);
    expect(deps.createViaCli).toHaveBeenCalledWith({
      name: 'Research',
      workspace: '/root/.openclaw/workspace-research',
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      etag: 'etag-1',
      // CLI-sourced bindings are attached so a create with --bind isn't reported empty.
      agent: { id: 'research', bindings: [{ channel: 'slack', accountId: null, advanced: false }] },
    });
  });

  it('updates allowed per-agent settings and returns CLI-sourced bindings', async () => {
    const deps = createDeps();
    const response = await makeApp(deps).request('/_kilo/config/agents/research', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ set: { verboseDefault: 'off' } }),
    });

    expect(response.status).toBe(200);
    expect(deps.updateSettings).toHaveBeenCalledWith(
      'research',
      expect.objectContaining({ set: { verboseDefault: 'off' } })
    );
    // The settings-update response must not falsely report an empty binding set.
    expect(await response.json()).toMatchObject({
      agent: { bindings: [{ channel: 'slack', accountId: null, advanced: false }] },
    });
  });

  it('updates agent defaults on the unambiguous defaults route', async () => {
    const deps = createDeps();
    const response = await makeApp(deps).request('/_kilo/config/agent-defaults', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ set: { model: { primary: 'kilocode/default' } } }),
    });

    expect(response.status).toBe(200);
    expect(deps.updateDefaults).toHaveBeenCalledOnce();
  });

  it('rejects settings that OpenClaw does not support on inherited defaults', async () => {
    const response = await makeApp(createDeps()).request('/_kilo/config/agent-defaults', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ set: { reasoningDefault: 'on' } }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_agent_request' });
  });

  it('deletes through serialized CLI execution without claiming filesystem disposition', async () => {
    let serializedMutations = 0;
    const deps = createDeps({
      serializeMutation: async operation => {
        serializedMutations += 1;
        return operation();
      },
    });
    const response = await makeApp(deps).request('/_kilo/config/agents/research', {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(serializedMutations).toBe(1);
    expect(deps.deleteViaCli).toHaveBeenCalledWith('research');
    expect(await response.json()).toMatchObject({
      ok: true,
      agentId: 'research',
      filesystemDisposition: 'unverified',
    });
  });

  it('sets agent bindings declaratively and returns the normalized summary', async () => {
    const deps = createDeps();
    const response = await makeApp(deps).request('/_kilo/config/agents/research/bindings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channels: ['slack', 'discord'] }),
    });

    expect(response.status).toBe(200);
    expect(deps.setBindings).toHaveBeenCalledWith('research', { channels: ['slack', 'discord'] });
    expect(await response.json()).toMatchObject({
      ok: true,
      etag: 'etag-1',
      agent: { id: 'research' },
    });
  });

  it('rejects an invalid bindings body', async () => {
    const deps = createDeps();
    const response = await makeApp(deps).request('/_kilo/config/agents/research/bindings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channels: 'slack' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_agent_request' });
    expect(deps.setBindings).not.toHaveBeenCalled();
  });

  it('maps a binding conflict to 409', async () => {
    const deps = createDeps({
      setBindings: vi.fn(async () => {
        throw new AgentConfigError(409, 'agent_binding_conflict', 'Channel routed elsewhere');
      }),
    });
    const response = await makeApp(deps).request('/_kilo/config/agents/research/bindings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channels: ['slack'] }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'agent_binding_conflict' });
  });

  it('rejects unsupported settings fields and removed target expectation guards', async () => {
    const app = makeApp(createDeps());
    const unsupportedFieldResponse = await app.request('/_kilo/config/agents/research', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ set: { workspace: '/tmp/new' } }),
    });
    expect(unsupportedFieldResponse.status).toBe(400);
    expect(await unsupportedFieldResponse.json()).toMatchObject({ code: 'invalid_agent_request' });

    const removedGuardResponse = await app.request('/_kilo/config/agents/research', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expect: { targetHash: 'old' }, set: { verboseDefault: 'off' } }),
    });
    expect(removedGuardResponse.status).toBe(400);
    expect(await removedGuardResponse.json()).toMatchObject({ code: 'invalid_agent_request' });
  });

  it('maps native conflict and CLI lifecycle errors', async () => {
    const conflict = createDeps({
      updateSettings: vi.fn(async () => {
        throw new AgentConfigError(409, 'config_etag_conflict', 'Config changed since last read');
      }),
    });
    const conflictResponse = await makeApp(conflict).request('/_kilo/config/agents/research', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ set: { verboseDefault: 'off' } }),
    });
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toMatchObject({ code: 'config_etag_conflict' });

    const reserved = createDeps({
      deleteViaCli: vi.fn(async () => {
        throw new OpenClawAgentCliError(400, 'reserved_agent_id', 'The default agent is reserved');
      }),
    });
    const reservedResponse = await makeApp(reserved).request('/_kilo/config/agents/main', {
      method: 'DELETE',
    });
    expect(reservedResponse.status).toBe(400);
    expect(await reservedResponse.json()).toMatchObject({ code: 'reserved_agent_id' });
  });
});
