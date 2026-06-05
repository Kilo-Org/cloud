import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readAgentConfigSnapshot,
  readAgentSummary,
  serializeAgentConfigMutation,
} from './openclaw-agent-config';
import {
  setAgentBindings,
  type SetAgentBindingsDeps,
  type AgentBindingsPutBody,
} from './openclaw-agent-bindings';
import type { BindAgentCliResult, UnbindAgentCliResult } from './openclaw-agent-cli';

const tempDirs: string[] = [];

async function configFixture(config: unknown): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'kiloclaw-agent-bindings-'));
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

type CliMocks = {
  bindViaCli: ReturnType<typeof vi.fn>;
  unbindViaCli: ReturnType<typeof vi.fn>;
  deps: SetAgentBindingsDeps;
};

function cliMocks(overrides: { bindConflicts?: string[] } = {}): CliMocks {
  const bindViaCli = vi.fn(
    async (agentId: string, specs: string[]): Promise<BindAgentCliResult> => ({
      agentId,
      added: specs,
      updated: [],
      skipped: [],
      conflicts: overrides.bindConflicts ?? [],
    })
  );
  const unbindViaCli = vi.fn(
    async (agentId: string, specs: string[]): Promise<UnbindAgentCliResult> => ({
      agentId,
      removed: specs,
      missing: [],
      conflicts: [],
    })
  );
  return {
    bindViaCli,
    unbindViaCli,
    deps: {
      bindViaCli: bindViaCli as unknown as SetAgentBindingsDeps['bindViaCli'],
      unbindViaCli: unbindViaCli as unknown as SetAgentBindingsDeps['unbindViaCli'],
      serializeMutation: serializeAgentConfigMutation,
      readSnapshot: readAgentConfigSnapshot,
      readSummary: readAgentSummary,
    },
  };
}

const body = (channels: string[], etag?: string): AgentBindingsPutBody => ({ channels, etag });

describe('setAgentBindings', () => {
  it('binds the channels missing from the current set', async () => {
    const configPath = await configFixture({
      agents: { list: [{ id: 'research' }] },
      bindings: [{ agentId: 'research', match: { channel: 'slack' } }],
    });
    const { bindViaCli, unbindViaCli, deps } = cliMocks();

    await setAgentBindings('research', body(['slack', 'discord']), deps, { configPath });

    expect(bindViaCli).toHaveBeenCalledWith('research', ['discord']);
    expect(unbindViaCli).not.toHaveBeenCalled();
  });

  it('unbinds channels no longer in the desired set', async () => {
    const configPath = await configFixture({
      agents: { list: [{ id: 'research' }] },
      bindings: [
        { agentId: 'research', match: { channel: 'slack' } },
        { agentId: 'research', match: { channel: 'discord' } },
      ],
    });
    const { bindViaCli, unbindViaCli, deps } = cliMocks();

    await setAgentBindings('research', body(['slack']), deps, { configPath });

    expect(unbindViaCli).toHaveBeenCalledWith('research', ['discord']);
    expect(bindViaCli).not.toHaveBeenCalled();
  });

  it('never unbinds advanced or account-scoped bindings', async () => {
    const configPath = await configFixture({
      agents: { list: [{ id: 'research' }] },
      bindings: [
        { agentId: 'research', match: { channel: 'slack' } },
        // advanced (peer) + account-scoped — both must be preserved
        { agentId: 'research', match: { channel: 'whatsapp', peer: { kind: 'direct', id: '+1' } } },
        { agentId: 'research', match: { channel: 'discord', accountId: 'team' } },
      ],
    });
    const { unbindViaCli, deps } = cliMocks();

    // Desired set is empty → only the channel-level default-account slack route is removed.
    await setAgentBindings('research', body([]), deps, { configPath });

    expect(unbindViaCli).toHaveBeenCalledWith('research', ['slack']);
  });

  it('is a no-op when the desired set already matches', async () => {
    const configPath = await configFixture({
      agents: { list: [{ id: 'research' }] },
      bindings: [{ agentId: 'research', match: { channel: 'slack' } }],
    });
    const { bindViaCli, unbindViaCli, deps } = cliMocks();

    await setAgentBindings('research', body(['slack']), deps, { configPath });

    expect(bindViaCli).not.toHaveBeenCalled();
    expect(unbindViaCli).not.toHaveBeenCalled();
  });

  it('rejects a stale etag without touching the CLI', async () => {
    const configPath = await configFixture({ agents: { list: [{ id: 'research' }] } });
    const { bindViaCli, unbindViaCli, deps } = cliMocks();

    await expect(
      setAgentBindings('research', body(['slack'], 'stale-etag'), deps, { configPath })
    ).rejects.toMatchObject({ code: 'config_etag_conflict', status: 409 });
    expect(bindViaCli).not.toHaveBeenCalled();
    expect(unbindViaCli).not.toHaveBeenCalled();
  });

  it('rejects an unknown agent', async () => {
    const configPath = await configFixture({ agents: { list: [{ id: 'research' }] } });
    const { bindViaCli, deps } = cliMocks();

    await expect(
      setAgentBindings('ghost', body(['slack']), deps, { configPath })
    ).rejects.toMatchObject({ code: 'agent_not_found', status: 404 });
    expect(bindViaCli).not.toHaveBeenCalled();
  });

  it('surfaces a CLI conflict as agent_binding_conflict', async () => {
    const configPath = await configFixture({ agents: { list: [{ id: 'research' }] } });
    const { deps } = cliMocks({ bindConflicts: ['slack'] });

    await expect(
      setAgentBindings('research', body(['slack']), deps, { configPath })
    ).rejects.toMatchObject({ code: 'agent_binding_conflict', status: 409 });
  });
});
