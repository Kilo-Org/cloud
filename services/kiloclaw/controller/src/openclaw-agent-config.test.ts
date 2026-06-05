import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentConfigError,
  AgentDefaultsPatchBodySchema,
  AgentSettingsPatchBodySchema,
  readAgentConfigSnapshot,
  readAgentSummary,
  serializeAgentConfigMutation,
  summarizeAgentConfig,
  updateAgentBindings,
  updateAgentDefaults,
  updateAgentSettings,
} from './openclaw-agent-config';

const tempDirs: string[] = [];

async function configFixture(config: unknown): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'kiloclaw-agent-config-'));
  tempDirs.push(dir);
  const configPath = path.join(dir, 'openclaw.json');
  await fsPromises.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return configPath;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(dir => fsPromises.rm(dir, { recursive: true, force: true }))
  );
});

describe('agent config summaries', () => {
  it('synthesizes an unconfigured main agent using default model settings', async () => {
    const configPath = await configFixture({
      agents: {
        defaults: {
          model: { primary: 'kilocode/kilo-auto/balanced', fallbacks: ['kilocode/fallback'] },
          thinkingDefault: 'medium',
        },
      },
    });
    const snapshot = readAgentConfigSnapshot({ configPath });

    const result = summarizeAgentConfig(snapshot.config);

    expect(result.agents).toEqual([
      expect.objectContaining({
        id: 'main',
        configured: false,
        model: {
          primary: 'kilocode/kilo-auto/balanced',
          fallbacks: ['kilocode/fallback'],
          source: 'defaults',
        },
      }),
    ]);
    expect(result.defaults.settings.thinkingDefault).toBe('medium');
  });

  it('surfaces channel-level bindings per agent, filtered by agent id', async () => {
    const configPath = await configFixture({
      agents: { list: [{ id: 'research' }, { id: 'ops' }] },
      bindings: [
        { agentId: 'research', match: { channel: 'slack' } },
        { agentId: 'research', match: { channel: 'discord', accountId: 'team' } },
        { agentId: 'ops', match: { channel: 'telegram' } },
      ],
    });
    const result = summarizeAgentConfig(readAgentConfigSnapshot({ configPath }).config);

    const research = result.agents.find(a => a.id === 'research');
    const ops = result.agents.find(a => a.id === 'ops');
    expect(research?.bindings).toEqual([
      { channel: 'slack', accountId: null, advanced: false },
      { channel: 'discord', accountId: 'team', advanced: false },
    ]);
    expect(ops?.bindings).toEqual([{ channel: 'telegram', accountId: null, advanced: false }]);
  });

  it('flags peer/guild/non-route bindings as advanced', async () => {
    const configPath = await configFixture({
      agents: { list: [{ id: 'research' }] },
      bindings: [
        { agentId: 'research', match: { channel: 'whatsapp', peer: { kind: 'direct', id: '+1' } } },
        { agentId: 'research', type: 'acp', match: { channel: 'slack' } },
      ],
    });
    const research = summarizeAgentConfig(
      readAgentConfigSnapshot({ configPath }).config
    ).agents.find(a => a.id === 'research');

    expect(research?.bindings).toEqual([
      { channel: 'whatsapp', accountId: null, advanced: true },
      { channel: 'slack', accountId: null, advanced: true },
    ]);
  });

  it('skips malformed binding entries instead of failing the read', async () => {
    const configPath = await configFixture({
      agents: { list: [{ id: 'research' }] },
      bindings: [
        { agentId: 'research', match: { channel: 'slack' } },
        { match: { channel: 'discord' } }, // no agentId
        { agentId: 'research' }, // no match
        'not-an-object',
        { agentId: 'research', match: {} }, // no channel
      ],
    });
    const research = summarizeAgentConfig(
      readAgentConfigSnapshot({ configPath }).config
    ).agents.find(a => a.id === 'research');

    expect(research?.bindings).toEqual([{ channel: 'slack', accountId: null, advanced: false }]);
  });

  it('returns an empty bindings array when none are configured', async () => {
    const configPath = await configFixture({ agents: { list: [{ id: 'research' }] } });
    const research = summarizeAgentConfig(
      readAgentConfigSnapshot({ configPath }).config
    ).agents.find(a => a.id === 'research');

    expect(research?.bindings).toEqual([]);
  });

  it('reads implicit main but rejects an absent non-default agent', async () => {
    const configPath = await configFixture({ agents: { defaults: {} } });

    expect(readAgentSummary('main', { configPath }).agent.configured).toBe(false);
    expect(() => readAgentSummary('research', { configPath })).toThrowError(AgentConfigError);
  });

  it('rejects resource IDs that collapse to the implicit main agent', async () => {
    const configPath = await configFixture({ agents: { defaults: {} } });

    for (const agentId of ['@@@', '!!!', '----']) {
      expect(() => readAgentSummary(agentId, { configPath })).toThrowError(
        expect.objectContaining({ code: 'invalid_agent_id', status: 400 })
      );
    }
    expect(readAgentSummary('MAIN', { configPath }).agent.id).toBe('main');
  });

  it('does not expose filesystem details when reading config fails', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() =>
      readAgentConfigSnapshot({ configPath: '/missing/private/config.json' })
    ).toThrowError(
      expect.objectContaining({
        code: 'agent_config_read_failed',
        status: 500,
        message: 'Failed to read agent config',
      })
    );
    expect(log).toHaveBeenCalledWith(
      '[controller] Failed to read OpenClaw agent config:',
      expect.stringContaining('/missing/private/config.json')
    );
    log.mockRestore();
  });
});

