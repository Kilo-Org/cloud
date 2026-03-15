import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MayorGastownClient } from './client';
import type {
  Agent,
  Bead,
  Convoy,
  ConvoyDetail,
  ConvoyStartResult,
  Rig,
  SlingBatchResult,
  SlingResult,
} from './types';

// Mock the @kilocode/plugin module to avoid its broken ESM import chain.
import { z } from 'zod';

function toolFn(def: Record<string, unknown>) {
  return def;
}
toolFn.schema = z;

vi.mock('@kilocode/plugin', () => ({
  tool: toolFn,
}));

const { createMayorTools } = await import('./mayor-tools');

const FAKE_BEAD: Bead = {
  bead_id: 'bead-1',
  type: 'issue',
  status: 'in_progress',
  title: 'Add auth middleware',
  body: null,
  rig_id: 'rig-1',
  parent_bead_id: null,
  assignee_agent_bead_id: 'agent-bead-1',
  priority: 'medium',
  labels: [],
  metadata: {},
  created_by: null,
  created_at: '2026-03-05T00:00:00Z',
  updated_at: '2026-03-05T00:00:00Z',
  closed_at: null,
};

const FAKE_AGENT: Agent = {
  id: 'agent-1',
  rig_id: 'rig-1',
  role: 'polecat',
  name: 'Toast',
  identity: 'toast-rig1',
  status: 'working',
  current_hook_bead_id: 'bead-1',
  dispatch_attempts: 0,
  last_activity_at: '2026-03-05T00:00:00Z',
  checkpoint: null,
  created_at: '2026-03-05T00:00:00Z',
};

const FAKE_CONVOY: Convoy = {
  id: 'convoy-1',
  title: 'JWT Authentication',
  status: 'active',
  staged: false,
  total_beads: 3,
  closed_beads: 1,
  created_by: null,
  created_at: '2026-03-05T00:00:00Z',
  landed_at: null,
};

const FAKE_STAGED_CONVOY: Convoy = {
  id: 'convoy-staged-1',
  title: 'Big Refactor',
  status: 'active',
  staged: true,
  total_beads: 2,
  closed_beads: 0,
  created_by: null,
  created_at: '2026-03-05T00:00:00Z',
  landed_at: null,
};

