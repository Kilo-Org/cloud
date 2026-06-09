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

type FakeOpts = {
  conflictOn?: string[]; // specs another agent owns → conflict
  accountResolve?: string[]; // channels whose bare bind/unbind resolves to :default
  unbindThrows?: boolean; // unbind always fails (rollback cannot complete)
};

// A stateful in-memory CLI fake: bind/unbind mutate a route list like the real
// OpenClaw CLI, so the before/after diff, rollback, and restoration-check run end
// to end. `accountResolve` channels model a bare bind/unbind that resolves to the
// default account (the finding-1 / F5 class of channel).
function statefulDeps(
  initial: CliBinding[],
  opts: FakeOpts = {}
): { deps: AgentBindingsDeps; routes: () => CliBinding[] } {
  let routes: CliBinding[] = initial.map(r => ({ ...r, match: { ...r.match } }));
  const keyOf = (m: Record<string, unknown>) =>
    Object.keys(m)
      .sort()
      .map(k => `${k}=${JSON.stringify(m[k])}`)
      .join('&');

  const bind = vi.fn(async (id: string, specs: string[]) => {
    const added: string[] = [];
    const skipped: string[] = [];
    const conflicts: string[] = [];
    for (const spec of specs) {
      if (opts.conflictOn?.includes(spec)) {
        conflicts.push(`${spec} (agent=other)`);
        continue;
      }
      const match = opts.accountResolve?.includes(spec)
        ? { channel: spec, accountId: 'default' }
        : { channel: spec };
      if (
        routes.some(
          r => r.agentId === id && keyOf(r.match as Record<string, unknown>) === keyOf(match)
        )
      ) {
        skipped.push(spec);
      } else {
        routes.push({ agentId: id, match, description: spec });
        added.push(spec);
      }
    }
    return { agentId: id, added, updated: [], skipped, conflicts };
  });

  const unbind = vi.fn(async (id: string, specs: string[]) => {
    if (opts.unbindThrows) throw new Error('unbind failed');
    const removed: string[] = [];
    const missing: string[] = [];
    for (const spec of specs) {
      const [channel, explicitAccount] = spec.split(':');
      const accountId =
        explicitAccount ?? (opts.accountResolve?.includes(channel) ? 'default' : undefined);
      const idx = routes.findIndex(
        r =>
          r.agentId === id &&
          r.match.channel === channel &&
          (accountId !== undefined
            ? (r.match as Record<string, unknown>).accountId === accountId
            : !('accountId' in r.match))
      );
      if (idx >= 0) {
        routes.splice(idx, 1);
        removed.push(spec);
      } else {
        missing.push(spec);
      }
    }
    return { agentId: id, removed, missing, conflicts: [] };
  });

  const listBindings = vi.fn(async (id?: string) =>
    routes.filter(r => !id || r.agentId === id).map(r => ({ ...r, match: { ...r.match } }))
  );

  return { deps: makeDeps({ bind, unbind, listBindings }), routes: () => routes };
}