describe('native agent config mutations', () => {
  it('updates one agent without replacing sibling entries and writes mode 0600', async () => {
    const configPath = await configFixture({
      agents: {
        list: [
          { id: 'main', model: { primary: 'kilocode/main' } },
          { id: 'research', model: 'kilocode/old' },
        ],
      },
      gateway: { port: 3001 },
    });
    const initial = readAgentConfigSnapshot({ configPath });
    const patch = AgentSettingsPatchBodySchema.parse({
      etag: initial.etag,
      set: { model: { primary: 'kilocode/new', fallbacks: ['kilocode/fallback'] } },
    });

    const result = await updateAgentSettings('research', patch, { configPath });

    expect(result.agent.model).toEqual({
      primary: 'kilocode/new',
      fallbacks: ['kilocode/fallback'],
      source: 'agent',
    });
    expect(result.snapshot.config.agents?.list).toEqual([
      { id: 'main', model: { primary: 'kilocode/main' } },
      { id: 'research', model: { primary: 'kilocode/new', fallbacks: ['kilocode/fallback'] } },
    ]);
    expect(result.snapshot.config.gateway).toEqual({ port: 3001 });
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('preserves model subfields omitted from a partial model patch', async () => {
    const configPath = await configFixture({
      agents: {
        list: [
          { id: 'research', model: { primary: 'kilocode/old', fallbacks: ['kilocode/keep'] } },
        ],
      },
    });
    const patch = AgentSettingsPatchBodySchema.parse({
      set: { model: { primary: 'kilocode/new' } },
    });

    const result = await updateAgentSettings('research', patch, { configPath });

    expect(result.agent.model).toEqual({
      primary: 'kilocode/new',
      fallbacks: ['kilocode/keep'],
      source: 'agent',
    });
  });

  it('materializes and updates implicit main', async () => {
    const configPath = await configFixture({ agents: { defaults: {} } });
    const patch = AgentSettingsPatchBodySchema.parse({
      set: { verboseDefault: 'off' },
    });

    const result = await updateAgentSettings('main', patch, { configPath });

    expect(result.agent.configured).toBe(true);
    expect(result.snapshot.config.agents?.list).toEqual([{ id: 'main', verboseDefault: 'off' }]);
  });

  it('updates agent defaults while preserving configured agents', async () => {
    const configPath = await configFixture({
      agents: { list: [{ id: 'research' }] },
    });
    const patch = AgentDefaultsPatchBodySchema.parse({
      set: { model: { primary: 'kilocode/default' }, thinkingDefault: 'medium' },
    });

    const result = await updateAgentDefaults(patch, { configPath });

    expect(result.defaults.model).toEqual({ primary: 'kilocode/default', fallbacks: [] });
    expect(result.snapshot.config.agents?.list).toEqual([{ id: 'research' }]);
  });

  it('serializes lifecycle mutations with native patches', async () => {
    const configPath = await configFixture({ agents: { list: [{ id: 'research' }] } });
    let markLifecycleStarted: () => void = () => {
      throw new Error('Lifecycle start signal was not initialized');
    };
    const lifecycleStarted = new Promise<void>(resolve => {
      markLifecycleStarted = resolve;
    });
    let releaseLifecycle: () => void = () => {
      throw new Error('Lifecycle release signal was not initialized');
    };
    const lifecycleGate = new Promise<void>(resolve => {
      releaseLifecycle = resolve;
    });

    const lifecycleMutation = serializeAgentConfigMutation(
      async () => {
        markLifecycleStarted();
        await lifecycleGate;
        const config = JSON.parse(await fsPromises.readFile(configPath, 'utf8')) as {
          agents: { list: Array<Record<string, unknown>> };
        };
        config.agents.list.push({ id: 'created-by-cli' });
        await fsPromises.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
          mode: 0o600,
        });
      },
      { configPath }
    );
    await lifecycleStarted;

    const patch = AgentSettingsPatchBodySchema.parse({ set: { verboseDefault: 'off' } });
    const nativePatch = updateAgentSettings('research', patch, { configPath });
    releaseLifecycle();
    await Promise.all([lifecycleMutation, nativePatch]);

    const updated = readAgentConfigSnapshot({ configPath });
    expect(updated.config.agents?.list).toEqual([
      { id: 'research', verboseDefault: 'off' },
      { id: 'created-by-cli' },
    ]);
  });

  it('rejects stale etags without writing', async () => {
    const configPath = await configFixture({ agents: { list: [{ id: 'research' }] } });
    const before = await fsPromises.readFile(configPath, 'utf8');
    const patch = AgentSettingsPatchBodySchema.parse({
      etag: 'stale',
      set: { verboseDefault: 'off' },
    });

    await expect(updateAgentSettings('research', patch, { configPath })).rejects.toMatchObject({
      code: 'config_etag_conflict',
      status: 409,
    });
    expect(await fsPromises.readFile(configPath, 'utf8')).toBe(before);
  });

  it('rejects duplicate normalized IDs on mutation paths', async () => {
    const configPath = await configFixture({
      agents: { list: [{ id: 'Research' }, { id: 'research' }] },
    });
    const patch = AgentSettingsPatchBodySchema.parse({ set: { verboseDefault: 'off' } });

    await expect(updateAgentSettings('research', patch, { configPath })).rejects.toMatchObject({
      code: 'invalid_agent_config',
      status: 422,
    });
  });
});