function makeFakeMayorClient(overrides: Partial<MayorGastownClient> = {}): MayorGastownClient {
  return {
    sling: vi.fn<() => Promise<SlingResult>>().mockResolvedValue({
      bead: FAKE_BEAD,
      agent: FAKE_AGENT,
    }),
    listRigs: vi.fn<() => Promise<Rig[]>>().mockResolvedValue([]),
    listBeads: vi.fn<() => Promise<Bead[]>>().mockResolvedValue([]),
    listAgents: vi.fn<() => Promise<Agent[]>>().mockResolvedValue([]),
    sendMail: vi.fn().mockResolvedValue(undefined),
    slingBatch: vi.fn<() => Promise<SlingBatchResult>>().mockResolvedValue({
      convoy: FAKE_CONVOY,
      beads: [
        {
          bead: { ...FAKE_BEAD, bead_id: 'bead-1', title: 'Task 1' },
          agent: { ...FAKE_AGENT, id: 'agent-1', name: 'Toast' },
        },
        {
          bead: { ...FAKE_BEAD, bead_id: 'bead-2', title: 'Task 2' },
          agent: { ...FAKE_AGENT, id: 'agent-2', name: 'Muffin' },
        },
        {
          bead: { ...FAKE_BEAD, bead_id: 'bead-3', title: 'Task 3' },
          agent: { ...FAKE_AGENT, id: 'agent-3', name: 'Bagel' },
        },
      ],
    }),
    listConvoys: vi.fn<() => Promise<Convoy[]>>().mockResolvedValue([FAKE_CONVOY]),
    startConvoy: vi.fn<() => Promise<ConvoyStartResult>>().mockResolvedValue({
      convoy: { ...FAKE_STAGED_CONVOY, status: 'active', staged: false },
      beads: [
        {
          bead: { ...FAKE_BEAD, bead_id: 'bead-1', title: 'Task 1' },
          agent: { ...FAKE_AGENT, id: 'agent-1', name: 'Toast' },
        },
        {
          bead: { ...FAKE_BEAD, bead_id: 'bead-2', title: 'Task 2' },
          agent: { ...FAKE_AGENT, id: 'agent-2', name: 'Muffin' },
        },
      ],
    }),
    getConvoyStatus: vi.fn<() => Promise<ConvoyDetail>>().mockResolvedValue({
      ...FAKE_CONVOY,
      staged: false,
      beads: [
        {
          bead_id: 'bead-1',
          title: 'Task 1',
          status: 'closed',
          rig_id: 'rig-1',
          assignee_agent_name: 'Toast',
        },
        {
          bead_id: 'bead-2',
          title: 'Task 2',
          status: 'in_progress',
          rig_id: 'rig-1',
          assignee_agent_name: 'Muffin',
        },
        {
          bead_id: 'bead-3',
          title: 'Task 3',
          status: 'open',
          rig_id: 'rig-1',
          assignee_agent_name: 'Bagel',
        },
      ],
    }),
    updateBead: vi.fn<() => Promise<Bead>>().mockResolvedValue(FAKE_BEAD),
    reassignBead: vi.fn<() => Promise<Bead>>().mockResolvedValue(FAKE_BEAD),
    deleteBead: vi.fn().mockResolvedValue(undefined),
    resetAgent: vi.fn().mockResolvedValue(undefined),
    closeConvoy: vi.fn().mockResolvedValue(undefined),
    updateConvoy: vi.fn().mockResolvedValue(undefined),
    acknowledgeEscalation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as MayorGastownClient;
}

const CTX = undefined as never;

describe('mayor tools', () => {
  let client: ReturnType<typeof makeFakeMayorClient>;
  let tools: ReturnType<typeof createMayorTools>;

  beforeEach(() => {
    client = makeFakeMayorClient();
    tools = createMayorTools(client);
  });

  describe('gt_sling', () => {
    it('delegates a single task and returns result summary', async () => {
      const result = await tools.gt_sling.execute(
        { rig_id: 'rig-1', title: 'Fix bug', body: 'Details here' },
        CTX
      );
      expect(result).toContain('Task slung successfully');
      expect(result).toContain('bead-1');
      expect(client.sling).toHaveBeenCalledWith({
        rig_id: 'rig-1',
        title: 'Fix bug',
        body: 'Details here',
        metadata: undefined,
      });
    });
  });

  describe('gt_sling_batch', () => {
    it('creates a convoy with multiple beads', async () => {
      const tasks = [
        { title: 'Task 1', body: 'Details 1' },
        { title: 'Task 2' },
        { title: 'Task 3', body: 'Details 3' },
      ];

      const result = await tools.gt_sling_batch.execute(
        { rig_id: 'rig-1', convoy_title: 'JWT Authentication', tasks },
        CTX
      );

      expect(result).toContain('Convoy created: "JWT Authentication"');
      expect(result).toContain('Tracking 3 beads');
      expect(result).toContain('Task 1');
      expect(result).toContain('Task 2');
      expect(result).toContain('Task 3');
      expect(client.slingBatch).toHaveBeenCalledWith({
        rig_id: 'rig-1',
        convoy_title: 'JWT Authentication',
        tasks: [
          { title: 'Task 1', body: 'Details 1' },
          { title: 'Task 2' },
          { title: 'Task 3', body: 'Details 3' },
        ],
      });
    });

    it('passes depends_on through to the client', async () => {
      const tasks = [
        { title: 'Scaffold' },
        { title: 'Add API', depends_on: [0] },
        { title: 'Add tests', depends_on: [0, 1] },
      ];

      await tools.gt_sling_batch.execute(
        { rig_id: 'rig-1', convoy_title: 'With Dependencies', tasks },
        CTX
      );

      expect(client.slingBatch).toHaveBeenCalledWith({
        rig_id: 'rig-1',
        convoy_title: 'With Dependencies',
        tasks: [
          { title: 'Scaffold' },
          { title: 'Add API', depends_on: [0] },
          { title: 'Add tests', depends_on: [0, 1] },
        ],
      });
    });
  });

  describe('gt_list_convoys', () => {
    it('returns convoys as JSON', async () => {
      const result = await tools.gt_list_convoys.execute({}, CTX);
      const parsed = JSON.parse(result);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe('convoy-1');
      expect(parsed[0].title).toBe('JWT Authentication');
      expect(client.listConvoys).toHaveBeenCalledOnce();
    });

    it('returns a message when no active convoys', async () => {
      client = makeFakeMayorClient({
        listConvoys: vi.fn<() => Promise<Convoy[]>>().mockResolvedValue([]),
      });
      tools = createMayorTools(client);

      const result = await tools.gt_list_convoys.execute({}, CTX);
      expect(result).toContain('No active convoys');
    });
  });

  describe('gt_convoy_status', () => {
    it('returns detailed convoy status as JSON', async () => {
      const result = await tools.gt_convoy_status.execute({ convoy_id: 'convoy-1' }, CTX);
      const parsed = JSON.parse(result);
      expect(parsed.id).toBe('convoy-1');
      expect(parsed.beads).toHaveLength(3);
      expect(parsed.beads[0].status).toBe('closed');
      expect(parsed.beads[1].assignee_agent_name).toBe('Muffin');
      expect(client.getConvoyStatus).toHaveBeenCalledWith('convoy-1');
    });
  });

  describe('gt_list_rigs', () => {
    it('returns empty message when no rigs', async () => {
      const result = await tools.gt_list_rigs.execute({}, CTX);
      expect(result).toContain('No rigs configured');
    });
  });

  describe('gt_bead_update', () => {
    it('updates bead fields and returns summary', async () => {
      const result = await tools.gt_bead_update.execute(
        { rig_id: 'rig-1', bead_id: 'bead-1', status: 'closed', priority: 'high' },
        CTX
      );
      expect(result).toContain('bead-1');
      expect(result).toContain('updated');
      expect(client.updateBead).toHaveBeenCalledWith('rig-1', 'bead-1', {
        title: undefined,
        body: undefined,
        status: 'closed',
        priority: 'high',
        labels: undefined,
      });
    });
  });

  describe('gt_bead_reassign', () => {
    it('reassigns bead to new agent', async () => {
      const result = await tools.gt_bead_reassign.execute(
        { rig_id: 'rig-1', bead_id: 'bead-1', agent_id: 'agent-2' },
        CTX
      );
      expect(result).toContain('bead-1');
      expect(result).toContain('agent-2');
      expect(client.reassignBead).toHaveBeenCalledWith('rig-1', 'bead-1', 'agent-2');
    });
  });

  describe('gt_bead_delete', () => {
    it('deletes bead and confirms', async () => {
      const result = await tools.gt_bead_delete.execute(
        { rig_id: 'rig-1', bead_id: 'bead-1' },
        CTX
      );
      expect(result).toContain('bead-1');
      expect(result).toContain('deleted');
      expect(client.deleteBead).toHaveBeenCalledWith('rig-1', 'bead-1');
    });
  });

  describe('gt_agent_reset', () => {
    it('resets agent to idle', async () => {
      const result = await tools.gt_agent_reset.execute(
        { rig_id: 'rig-1', agent_id: 'agent-1' },
        CTX
      );
      expect(result).toContain('agent-1');
      expect(result).toContain('idle');
      expect(client.resetAgent).toHaveBeenCalledWith('rig-1', 'agent-1');
    });
  });

  describe('gt_convoy_close', () => {
    it('force-closes a convoy', async () => {
      const result = await tools.gt_convoy_close.execute({ convoy_id: 'convoy-1' }, CTX);
      expect(result).toContain('convoy-1');
      expect(result).toContain('closed');
      expect(client.closeConvoy).toHaveBeenCalledWith('convoy-1');
    });
  });

  describe('gt_convoy_update', () => {
    it('updates convoy metadata', async () => {
      const result = await tools.gt_convoy_update.execute(
        { convoy_id: 'convoy-1', merge_mode: 'review-and-merge' },
        CTX
      );
      expect(result).toContain('convoy-1');
      expect(result).toContain('updated');
      expect(client.updateConvoy).toHaveBeenCalledWith('convoy-1', {
        merge_mode: 'review-and-merge',
        feature_branch: undefined,
      });
    });
  });

  describe('gt_escalation_acknowledge', () => {
    it('acknowledges an escalation', async () => {
      const result = await tools.gt_escalation_acknowledge.execute({ escalation_id: 'esc-1' }, CTX);
      expect(result).toContain('esc-1');
      expect(result).toContain('acknowledged');
      expect(client.acknowledgeEscalation).toHaveBeenCalledWith('esc-1');
    });
  });

  describe('gt_sling_batch staged', () => {
    it('passes staged=true to client and reports convoy as staged', async () => {
      client = makeFakeMayorClient({
        slingBatch: vi.fn<() => Promise<SlingBatchResult>>().mockResolvedValue({
          convoy: FAKE_STAGED_CONVOY,
          beads: [
            {
              bead: { ...FAKE_BEAD, bead_id: 'bead-1', title: 'Task 1' },
              agent: null,
            },
            {
              bead: { ...FAKE_BEAD, bead_id: 'bead-2', title: 'Task 2' },
              agent: null,
            },
          ],
        }),
      });
      tools = createMayorTools(client);

      const tasks = [{ title: 'Task 1' }, { title: 'Task 2', depends_on: [0] }];
      const result = await tools.gt_sling_batch.execute(
        { rig_id: 'rig-1', convoy_title: 'Big Refactor', tasks, staged: true },
        CTX
      );

      expect(result).toContain('Convoy staged:');
      expect(result).toContain('convoy-staged-1');
      expect(result).toContain('gt_convoy_start');
      expect(result).toContain('unassigned, pending gt_convoy_start');
      expect(client.slingBatch).toHaveBeenCalledWith(expect.objectContaining({ staged: true }));
    });
  });

  describe('gt_convoy_start', () => {
    it('starts a staged convoy and reports bead count', async () => {
      const result = await tools.gt_convoy_start.execute({ convoy_id: 'convoy-staged-1' }, CTX);
      expect(result).toContain('Convoy started');
      expect(result).toContain('2 bead(s)');
      expect(client.startConvoy).toHaveBeenCalledWith('convoy-staged-1');
    });
  });
});
