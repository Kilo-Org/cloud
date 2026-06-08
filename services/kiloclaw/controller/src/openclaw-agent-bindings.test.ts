import { describe, expect, it, vi } from 'vitest';
import {
  listAgentBindingSummaries,
  updateAgentBindings,
  type AgentBindingsDeps,
} from './openclaw-agent-bindings';
import type { AgentConfigSnapshot, AgentSummary } from './openclaw-agent-config';
import type { CliBinding } from './openclaw-agent-cli';

const SNAPSHOT: AgentConfigSnapshot = {
  raw: '{}',
  etag: 'etag-1',
  config: { agents: { list: [{ id: 'research' }, { id: 'ops' }] } },
};

const AGENT: AgentSummary = {
  id: 'research',
  name: null,
  configured: true,
  workspace: null,
  agentDir: null,
  model: { primary: null, fallbacks: [], source: null },
  rawModel: null,
  settings: {
    thinkingDefault: null,
    verboseDefault: null,
    reasoningDefault: null,
    fastModeDefault: null,
  },
  bindings: [],
};

function route(agentId: string, channel: string, extra?: Record<string, unknown>): CliBinding {
  return { agentId, match: { channel, ...extra }, description: channel };
}

function makeDeps(overrides: Partial<AgentBindingsDeps> = {}): AgentBindingsDeps {
  return {
    listBindings: vi.fn(async () => []),
    bind: vi.fn(async (agentId: string, specs: string[]) => ({
      agentId,
      added: specs,
      updated: [],
      skipped: [],
      conflicts: [],
    })),
    unbind: vi.fn(async (agentId: string, specs: string[]) => ({
      agentId,
      removed: specs,
      missing: [],
      conflicts: [],
    })),
    serializeMutation: (async (operation: () => Promise<unknown>) =>
      operation()) as AgentBindingsDeps['serializeMutation'],
    readSnapshot: () => SNAPSHOT,
    readSummary: () => ({ snapshot: SNAPSHOT, agent: AGENT }),
    ...overrides,
  } as AgentBindingsDeps;
}

describe('updateAgentBindings', () => {
  it('binds channels missing from the current set', async () => {
    const deps = makeDeps({ listBindings: vi.fn(async () => [route('research', 'slack')]) });

    await updateAgentBindings('research', { channels: ['slack', 'discord'] }, deps);

    expect(deps.bind).toHaveBeenCalledWith('research', ['discord']);
    expect(deps.unbind).not.toHaveBeenCalled();
  });

  it('unbinds channels no longer desired', async () => {
    const deps = makeDeps({
      listBindings: vi.fn(async () => [route('research', 'slack'), route('research', 'discord')]),
    });

    await updateAgentBindings('research', { channels: ['slack'] }, deps);

    expect(deps.unbind).toHaveBeenCalledWith('research', ['discord']);
    expect(deps.bind).not.toHaveBeenCalled();
  });

  it('only manages default-account routes (preserves account-scoped + advanced)', async () => {
    const deps = makeDeps({
      listBindings: vi.fn(async () => [
        route('research', 'slack'),
        route('research', 'discord', { accountId: 'team' }), // account-scoped
        route('research', 'whatsapp', { peer: { kind: 'direct', id: '+1' } }), // advanced
      ]),
    });

    await updateAgentBindings('research', { channels: [] }, deps);

    // Only the plain default-account slack route is removed.
    expect(deps.unbind).toHaveBeenCalledWith('research', ['slack']);
  });

  it('treats accountId "default" as the default account', async () => {
    const deps = makeDeps({
      listBindings: vi.fn(async () => [route('research', 'slack', { accountId: 'default' })]),
    });

    // The "default" route is managed → clearing removes it.
    await updateAgentBindings('research', { channels: [] }, deps);

    expect(deps.unbind).toHaveBeenCalledWith('research', ['slack']);
  });

  it('surfaces a CLI conflict as 409 without unbinding (bind runs first)', async () => {
    const deps = makeDeps({
      listBindings: vi.fn(async () => [route('research', 'discord')]),
      bind: vi.fn(async (agentId: string) => ({
        agentId,
        added: [],
        updated: [],
        skipped: [],
        conflicts: ['slack (agent=ops)'],
      })),
    });

    await expect(
      updateAgentBindings('research', { channels: ['slack'] }, deps)
    ).rejects.toMatchObject({ code: 'agent_binding_conflict', status: 409 });
    // discord would have been unbound — but bind failed first, so it is untouched.
    expect(deps.unbind).not.toHaveBeenCalled();
  });

  it('rejects a stale etag without touching the CLI', async () => {
    const deps = makeDeps();

    await expect(
      updateAgentBindings('research', { channels: ['slack'], etag: 'stale' }, deps)
    ).rejects.toMatchObject({ code: 'config_etag_conflict', status: 409 });
    expect(deps.bind).not.toHaveBeenCalled();
    expect(deps.unbind).not.toHaveBeenCalled();
  });

  it('rejects an agent absent from agents.list (incl. unconfigured main)', async () => {
    const deps = makeDeps();

    await expect(updateAgentBindings('ghost', { channels: ['slack'] }, deps)).rejects.toMatchObject(
      { code: 'agent_not_found', status: 404 }
    );
    await expect(updateAgentBindings('main', { channels: ['slack'] }, deps)).rejects.toMatchObject({
      code: 'agent_not_found',
      status: 404,
    });
    expect(deps.bind).not.toHaveBeenCalled();
  });
});

describe('listAgentBindingSummaries', () => {
  it('maps CLI bindings to summaries grouped by agent', async () => {
    const deps = makeDeps({
      listBindings: vi.fn(async () => [
        route('research', 'slack'),
        route('research', 'discord', { accountId: 'default' }),
        route('ops', 'telegram', { accountId: 'biz' }),
        route('ops', 'whatsapp', { guildId: 'g1' }),
      ]),
    });

    const map = await listAgentBindingSummaries(undefined, deps);

    expect(map.get('research')).toEqual([
      { channel: 'slack', accountId: null, advanced: false },
      { channel: 'discord', accountId: null, advanced: false }, // "default" → null
    ]);
    expect(map.get('ops')).toEqual([
      { channel: 'telegram', accountId: 'biz', advanced: false },
      { channel: 'whatsapp', accountId: null, advanced: true }, // guildId → advanced
    ]);
  });
});
