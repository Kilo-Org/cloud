import { describe, expect, it, vi } from 'vitest';
import {
  AgentBindingsPutBodySchema,
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

  it('leaves an account-scoped route (incl. literal "default") intact on clear', async () => {
    const deps = makeDeps({
      listBindings: vi.fn(async () => [route('research', 'slack', { accountId: 'default' })]),
    });

    // A route carrying any accountId — even "default" — is account-scoped: bare
    // `unbind <channel>` cannot remove it, so it is not managed and survives clear.
    await updateAgentBindings('research', { channels: [] }, deps);

    expect(deps.unbind).not.toHaveBeenCalled();
  });

  it('rolls back added routes and removes nothing else when the CLI reports a conflict', async () => {
    const unbind = vi.fn(async (agentId: string, specs: string[]) => ({
      agentId,
      removed: specs,
      missing: [],
      conflicts: [],
    }));
    const deps = makeDeps({
      listBindings: vi.fn(async () => [route('research', 'discord')]),
      // OpenClaw applies the free channel and still reports the owned one as a conflict.
      bind: vi.fn(async (agentId: string) => ({
        agentId,
        added: ['kilo-chat'],
        updated: [],
        skipped: [],
        conflicts: ['slack (agent=ops)'],
      })),
      unbind,
    });

    await expect(
      updateAgentBindings('research', { channels: ['discord', 'slack', 'kilo-chat'] }, deps)
    ).rejects.toMatchObject({ code: 'agent_binding_conflict', status: 409 });
    // Rollback unbinds exactly the attempted additions (toBind); the pre-existing
    // discord route is never removed because we throw before the unbind phase.
    expect(unbind).toHaveBeenCalledTimes(1);
    expect(unbind).toHaveBeenCalledWith('research', ['slack', 'kilo-chat']);
  });

  it('still rejects with 409 if the post-conflict rollback itself fails', async () => {
    const deps = makeDeps({
      listBindings: vi.fn(async () => []),
      bind: vi.fn(async (agentId: string) => ({
        agentId,
        added: ['free'],
        updated: [],
        skipped: [],
        conflicts: ['slack (agent=ops)'],
      })),
      unbind: vi.fn(async () => {
        throw new Error('rollback boom');
      }),
    });

    await expect(
      updateAgentBindings('research', { channels: ['free', 'slack'] }, deps)
    ).rejects.toMatchObject({ code: 'agent_binding_conflict', status: 409 });
  });

  it('accepts a bare bind that yields a channel-key-only route (guard no-op)', async () => {
    let call = 0;
    const listBindings = vi.fn(async () => {
      call += 1;
      return call === 1 ? [] : [route('research', 'discord')];
    });
    const deps = makeDeps({ listBindings });

    await updateAgentBindings('research', { channels: ['discord'] }, deps);

    expect(deps.bind).toHaveBeenCalledWith('research', ['discord']);
    expect(deps.unbind).not.toHaveBeenCalled();
  });

  it('fails closed (422) and rolls back when a bare bind resolves to an account-scoped route', async () => {
    let call = 0;
    const listBindings = vi.fn(async () => {
      call += 1;
      // before: empty; after the bind: OpenClaw produced an account-scoped route.
      return call === 1 ? [] : [route('research', 'whatsapp', { accountId: 'default' })];
    });
    const unbind = vi.fn(async (agentId: string, specs: string[]) => ({
      agentId,
      removed: specs,
      missing: [],
      conflicts: [],
    }));
    const deps = makeDeps({ listBindings, unbind });

    await expect(
      updateAgentBindings('research', { channels: ['whatsapp'] }, deps)
    ).rejects.toMatchObject({ code: 'invalid_agent_config', status: 422 });

    // Rolls back exactly the route OpenClaw created, by its canonical spec.
    expect(unbind).toHaveBeenCalledWith('research', ['whatsapp:default']);
  });

  it('does not flag a pre-existing account-scoped route as produced by the bind', async () => {
    let call = 0;
    const listBindings = vi.fn(async () => {
      call += 1;
      // A pre-existing account-scoped slack route exists throughout; binding
      // discord adds a clean default route. The guard must diff against the
      // pre-bind snapshot and NOT flag slack (it wasn't produced by this call).
      return call === 1
        ? [route('research', 'slack', { accountId: 'team' })]
        : [route('research', 'slack', { accountId: 'team' }), route('research', 'discord')];
    });
    const deps = makeDeps({ listBindings });

    await updateAgentBindings('research', { channels: ['discord'] }, deps);

    expect(deps.bind).toHaveBeenCalledWith('research', ['discord']);
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
      { channel: 'discord', accountId: 'default', advanced: false }, // accountId reported verbatim
    ]);
    expect(map.get('ops')).toEqual([
      { channel: 'telegram', accountId: 'biz', advanced: false },
      { channel: 'whatsapp', accountId: null, advanced: true }, // guildId → advanced
    ]);
  });
});

describe('AgentBindingsPutBodySchema', () => {
  it('rejects a channel that carries an account specifier', () => {
    const result = AgentBindingsPutBodySchema.safeParse({ channels: ['slack:team'] });
    expect(result.success).toBe(false);
  });

  it('accepts plain channel ids', () => {
    const result = AgentBindingsPutBodySchema.safeParse({ channels: ['slack', 'discord'] });
    expect(result.success).toBe(true);
  });
});
