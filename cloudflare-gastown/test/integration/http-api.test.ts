import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { signAgentJWT } from '../../src/util/jwt.util';

const JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-chars-long';

/**
 * In the test environment ENVIRONMENT=development, so authMiddleware is skipped.
 * These helpers provide headers for requests that don't need auth in dev mode.
 */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...extra,
  };
}

function agentHeaders(
  payload: { agentId: string; rigId: string; townId?: string; userId?: string },
  extra: Record<string, string> = {}
): Record<string, string> {
  const token = signAgentJWT(
    {
      agentId: payload.agentId,
      rigId: payload.rigId,
      townId: payload.townId ?? 'test-town',
      userId: payload.userId ?? 'test-user',
    },
    JWT_SECRET
  );
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function api(path: string): string {
  return `http://localhost${path}`;
}

describe('HTTP API', () => {
  const rigId = () => `rig-${crypto.randomUUID()}`;

  // ── Dashboard ──────────────────────────────────────────────────────────

  describe('dashboard', () => {
    it('should serve HTML at /', async () => {
      const res = await SELF.fetch(api('/'));
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('Gastown Dashboard');
    });
  });

  // ── Health ─────────────────────────────────────────────────────────────

  describe('health', () => {
    it('should return ok', async () => {
      const res = await SELF.fetch(api('/health'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    });
  });

  // ── 404 ────────────────────────────────────────────────────────────────

  describe('not found', () => {
    it('should return 404 for unknown routes', async () => {
      const res = await SELF.fetch(api('/api/unknown'), {
        headers: headers(),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe('Not found');
    });
  });

  // ── Beads ──────────────────────────────────────────────────────────────

  describe('beads', () => {
    it('should create a bead', async () => {
      const id = rigId();
      const res = await SELF.fetch(api(`/api/rigs/${id}/beads`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          type: 'issue',
          title: 'Fix the widget',
          body: 'It is broken',
          priority: 'high',
          labels: ['bug'],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.title).toBe('Fix the widget');
      expect(body.data.type).toBe('issue');
      expect(body.data.status).toBe('open');
      expect(body.data.priority).toBe('high');
    });

    it('should validate required fields', async () => {
      const id = rigId();
      const res = await SELF.fetch(api(`/api/rigs/${id}/beads`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
    });

    it('should list beads', async () => {
      const id = rigId();
      // Create two beads
      await SELF.fetch(api(`/api/rigs/${id}/beads`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'Bead 1' }),
      });
      await SELF.fetch(api(`/api/rigs/${id}/beads`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'message', title: 'Bead 2' }),
      });

      const res = await SELF.fetch(api(`/api/rigs/${id}/beads`), {
        headers: headers(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
    });

    it('should filter beads by type', async () => {
      const id = rigId();
      await SELF.fetch(api(`/api/rigs/${id}/beads`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'Issue' }),
      });
      await SELF.fetch(api(`/api/rigs/${id}/beads`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'message', title: 'Message' }),
      });

      const res = await SELF.fetch(api(`/api/rigs/${id}/beads?type=issue`), {
        headers: headers(),
      });
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].type).toBe('issue');
    });

    it('should get a single bead', async () => {
      const id = rigId();
      const createRes = await SELF.fetch(api(`/api/rigs/${id}/beads`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'Get me' }),
      });
      const created = await createRes.json();
      const beadId = created.data.id;

      const res = await SELF.fetch(api(`/api/rigs/${id}/beads/${beadId}`), {
        headers: headers(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(beadId);
      expect(body.data.title).toBe('Get me');
    });

    it('should return 404 for non-existent bead', async () => {
      const id = rigId();
      const res = await SELF.fetch(api(`/api/rigs/${id}/beads/nonexistent`), {
        headers: headers(),
      });
      expect(res.status).toBe(404);
    });

    it('should update bead status', async () => {
      const id = rigId();
      // Create bead and agent
      const beadRes = await SELF.fetch(api(`/api/rigs/${id}/beads`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'Status test' }),
      });
      const bead = (await beadRes.json()).data;

      const agentRes = await SELF.fetch(api(`/api/rigs/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'polecat', name: 'P1', identity: `p1-${id}` }),
      });
      const agent = (await agentRes.json()).data;

      const res = await SELF.fetch(api(`/api/rigs/${id}/beads/${bead.id}/status`), {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ status: 'in_progress', agent_id: agent.id }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe('in_progress');
    });

    it('should close a bead', async () => {
      const id = rigId();
      const beadRes = await SELF.fetch(api(`/api/rigs/${id}/beads`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'Close me' }),
      });
      const bead = (await beadRes.json()).data;

      const agentRes = await SELF.fetch(api(`/api/rigs/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'polecat', name: 'P1', identity: `close-${id}` }),
      });
      const agent = (await agentRes.json()).data;

      const res = await SELF.fetch(api(`/api/rigs/${id}/beads/${bead.id}/close`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ agent_id: agent.id }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe('closed');
      expect(body.data.closed_at).toBeDefined();
    });
  });

  // ── Agents ─────────────────────────────────────────────────────────────

  describe('agents', () => {
    it('should register an agent', async () => {
      const id = rigId();
      const res = await SELF.fetch(api(`/api/rigs/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'polecat', name: 'Polecat-1', identity: `p-${id}` }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.role).toBe('polecat');
      expect(body.data.name).toBe('Polecat-1');
      expect(body.data.status).toBe('idle');
    });

    it('should list agents', async () => {
      const id = rigId();
      await SELF.fetch(api(`/api/rigs/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'polecat', name: 'P1', identity: `p1-${id}` }),
      });
      await SELF.fetch(api(`/api/rigs/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'refinery', name: 'R1', identity: `r1-${id}` }),
      });

      const res = await SELF.fetch(api(`/api/rigs/${id}/agents`), {
        headers: headers(),
      });
      const body = await res.json();
      expect(body.data).toHaveLength(2);
    });

    it('should get agent by id', async () => {
      const id = rigId();
      const createRes = await SELF.fetch(api(`/api/rigs/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'polecat', name: 'P1', identity: `get-${id}` }),
      });
      const agent = (await createRes.json()).data;

      const res = await SELF.fetch(api(`/api/rigs/${id}/agents/${agent.id}`), {
        headers: headers(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(agent.id);
    });

    it('should return 404 for non-existent agent', async () => {
      const id = rigId();
      const res = await SELF.fetch(api(`/api/rigs/${id}/agents/nonexistent`), {
        headers: headers(),
      });
      expect(res.status).toBe(404);
    });
  });

  // ── Hooks ──────────────────────────────────────────────────────────────

  describe('hooks', () => {
    it('should hook and unhook a bead', async () => {
      const id = rigId();
      // Create agent and bead
      const agentRes = await SELF.fetch(api(`/api/rigs/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'polecat', name: 'P1', identity: `hook-${id}` }),
      });
      const agent = (await agentRes.json()).data;

      const beadRes = await SELF.fetch(api(`/api/rigs/${id}/beads`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'Hook target' }),
      });
      const bead = (await beadRes.json()).data;

      // Hook
      const hookRes = await SELF.fetch(api(`/api/rigs/${id}/agents/${agent.id}/hook`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ bead_id: bead.id }),
      });
      expect(hookRes.status).toBe(200);
      const hookBody = await hookRes.json();
      expect(hookBody.data.hooked).toBe(true);

      // Verify agent has hooked bead (stays idle until alarm dispatches to container)
      const agentCheck = await SELF.fetch(api(`/api/rigs/${id}/agents/${agent.id}`), {
        headers: headers(),
      });
      const agentState = (await agentCheck.json()).data;
      expect(agentState.status).toBe('idle');
      expect(agentState.current_hook_bead_id).toBe(bead.id);

      // Unhook
      const unhookRes = await SELF.fetch(api(`/api/rigs/${id}/agents/${agent.id}/hook`), {
        method: 'DELETE',
        headers: headers(),
      });
      expect(unhookRes.status).toBe(200);
    });

    it('should hook via agent JWT auth', async () => {
      const id = rigId();
      // Create agent and bead
      const agentRes = await SELF.fetch(api(`/api/rigs/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'polecat', name: 'P1', identity: `jwt-hook-${id}` }),
      });
      const agent = (await agentRes.json()).data;

      const beadRes = await SELF.fetch(api(`/api/rigs/${id}/beads`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'JWT hook target' }),
      });
      const bead = (await beadRes.json()).data;

      // Hook via agent JWT
      const jwtHeaders = agentHeaders({ agentId: agent.id, rigId: id });
      const hookRes = await SELF.fetch(api(`/api/rigs/${id}/agents/${agent.id}/hook`), {
        method: 'POST',
        headers: jwtHeaders,
        body: JSON.stringify({ bead_id: bead.id }),
      });
      expect(hookRes.status).toBe(200);
    });
  });

  // ── Prime ──────────────────────────────────────────────────────────────

  describe('prime', () => {
    it('should return prime context', async () => {
      const id = rigId();
      const agentRes = await SELF.fetch(api(`/api/rigs/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'polecat', name: 'P1', identity: `prime-${id}` }),
      });
      const agent = (await agentRes.json()).data;

      const res = await SELF.fetch(api(`/api/rigs/${id}/agents/${agent.id}/prime`), {
        headers: headers(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.agent.id).toBe(agent.id);
      expect(body.data.hooked_bead).toBeNull();
      expect(body.data.undelivered_mail).toHaveLength(0);
      expect(body.data.open_beads).toHaveLength(0);
    });
  });

  // ── Done ───────────────────────────────────────────────────────────────

  describe('agent done', () => {
    it('should mark agent done and submit to review queue', async () => {
      const id = rigId();
      const agentRes = await SELF.fetch(api(`/api/rigs/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'polecat', name: 'P1', identity: `done-${id}` }),
      });
      const agent = (await agentRes.json()).data;

      const beadRes = await SELF.fetch(api(`/api/rigs/${id}/beads`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'Done test' }),
      });
      const bead = (await beadRes.json()).data;

      // Hook the bead
      await SELF.fetch(api(`/api/rigs/${id}/agents/${agent.id}/hook`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ bead_id: bead.id }),
      });

      // Mark done
      const res = await SELF.fetch(api(`/api/rigs/${id}/agents/${agent.id}/done`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          branch: 'feature/done',
          pr_url: 'https://github.com/org/repo/pull/1',
          summary: 'All done',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.done).toBe(true);

      // Verify agent is idle
      const agentCheck = await SELF.fetch(api(`/api/rigs/${id}/agents/${agent.id}`), {
        headers: headers(),
      });
      const agentState = (await agentCheck.json()).data;
      expect(agentState.status).toBe('idle');
      expect(agentState.current_hook_bead_id).toBeNull();
    });
  });

  // ── Checkpoint ─────────────────────────────────────────────────────────

  describe('checkpoint', () => {
    it('should write and read checkpoint', async () => {
      const id = rigId();
      const agentRes = await SELF.fetch(api(`/api/rigs/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'polecat', name: 'P1', identity: `cp-${id}` }),
      });
      const agent = (await agentRes.json()).data;

      const writeRes = await SELF.fetch(api(`/api/rigs/${id}/agents/${agent.id}/checkpoint`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ data: { step: 5, notes: 'halfway' } }),
      });
      expect(writeRes.status).toBe(200);

      // Read checkpoint via agent get (checkpoint is on the agent record)
      const agentCheck = await SELF.fetch(api(`/api/rigs/${id}/agents/${agent.id}`), {
        headers: headers(),
      });
      const agentState = (await agentCheck.json()).data;
      expect(agentState.checkpoint).toEqual({ step: 5, notes: 'halfway' });
    });
  });

  // ── Mail ───────────────────────────────────────────────────────────────

  describe('mail', () => {
    it('should send and check mail', async () => {
      const id = rigId();
      // Create sender and receiver
      const senderRes = await SELF.fetch(api(`/api/rigs/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'polecat', name: 'Sender', identity: `sender-${id}` }),
      });
      const sender = (await senderRes.json()).data;

      const receiverRes = await SELF.fetch(api(`/api/rigs/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'polecat', name: 'Receiver', identity: `receiver-${id}` }),
      });
      const receiver = (await receiverRes.json()).data;

      // Send mail
      const sendRes = await SELF.fetch(api(`/api/rigs/${id}/mail`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          from_agent_id: sender.id,
          to_agent_id: receiver.id,
          subject: 'Hello',
          body: 'How are you?',
        }),
      });
      expect(sendRes.status).toBe(201);

      // Check mail
      const mailRes = await SELF.fetch(api(`/api/rigs/${id}/agents/${receiver.id}/mail`), {
        headers: headers(),
      });
      expect(mailRes.status).toBe(200);
      const mailBody = await mailRes.json();
      expect(mailBody.data).toHaveLength(1);
      expect(mailBody.data[0].subject).toBe('Hello');

      // Check mail again — should be empty (delivered)
      const mailRes2 = await SELF.fetch(api(`/api/rigs/${id}/agents/${receiver.id}/mail`), {
        headers: headers(),
      });
      const mailBody2 = await mailRes2.json();
      expect(mailBody2.data).toHaveLength(0);
    });
  });

  // ── Review Queue ───────────────────────────────────────────────────────

  describe('review queue', () => {
    it('should submit to review queue', async () => {
      const id = rigId();
      const agentRes = await SELF.fetch(api(`/api/rigs/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'polecat', name: 'P1', identity: `rq-${id}` }),
      });
      const agent = (await agentRes.json()).data;

      const beadRes = await SELF.fetch(api(`/api/rigs/${id}/beads`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'Review me' }),
      });
      const bead = (await beadRes.json()).data;

      const res = await SELF.fetch(api(`/api/rigs/${id}/review-queue`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          agent_id: agent.id,
          bead_id: bead.id,
          branch: 'feature/review',
          pr_url: 'https://github.com/org/repo/pull/3',
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.submitted).toBe(true);
    });
  });

  // ── Escalations ────────────────────────────────────────────────────────

  describe('escalations', () => {
    it('should create an escalation bead', async () => {
      const id = rigId();
      const res = await SELF.fetch(api(`/api/rigs/${id}/escalations`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          title: 'Critical failure',
          body: 'Something went very wrong',
          priority: 'critical',
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.type).toBe('escalation');
      expect(body.data.title).toBe('Critical failure');
      expect(body.data.priority).toBe('critical');
    });
  });

  // ── Agent identity enforcement (via JWT) ───────────────────────────────
  // These tests use agent JWTs to verify identity enforcement still works
  // even though authMiddleware is skipped in dev mode — the agentOnlyMiddleware
  // is separate and still applies to agent-scoped routes when a JWT is present.

  // ── Query param validation ─────────────────────────────────────────────

  describe('query param validation', () => {
    it('should reject non-numeric limit', async () => {
      const id = rigId();
      const res = await SELF.fetch(api(`/api/rigs/${id}/beads?limit=abc`), {
        headers: headers(),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('non-negative integers');
    });

    it('should reject negative offset', async () => {
      const id = rigId();
      const res = await SELF.fetch(api(`/api/rigs/${id}/beads?offset=-1`), {
        headers: headers(),
      });
      expect(res.status).toBe(400);
    });

    it('should accept valid limit and offset', async () => {
      const id = rigId();
      const res = await SELF.fetch(api(`/api/rigs/${id}/beads?limit=10&offset=0`), {
        headers: headers(),
      });
      expect(res.status).toBe(200);
    });
  });
});
