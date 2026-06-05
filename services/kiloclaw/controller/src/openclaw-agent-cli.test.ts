import { describe, expect, it, vi } from 'vitest';
import {
  BasicAgentCreateBodySchema,
  OpenClawAgentCliError,
  createAgentViaCli,
  deleteAgentViaCli,
} from './openclaw-agent-cli';

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

    const result = await createAgentViaCli(body, { run });

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
        { run: async () => ({ stdout: 'not-json', stderr: '' }) }
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

    const result = await deleteAgentViaCli('research', { run });

    expect(run).toHaveBeenCalledWith(['agents', 'delete', 'research', '--force', '--json']);
    expect(result.agentId).toBe('research-agent');
    expect(result.removedBindings).toBe(2);
    expect(result.removedAllow).toBe(1);
  });

  it('propagates typed CLI operation failures', async () => {
    await expect(
      deleteAgentViaCli('main', {
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
