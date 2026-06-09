import { describe, expect, it, vi } from 'vitest';
import {
  BasicAgentCreateBodySchema,
  OpenClawAgentCliError,
  bindAgentViaCli,
  createAgentViaCli,
  deleteAgentViaCli,
  listAgentBindingsViaCli,
  unbindAgentViaCli,
} from './openclaw-agent-cli';

// create/delete use `run`; bind/unbind use `runRaw`. Stub the unused one.
const noRaw = async () => ({ stdout: '', stderr: '', timedOut: false });
const noRun = async () => ({ stdout: '', stderr: '' });

describe('createAgentViaCli', () => {
  it('uses argv-only non-interactive JSON creation arguments', async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({
        agentId: 'Research Agent',
        name: 'Research',
        workspace: '/root/.openclaw/workspace-research',
        agentDir: '/root/.openclaw/agents/research/agent',
        model: 'kilocode/default',
        bindings: { added: [], updated: [], skipped: [], conflicts: [] },
      }),
      stderr: '',
    }));
    const body = BasicAgentCreateBodySchema.parse({
      name: 'Research',
      workspace: '/root/.openclaw/workspace-research',
      agentDir: '/root/.openclaw/agents/research/agent',
      model: 'kilocode/default',
      bindings: ['discord:team'],
    });

    const result = await createAgentViaCli(body, { run, runRaw: noRaw });

    expect(result.agentId).toBe('research-agent');
    expect(run).toHaveBeenCalledWith([
      'agents',
      'add',
      'Research',
      '--workspace',
      '/root/.openclaw/workspace-research',
      '--agent-dir',
      '/root/.openclaw/agents/research/agent',
      '--model',
      'kilocode/default',
      '--bind',
      'discord:team',
      '--non-interactive',
      '--json',
    ]);
  });

  it('rejects option-like create values before constructing CLI arguments', () => {
    for (const body of [
      { name: '--help', workspace: '/tmp/research' },
      { name: 'Research', workspace: '/tmp/research', model: '--config=/tmp/other.json' },
      { name: 'Research', workspace: '/tmp/research', bindings: ['--debug'] },
    ]) {
      expect(BasicAgentCreateBodySchema.safeParse(body).success).toBe(false);
    }
  });

  it('rejects malformed CLI JSON output', async () => {
    await expect(
      createAgentViaCli(
        BasicAgentCreateBodySchema.parse({ name: 'Research', workspace: '/tmp/research' }),
        { run: async () => ({ stdout: 'not-json', stderr: '' }), runRaw: noRaw }
      )
    ).rejects.toMatchObject({ code: 'openclaw_cli_failed', status: 502 });
  });
});

describe('deleteAgentViaCli', () => {
  it('uses forced JSON deletion arguments and parses deletion summary', async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({
        agentId: 'Research Agent',
        workspace: '/root/.openclaw/workspace-research',
        agentDir: '/root/.openclaw/agents/research/agent',
        sessionsDir: '/root/.openclaw/agents/research/sessions',
        removedBindings: 2,
        removedAllow: 1,
      }),
      stderr: '',
    }));

    const result = await deleteAgentViaCli('research', { run, runRaw: noRaw });

    expect(run).toHaveBeenCalledWith(['agents', 'delete', 'research', '--force', '--json']);
    expect(result.agentId).toBe('research-agent');
    expect(result.removedBindings).toBe(2);
    expect(result.removedAllow).toBe(1);
  });

  it('propagates typed CLI operation failures', async () => {
    await expect(
      deleteAgentViaCli('main', {
        runRaw: noRaw,
        run: async () => {
          throw new OpenClawAgentCliError(
            400,
            'reserved_agent_id',
            'The default agent is reserved'
          );
        },
      })
    ).rejects.toMatchObject({ code: 'reserved_agent_id', status: 400 });
  });
});

describe('bindAgentViaCli', () => {
  it('builds repeatable --bind args and parses the JSON summary', async () => {
    const runRaw = vi.fn(async (_args: string[]) => ({
      stdout: JSON.stringify({
        agentId: 'research',
        added: ['slack'],
        updated: [],
        skipped: [],
        conflicts: [],
      }),
      stderr: '',
      timedOut: false,
    }));

    const result = await bindAgentViaCli('research', ['slack', 'discord:team'], {
      run: noRun,
      runRaw,
    });

    expect(runRaw).toHaveBeenCalledWith([
      'agents',
      'bind',
      '--agent',
      'research',
      '--bind',
      'slack',
      '--bind',
      'discord:team',
      '--json',
    ]);
    expect(result.added).toEqual(['slack']);
  });

  it('parses the JSON summary even when the CLI exits non-zero on conflict', async () => {
    const runRaw = async () => ({
      stdout: JSON.stringify({
        agentId: 'research',
        added: [],
        updated: [],
        skipped: [],
        conflicts: ['slack (agent=ops)'],
      }),
      stderr: '',
      timedOut: false,
    });

    const result = await bindAgentViaCli('research', ['slack'], { run: noRun, runRaw });

    expect(result.conflicts).toEqual(['slack (agent=ops)']);
  });

  it('maps a non-JSON not-found failure to 404', async () => {
    const runRaw = async () => ({
      stdout: '',
      stderr: 'Agent "ghost" not found.',
      timedOut: false,
    });
    await expect(bindAgentViaCli('ghost', ['slack'], { run: noRun, runRaw })).rejects.toMatchObject(
      { code: 'agent_not_found', status: 404 }
    );
  });

  it('maps a timeout to 504', async () => {
    const runRaw = async () => ({ stdout: '', stderr: '', timedOut: true });
    await expect(
      bindAgentViaCli('research', ['slack'], { run: noRun, runRaw })
    ).rejects.toMatchObject({ code: 'openclaw_cli_timeout', status: 504 });
  });
});

describe('unbindAgentViaCli', () => {
  it('builds specific --bind args (never --all) and parses the summary', async () => {
    const runRaw = vi.fn(async (_args: string[]) => ({
      stdout: JSON.stringify({
        agentId: 'research',
        removed: ['discord'],
        missing: [],
        conflicts: [],
      }),
      stderr: '',
      timedOut: false,
    }));

    const result = await unbindAgentViaCli('research', ['discord'], { run: noRun, runRaw });

    expect(runRaw).toHaveBeenCalledWith([
      'agents',
      'unbind',
      '--agent',
      'research',
      '--bind',
      'discord',
      '--json',
    ]);
    expect(runRaw.mock.calls[0][0]).not.toContain('--all');
    expect(result.removed).toEqual(['discord']);
  });
});

describe('listAgentBindingsViaCli', () => {
  it('filters by agent and parses the list', async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify([
        { agentId: 'research', match: { channel: 'slack' }, description: 'slack' },
      ]),
      stderr: '',
    }));

    const result = await listAgentBindingsViaCli('research', { run, runRaw: noRaw });

    expect(run).toHaveBeenCalledWith(['agents', 'bindings', '--agent', 'research', '--json']);
    expect(result[0].match.channel).toBe('slack');
  });

  it('lists all bindings when no agent filter is given', async () => {
    const run = vi.fn(async () => ({ stdout: '[]', stderr: '' }));
    await listAgentBindingsViaCli(undefined, { run, runRaw: noRaw });
    expect(run).toHaveBeenCalledWith(['agents', 'bindings', '--json']);
  });
});