describe('updateAgentBindings', () => {
  it('binds channels missing from the current set', async () => {
    const { deps } = statefulDeps([route('research', 'slack')]);

    await updateAgentBindings('research', { channels: ['slack', 'discord'] }, deps);

    expect(deps.bind).toHaveBeenCalledWith('research', ['discord']);
    expect(deps.unbind).not.toHaveBeenCalled();
  });

  it('unbinds channels no longer desired', async () => {
    const { deps } = statefulDeps([route('research', 'slack'), route('research', 'discord')]);

    await updateAgentBindings('research', { channels: ['slack'] }, deps);

    expect(deps.unbind).toHaveBeenCalledWith('research', ['discord']);
    expect(deps.bind).not.toHaveBeenCalled();
  });

  it('only manages default-account routes (preserves account-scoped + advanced)', async () => {
    const { deps, routes } = statefulDeps([
      route('research', 'slack'),
      route('research', 'discord', { accountId: 'team' }), // account-scoped
      route('research', 'whatsapp', { peer: { kind: 'direct', id: '+1' } }), // advanced
    ]);

    await updateAgentBindings('research', { channels: [] }, deps);

    // Only the plain default-account slack route is removed; the rest survive.
    expect(deps.unbind).toHaveBeenCalledWith('research', ['slack']);
    expect(
      routes()
        .map(r => r.match.channel)
        .sort()
    ).toEqual(['discord', 'whatsapp']);
  });

  it('fails closed (422) when a requested channel resolves to an existing account route', async () => {
    // whatsapp auto-resolves to :default and the agent already has whatsapp:default,
    // so the bind is reported "skipped" and the managed (default) set still lacks
    // whatsapp — the request was not actually satisfied, so we must not report ok.
    const { deps, routes } = statefulDeps(
      [route('research', 'whatsapp', { accountId: 'default' })],
      {
        accountResolve: ['whatsapp'],
      }
    );

    await expect(
      updateAgentBindings('research', { channels: ['whatsapp'] }, deps)
    ).rejects.toMatchObject({ code: 'invalid_agent_config', status: 422 });

    // Nothing was created, so there is nothing to roll back and the route stays.
    expect(routes()).toHaveLength(1);
  });

  it('reports state-uncertain (500) when a post-write step fails and rollback cannot complete', async () => {
    // kilo-chat is added and discord removed; unbind always fails, so the
    // rollback of the added kilo-chat route cannot complete.
    const { deps } = statefulDeps([route('research', 'discord')], { unbindThrows: true });

    await expect(
      updateAgentBindings('research', { channels: ['kilo-chat'] }, deps)
    ).rejects.toMatchObject({ code: 'agent_binding_rollback_failed', status: 500 });
  });

  it('treats a blank account id as account-scoped (verbatim read, unmanaged on clear)', async () => {
    // A hand-authored { channel, accountId: "  " } must not read as a plain
    // default route and then be silently skipped by a clear.
    const { deps, routes } = statefulDeps([route('research', 'slack', { accountId: '  ' })]);

    const map = await listAgentBindingSummaries('research', deps);
    expect(map.get('research')).toEqual([{ channel: 'slack', accountId: '  ', advanced: false }]);

    await updateAgentBindings('research', { channels: [] }, deps);
    expect(deps.unbind).not.toHaveBeenCalled();
    expect(routes()).toHaveLength(1);
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

  it('rolls back only the routes the conflicting invocation created (409)', async () => {
    const { deps, routes } = statefulDeps([route('research', 'discord')], {
      conflictOn: ['slack'], // owned by another agent
    });

    await expect(
      updateAgentBindings('research', { channels: ['discord', 'slack', 'kilo-chat'] }, deps)
    ).rejects.toMatchObject({ code: 'agent_binding_conflict', status: 409 });

    // kilo-chat was added then rolled back; the pre-existing discord route stays.
    expect(routes().map(r => r.match.channel)).toEqual(['discord']);
  });

  it('does not delete a pre-existing account-scoped route when a conflict rolls back', async () => {
    // whatsapp's bare bind/unbind resolves to :default, and the agent already
    // owns whatsapp:default — so the whatsapp bind is skipped (not created here).
    const { deps, routes } = statefulDeps(
      [route('research', 'whatsapp', { accountId: 'default' })],
      {
        conflictOn: ['slack'],
        accountResolve: ['whatsapp'],
      }
    );

    await expect(
      updateAgentBindings('research', { channels: ['whatsapp', 'slack'] }, deps)
    ).rejects.toMatchObject({ code: 'agent_binding_conflict', status: 409 });

    // The pre-existing whatsapp:default route must survive (it wasn't created here).
    expect(routes()).toHaveLength(1);
    expect(routes()[0].match).toEqual({ channel: 'whatsapp', accountId: 'default' });
  });

  it('reports a state-uncertain failure (500) when a rollback cannot be confirmed', async () => {
    const { deps } = statefulDeps([], { conflictOn: ['slack'], unbindThrows: true });

    await expect(
      updateAgentBindings('research', { channels: ['kilo-chat', 'slack'] }, deps)
    ).rejects.toMatchObject({ code: 'agent_binding_rollback_failed', status: 500 });
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
    const { deps, routes } = statefulDeps([], { accountResolve: ['whatsapp'] });

    await expect(
      updateAgentBindings('research', { channels: ['whatsapp'] }, deps)
    ).rejects.toMatchObject({ code: 'invalid_agent_config', status: 422 });

    // The account-scoped route OpenClaw produced is rolled back, leaving nothing.
    expect(routes()).toHaveLength(0);
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