describe('updateAgentBindings', () => {
  function channelsOf(configPath: string, agentId: string): string[] {
    const raw = (readAgentConfigSnapshot({ configPath }).config as { bindings?: unknown[] })
      .bindings;
    return (raw ?? [])
      .map(item => item as { agentId?: string; match?: { channel?: string; accountId?: string } })
      .filter(b => b.agentId === agentId && b.match?.accountId === undefined)
      .map(b => b.match?.channel as string);
  }

  it('adds the channels missing from the current set', async () => {
    const configPath = await configFixture({
      agents: { list: [{ id: 'research' }] },
      bindings: [{ type: 'route', agentId: 'research', match: { channel: 'slack' } }],
    });

    const { agent } = await updateAgentBindings(
      'research',
      { channels: ['slack', 'discord'] },
      { configPath }
    );

    expect(channelsOf(configPath, 'research').sort()).toEqual(['discord', 'slack']);
    expect(agent.bindings.map(b => b.channel).sort()).toEqual(['discord', 'slack']);
  });

  it('removes channels no longer in the desired set', async () => {
    const configPath = await configFixture({
      agents: { list: [{ id: 'research' }] },
      bindings: [
        { type: 'route', agentId: 'research', match: { channel: 'slack' } },
        { type: 'route', agentId: 'research', match: { channel: 'discord' } },
      ],
    });

    await updateAgentBindings('research', { channels: ['slack'] }, { configPath });

    expect(channelsOf(configPath, 'research')).toEqual(['slack']);
  });

  it('preserves advanced, account-scoped, and other agents bindings', async () => {
    const configPath = await configFixture({
      agents: { list: [{ id: 'research' }, { id: 'ops' }] },
      bindings: [
        { type: 'route', agentId: 'research', match: { channel: 'slack' } },
        {
          type: 'route',
          agentId: 'research',
          match: { channel: 'whatsapp', peer: { kind: 'direct', id: '+1' } },
        },
        { type: 'route', agentId: 'research', match: { channel: 'discord', accountId: 'team' } },
        { type: 'route', agentId: 'ops', match: { channel: 'telegram' } },
      ],
    });

    // Clear research's channel-level routes entirely.
    await updateAgentBindings('research', { channels: [] }, { configPath });

    const remaining = (
      readAgentConfigSnapshot({ configPath }).config as { bindings: unknown[] }
    ).bindings.map(item => item as { agentId: string; match: Record<string, unknown> });
    // research's plain slack route is gone…
    expect(
      remaining.some(
        b =>
          b.agentId === 'research' &&
          b.match.channel === 'slack' &&
          b.match.accountId === undefined &&
          b.match.peer === undefined
      )
    ).toBe(false);
    // …but the peer-scoped, account-scoped, and ops bindings remain.
    expect(remaining.some(b => b.agentId === 'research' && b.match.peer !== undefined)).toBe(true);
    expect(remaining.some(b => b.agentId === 'research' && b.match.accountId === 'team')).toBe(
      true
    );
    expect(remaining.some(b => b.agentId === 'ops' && b.match.channel === 'telegram')).toBe(true);
  });

  it('rejects a channel already routed to another agent', async () => {
    const configPath = await configFixture({
      agents: { list: [{ id: 'research' }, { id: 'ops' }] },
      bindings: [{ type: 'route', agentId: 'ops', match: { channel: 'slack' } }],
    });

    await expect(
      updateAgentBindings('research', { channels: ['slack'] }, { configPath })
    ).rejects.toMatchObject({ code: 'agent_binding_conflict', status: 409 });
    // The conflicting config was not modified.
    expect(channelsOf(configPath, 'ops')).toEqual(['slack']);
    expect(channelsOf(configPath, 'research')).toEqual([]);
  });

  it('rejects a stale etag without writing', async () => {
    const configPath = await configFixture({ agents: { list: [{ id: 'research' }] } });

    await expect(
      updateAgentBindings('research', { channels: ['slack'], etag: 'stale' }, { configPath })
    ).rejects.toMatchObject({ code: 'config_etag_conflict', status: 409 });
    expect(channelsOf(configPath, 'research')).toEqual([]);
  });

  it('rejects an unknown agent', async () => {
    const configPath = await configFixture({ agents: { list: [{ id: 'research' }] } });

    await expect(
      updateAgentBindings('ghost', { channels: ['slack'] }, { configPath })
    ).rejects.toMatchObject({ code: 'agent_not_found', status: 404 });
  });

  it('fails closed when the bindings array is an unexpected shape', async () => {
    const configPath = await configFixture({
      agents: { list: [{ id: 'research' }] },
      bindings: { not: 'an-array' },
    });

    await expect(
      updateAgentBindings('research', { channels: ['slack'] }, { configPath })
    ).rejects.toMatchObject({ code: 'invalid_agent_config', status: 422 });
  });
});
