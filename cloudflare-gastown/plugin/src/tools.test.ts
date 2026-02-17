import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GastownClient } from './client';
import type { Bead, Mail, PrimeContext } from './types';

// Mock the @opencode-ai/plugin module to avoid its broken ESM import chain.
// The real `tool` is a passthrough that attaches `tool.schema = z`.
import { z } from 'zod';

function toolFn(def: Record<string, unknown>) {
  return def;
}
toolFn.schema = z;

vi.mock('@opencode-ai/plugin', () => ({
  tool: toolFn,
}));

// Import after mock is registered
const { createTools } = await import('./tools');

function makeFakeClient(overrides: Partial<GastownClient> = {}): GastownClient {
  return {
    prime: vi.fn<() => Promise<PrimeContext>>().mockResolvedValue({
      agent: {
        id: 'agent-1',
        role: 'polecat',
        name: 'Test Polecat',
        identity: 'test-polecat-1',
        cloud_agent_session_id: null,
        status: 'working',
        current_hook_bead_id: 'bead-1',
        last_activity_at: '2026-02-16T00:00:00Z',
        checkpoint: null,
        created_at: '2026-02-16T00:00:00Z',
      },
      hooked_bead: {
        id: 'bead-1',
        type: 'issue',
        status: 'in_progress',
        title: 'Fix the widget',
        body: null,
        assignee_agent_id: 'agent-1',
        convoy_id: null,
        molecule_id: null,
        priority: 'medium',
        labels: [],
        metadata: {},
        created_at: '2026-02-16T00:00:00Z',
        updated_at: '2026-02-16T00:00:00Z',
        closed_at: null,
      },
      undelivered_mail: [],
      open_beads: [],
    }),
    getBead: vi.fn<(id: string) => Promise<Bead>>().mockResolvedValue({
      id: 'bead-1',
      type: 'issue',
      status: 'open',
      title: 'Test bead',
      body: null,
      assignee_agent_id: null,
      convoy_id: null,
      molecule_id: null,
      priority: 'medium',
      labels: [],
      metadata: {},
      created_at: '2026-02-16T00:00:00Z',
      updated_at: '2026-02-16T00:00:00Z',
      closed_at: null,
    }),
    closeBead: vi.fn<(id: string) => Promise<Bead>>().mockResolvedValue({
      id: 'bead-1',
      type: 'issue',
      status: 'closed',
      title: 'Test bead',
      body: null,
      assignee_agent_id: null,
      convoy_id: null,
      molecule_id: null,
      priority: 'medium',
      labels: [],
      metadata: {},
      created_at: '2026-02-16T00:00:00Z',
      updated_at: '2026-02-16T00:00:00Z',
      closed_at: '2026-02-16T01:00:00Z',
    }),
    done: vi.fn().mockResolvedValue(undefined),
    sendMail: vi.fn().mockResolvedValue(undefined),
    checkMail: vi.fn<() => Promise<Mail[]>>().mockResolvedValue([]),
    createEscalation: vi.fn<() => Promise<Bead>>().mockResolvedValue({
      id: 'esc-1',
      type: 'escalation',
      status: 'open',
      title: 'Blocked',
      body: null,
      assignee_agent_id: null,
      convoy_id: null,
      molecule_id: null,
      priority: 'high',
      labels: [],
      metadata: {},
      created_at: '2026-02-16T00:00:00Z',
      updated_at: '2026-02-16T00:00:00Z',
      closed_at: null,
    }),
    writeCheckpoint: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GastownClient;
}

// Tool context stub — tools that take no context-dependent args don't use it
const CTX = undefined as never;

describe('tools', () => {
  let client: ReturnType<typeof makeFakeClient>;
  let tools: ReturnType<typeof createTools>;

  beforeEach(() => {
    client = makeFakeClient();
    tools = createTools(client);
  });

  describe('gt_prime', () => {
    it('returns JSON-stringified prime context', async () => {
      const result = await tools.gt_prime.execute({}, CTX);
      expect(JSON.parse(result)).toHaveProperty('agent');
      expect(JSON.parse(result)).toHaveProperty('hooked_bead');
      expect(client.prime).toHaveBeenCalledOnce();
    });
  });

  describe('gt_bead_status', () => {
    it('returns bead details as JSON', async () => {
      const result = await tools.gt_bead_status.execute({ bead_id: 'bead-1' }, CTX);
      const parsed = JSON.parse(result);
      expect(parsed.id).toBe('bead-1');
      expect(client.getBead).toHaveBeenCalledWith('bead-1');
    });
  });

  describe('gt_bead_close', () => {
    it('closes the bead and returns updated bead', async () => {
      const result = await tools.gt_bead_close.execute({ bead_id: 'bead-1' }, CTX);
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('closed');
      expect(client.closeBead).toHaveBeenCalledWith('bead-1');
    });
  });

  describe('gt_done', () => {
    it('sends done signal with branch and optional fields', async () => {
      const result = await tools.gt_done.execute(
        { branch: 'feat/test', pr_url: 'https://github.com/pr/1', summary: 'stuff' },
        CTX
      );
      expect(result).toContain('Done signal sent');
      expect(client.done).toHaveBeenCalledWith({
        branch: 'feat/test',
        pr_url: 'https://github.com/pr/1',
        summary: 'stuff',
      });
    });

    it('works with only required branch arg', async () => {
      await tools.gt_done.execute({ branch: 'fix/bug' }, CTX);
      expect(client.done).toHaveBeenCalledWith({
        branch: 'fix/bug',
        pr_url: undefined,
        summary: undefined,
      });
    });
  });

  describe('gt_mail_send', () => {
    it('sends mail and returns confirmation', async () => {
      const result = await tools.gt_mail_send.execute(
        { to_agent_id: 'agent-2', subject: 'hi', body: 'hello' },
        CTX
      );
      expect(result).toContain('Mail sent to agent agent-2');
      expect(client.sendMail).toHaveBeenCalledWith({
        to_agent_id: 'agent-2',
        subject: 'hi',
        body: 'hello',
      });
    });
  });

  describe('gt_mail_check', () => {
    it('returns "No pending mail." when empty', async () => {
      const result = await tools.gt_mail_check.execute({}, CTX);
      expect(result).toBe('No pending mail.');
    });

    it('returns mail as JSON when present', async () => {
      const mail: Mail[] = [
        {
          id: 'mail-1',
          from_agent_id: 'agent-2',
          to_agent_id: 'agent-1',
          subject: 'update',
          body: 'progress report',
          delivered: false,
          created_at: '2026-02-16T00:00:00Z',
          delivered_at: null,
        },
      ];
      client = makeFakeClient({
        checkMail: vi.fn<() => Promise<Mail[]>>().mockResolvedValue(mail),
      });
      tools = createTools(client);

      const result = await tools.gt_mail_check.execute({}, CTX);
      const parsed = JSON.parse(result);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].subject).toBe('update');
    });
  });

  describe('gt_escalate', () => {
    it('creates escalation and returns confirmation', async () => {
      const result = await tools.gt_escalate.execute(
        { title: 'Blocked on auth', priority: 'high' },
        CTX
      );
      expect(result).toContain('Escalation created: esc-1');
      expect(result).toContain('priority: high');
    });

    it('parses metadata JSON string', async () => {
      await tools.gt_escalate.execute({ title: 'Test', metadata: '{"key": "value"}' }, CTX);
      expect(client.createEscalation).toHaveBeenCalledWith({
        title: 'Test',
        body: undefined,
        priority: undefined,
        metadata: { key: 'value' },
      });
    });

    it('throws on invalid metadata JSON', async () => {
      await expect(
        tools.gt_escalate.execute({ title: 'Test', metadata: 'not json' }, CTX)
      ).rejects.toThrow('Invalid JSON in "metadata"');
    });
  });

  describe('gt_checkpoint', () => {
    it('persists checkpoint data', async () => {
      const result = await tools.gt_checkpoint.execute(
        { data: '{"step": 3, "files": ["a.ts"]}' },
        CTX
      );
      expect(result).toBe('Checkpoint saved.');
      expect(client.writeCheckpoint).toHaveBeenCalledWith({ step: 3, files: ['a.ts'] });
    });

    it('throws on invalid JSON', async () => {
      await expect(tools.gt_checkpoint.execute({ data: '{broken' }, CTX)).rejects.toThrow(
        'Invalid JSON in "data"'
      );
    });
  });
});
