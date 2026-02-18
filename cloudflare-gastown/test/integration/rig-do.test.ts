import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getRigStub(name = 'test-rig') {
  const id = env.RIG.idFromName(name);
  return env.RIG.get(id);
}

describe('RigDO', () => {
  // Use unique rig names per test to avoid state leaking
  let rigName: string;
  let rig: ReturnType<typeof getRigStub>;

  beforeEach(() => {
    rigName = `rig-${crypto.randomUUID()}`;
    rig = getRigStub(rigName);
  });

  // ── Beads ──────────────────────────────────────────────────────────────

  describe('beads', () => {
    it('should create and retrieve a bead', async () => {
      const bead = await rig.createBead({
        type: 'issue',
        title: 'Fix the widget',
        body: 'The widget is broken',
        priority: 'high',
        labels: ['bug'],
        metadata: { source: 'test' },
      });

      expect(bead.id).toBeDefined();
      expect(bead.type).toBe('issue');
      expect(bead.status).toBe('open');
      expect(bead.title).toBe('Fix the widget');
      expect(bead.body).toBe('The widget is broken');
      expect(bead.priority).toBe('high');
      expect(bead.labels).toEqual(['bug']);
      expect(bead.metadata).toEqual({ source: 'test' });
      expect(bead.assignee_agent_id).toBeNull();
      expect(bead.closed_at).toBeNull();

      const retrieved = await rig.getBeadAsync(bead.id);
      expect(retrieved).toMatchObject({ id: bead.id, title: 'Fix the widget' });
    });

    it('should return null for non-existent bead', async () => {
      const result = await rig.getBeadAsync('non-existent');
      expect(result).toBeNull();
    });

    it('should list beads with filters', async () => {
      await rig.createBead({ type: 'issue', title: 'Issue 1' });
      await rig.createBead({ type: 'message', title: 'Message 1' });
      await rig.createBead({ type: 'issue', title: 'Issue 2' });

      const allBeads = await rig.listBeads({});
      expect(allBeads).toHaveLength(3);

      const issues = await rig.listBeads({ type: 'issue' });
      expect(issues).toHaveLength(2);

      const messages = await rig.listBeads({ type: 'message' });
      expect(messages).toHaveLength(1);
    });

    it('should list beads with pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await rig.createBead({ type: 'issue', title: `Issue ${i}` });
      }

      const page1 = await rig.listBeads({ limit: 2 });
      expect(page1).toHaveLength(2);

      const page2 = await rig.listBeads({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);

      const page3 = await rig.listBeads({ limit: 2, offset: 4 });
      expect(page3).toHaveLength(1);
    });

    it('should use default priority when not specified', async () => {
      const bead = await rig.createBead({ type: 'issue', title: 'Default priority' });
      expect(bead.priority).toBe('medium');
    });
  });

  // ── Agents ─────────────────────────────────────────────────────────────

  describe('agents', () => {
    it('should register and retrieve an agent', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'Polecat-1',
        identity: `polecat-1-${rigName}`,
      });

      expect(agent.id).toBeDefined();
      expect(agent.role).toBe('polecat');
      expect(agent.name).toBe('Polecat-1');
      expect(agent.identity).toBe(`polecat-1-${rigName}`);
      expect(agent.status).toBe('idle');
      expect(agent.current_hook_bead_id).toBeNull();

      const retrieved = await rig.getAgentAsync(agent.id);
      expect(retrieved).toMatchObject({ id: agent.id, name: 'Polecat-1' });
    });

    it('should return null for non-existent agent', async () => {
      const result = await rig.getAgentAsync('non-existent');
      expect(result).toBeNull();
    });

    it('should get agent by identity', async () => {
      const identity = `unique-identity-${rigName}`;
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'Polecat-2',
        identity,
      });

      const found = await rig.getAgentByIdentity(identity);
      expect(found).toMatchObject({ id: agent.id, identity });
    });

    it('should list agents with filters', async () => {
      await rig.registerAgent({ role: 'polecat', name: 'P1', identity: `p1-${rigName}` });
      await rig.registerAgent({ role: 'refinery', name: 'R1', identity: `r1-${rigName}` });
      await rig.registerAgent({ role: 'polecat', name: 'P2', identity: `p2-${rigName}` });

      const all = await rig.listAgents();
      expect(all).toHaveLength(3);

      const polecats = await rig.listAgents({ role: 'polecat' });
      expect(polecats).toHaveLength(2);

      const refineries = await rig.listAgents({ role: 'refinery' });
      expect(refineries).toHaveLength(1);
    });

    it('should update agent status', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `status-test-${rigName}`,
      });

      expect(agent.status).toBe('idle');

      await rig.updateAgentStatus(agent.id, 'working');
      const updated = await rig.getAgentAsync(agent.id);
      expect(updated?.status).toBe('working');
    });
  });

  // ── Hooks (GUPP) ──────────────────────────────────────────────────────

  describe('hooks', () => {
    it('should hook and unhook a bead', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `hook-test-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Hook target' });

      await rig.hookBead(agent.id, bead.id);

      const hookedAgent = await rig.getAgentAsync(agent.id);
      expect(hookedAgent?.current_hook_bead_id).toBe(bead.id);
      expect(hookedAgent?.status).toBe('idle');

      const hookedBead = await rig.getBeadAsync(bead.id);
      expect(hookedBead?.status).toBe('in_progress');
      expect(hookedBead?.assignee_agent_id).toBe(agent.id);

      const retrieved = await rig.getHookedBead(agent.id);
      expect(retrieved?.id).toBe(bead.id);

      await rig.unhookBead(agent.id);

      const unhookedAgent = await rig.getAgentAsync(agent.id);
      expect(unhookedAgent?.current_hook_bead_id).toBeNull();
      expect(unhookedAgent?.status).toBe('idle');
    });

    it('should allow re-hooking the same bead (idempotent)', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `hook-idem-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Bead 1' });

      await rig.hookBead(agent.id, bead.id);
      // Re-hooking the same bead should succeed (idempotent)
      await rig.hookBead(agent.id, bead.id);

      const hookedBead = await rig.getHookedBead(agent.id);
      expect(hookedBead?.id).toBe(bead.id);
    });

    it('should return null for unhooked agent', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `no-hook-${rigName}`,
      });

      const result = await rig.getHookedBead(agent.id);
      expect(result).toBeNull();
    });
  });

  // ── Bead status updates ────────────────────────────────────────────────

  describe('bead status', () => {
    it('should update bead status', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `status-bead-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Status test' });

      const updated = await rig.updateBeadStatus(bead.id, 'in_progress', agent.id);
      expect(updated.status).toBe('in_progress');
      expect(updated.closed_at).toBeNull();
    });

    it('should close a bead and set closed_at', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `close-bead-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Close test' });

      const closed = await rig.closeBead(bead.id, agent.id);
      expect(closed.status).toBe('closed');
      expect(closed.closed_at).toBeDefined();
    });

    it('should filter beads by status', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `filter-status-${rigName}`,
      });
      await rig.createBead({ type: 'issue', title: 'Open bead' });
      const beadToClose = await rig.createBead({ type: 'issue', title: 'Closed bead' });
      await rig.closeBead(beadToClose.id, agent.id);

      const openBeads = await rig.listBeads({ status: 'open' });
      expect(openBeads).toHaveLength(1);
      expect(openBeads[0].title).toBe('Open bead');

      const closedBeads = await rig.listBeads({ status: 'closed' });
      expect(closedBeads).toHaveLength(1);
      expect(closedBeads[0].title).toBe('Closed bead');
    });
  });

  // ── Mail ───────────────────────────────────────────────────────────────

  describe('mail', () => {
    it('should send and check mail', async () => {
      const sender = await rig.registerAgent({
        role: 'polecat',
        name: 'Sender',
        identity: `sender-${rigName}`,
      });
      const receiver = await rig.registerAgent({
        role: 'polecat',
        name: 'Receiver',
        identity: `receiver-${rigName}`,
      });

      await rig.sendMail({
        from_agent_id: sender.id,
        to_agent_id: receiver.id,
        subject: 'Help needed',
        body: 'I need help with the widget',
      });

      const mailbox = await rig.checkMail(receiver.id);
      expect(mailbox).toHaveLength(1);
      expect(mailbox[0].subject).toBe('Help needed');
      expect(mailbox[0].body).toBe('I need help with the widget');
      expect(mailbox[0].from_agent_id).toBe(sender.id);
      // checkMail reads then marks as delivered; the returned data reflects pre-update state
      expect(mailbox[0].delivered).toBe(false);

      // Second check should return empty (already delivered)
      const emptyMailbox = await rig.checkMail(receiver.id);
      expect(emptyMailbox).toHaveLength(0);
    });

    it('should handle multiple mail messages', async () => {
      const sender = await rig.registerAgent({
        role: 'polecat',
        name: 'S1',
        identity: `multi-sender-${rigName}`,
      });
      const receiver = await rig.registerAgent({
        role: 'polecat',
        name: 'R1',
        identity: `multi-receiver-${rigName}`,
      });

      await rig.sendMail({
        from_agent_id: sender.id,
        to_agent_id: receiver.id,
        subject: 'Message 1',
        body: 'First message',
      });
      await rig.sendMail({
        from_agent_id: sender.id,
        to_agent_id: receiver.id,
        subject: 'Message 2',
        body: 'Second message',
      });

      const mailbox = await rig.checkMail(receiver.id);
      expect(mailbox).toHaveLength(2);
      expect(mailbox[0].subject).toBe('Message 1');
      expect(mailbox[1].subject).toBe('Message 2');
    });
  });

  // ── Review Queue ───────────────────────────────────────────────────────

  describe('review queue', () => {
    it('should submit to and pop from review queue', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `review-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Review this' });

      await rig.submitToReviewQueue({
        agent_id: agent.id,
        bead_id: bead.id,
        branch: 'feature/fix-widget',
        pr_url: 'https://github.com/org/repo/pull/1',
        summary: 'Fixed the widget',
      });

      const entry = await rig.popReviewQueue();
      expect(entry).toBeDefined();
      expect(entry?.branch).toBe('feature/fix-widget');
      expect(entry?.pr_url).toBe('https://github.com/org/repo/pull/1');
      expect(entry?.status).toBe('running');

      // Pop again should return null (nothing pending)
      const empty = await rig.popReviewQueue();
      expect(empty).toBeNull();
    });

    it('should complete a review', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `complete-review-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Review complete' });

      await rig.submitToReviewQueue({
        agent_id: agent.id,
        bead_id: bead.id,
        branch: 'feature/fix',
      });

      const entry = await rig.popReviewQueue();
      expect(entry).toBeDefined();

      await rig.completeReview(entry!.id, 'merged');

      // Pop again should be null
      const empty = await rig.popReviewQueue();
      expect(empty).toBeNull();
    });
  });

  // ── Prime ──────────────────────────────────────────────────────────────

  describe('prime', () => {
    it('should assemble prime context for an agent', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `prime-${rigName}`,
      });
      const sender = await rig.registerAgent({
        role: 'mayor',
        name: 'Mayor',
        identity: `mayor-${rigName}`,
      });

      const bead = await rig.createBead({
        type: 'issue',
        title: 'Work on this',
        assignee_agent_id: agent.id,
      });
      await rig.hookBead(agent.id, bead.id);

      await rig.sendMail({
        from_agent_id: sender.id,
        to_agent_id: agent.id,
        subject: 'Priority update',
        body: 'This is now urgent',
      });

      const context = await rig.prime(agent.id);

      expect(context.agent.id).toBe(agent.id);
      expect(context.hooked_bead?.id).toBe(bead.id);
      expect(context.undelivered_mail).toHaveLength(1);
      expect(context.undelivered_mail[0].subject).toBe('Priority update');
      expect(context.open_beads).toHaveLength(1);

      // Prime is read-only — mail should still be undelivered
      const mailbox = await rig.checkMail(agent.id);
      expect(mailbox).toHaveLength(1);
    });

    it('should return empty context for agent with no work', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P2',
        identity: `prime-empty-${rigName}`,
      });

      const context = await rig.prime(agent.id);
      expect(context.agent.id).toBe(agent.id);
      expect(context.hooked_bead).toBeNull();
      expect(context.undelivered_mail).toHaveLength(0);
      expect(context.open_beads).toHaveLength(0);
    });
  });

  // ── Checkpoint ─────────────────────────────────────────────────────────

  describe('checkpoint', () => {
    it('should write and read checkpoint data', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `checkpoint-${rigName}`,
      });

      const data = { step: 3, context: 'working on feature X' };
      await rig.writeCheckpoint(agent.id, data);

      const checkpoint = await rig.readCheckpoint(agent.id);
      expect(checkpoint).toEqual(data);
    });

    it('should return null for agent with no checkpoint', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `no-checkpoint-${rigName}`,
      });

      const checkpoint = await rig.readCheckpoint(agent.id);
      expect(checkpoint).toBeNull();
    });

    it('should return null for non-existent agent', async () => {
      const checkpoint = await rig.readCheckpoint('non-existent');
      expect(checkpoint).toBeNull();
    });
  });

  // ── Agent Done ─────────────────────────────────────────────────────────

  describe('agentDone', () => {
    it('should submit to review queue and unhook', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `done-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Done test' });
      await rig.hookBead(agent.id, bead.id);

      await rig.agentDone(agent.id, {
        branch: 'feature/done',
        pr_url: 'https://github.com/org/repo/pull/2',
        summary: 'Completed the work',
      });

      // Agent should be unhooked
      const updatedAgent = await rig.getAgentAsync(agent.id);
      expect(updatedAgent?.current_hook_bead_id).toBeNull();
      expect(updatedAgent?.status).toBe('idle');

      // Review queue should have an entry
      const entry = await rig.popReviewQueue();
      expect(entry).toBeDefined();
      expect(entry?.branch).toBe('feature/done');
      expect(entry?.bead_id).toBe(bead.id);
    });
  });

  // ── Witness Patrol ─────────────────────────────────────────────────────

  describe('witnessPatrol', () => {
    it('should detect dead agents', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'DeadAgent',
        identity: `dead-${rigName}`,
      });
      await rig.updateAgentStatus(agent.id, 'dead');

      const result = await rig.witnessPatrol();
      expect(result.dead_agents).toContain(agent.id);
    });

    it('should return empty results when no issues', async () => {
      const result = await rig.witnessPatrol();
      expect(result.dead_agents).toHaveLength(0);
      expect(result.stale_agents).toHaveLength(0);
      expect(result.orphaned_beads).toHaveLength(0);
    });
  });

  // ── DO stubs ───────────────────────────────────────────────────────────

  describe('GastownUserDO stub', () => {
    it('should respond to ping', async () => {
      const id = env.GASTOWN_USER.idFromName('test-user');
      const stub = env.GASTOWN_USER.get(id);
      const result = await stub.ping();
      expect(result).toBe('pong');
    });
  });

  describe('AgentIdentityDO stub', () => {
    it('should respond to ping', async () => {
      const id = env.AGENT_IDENTITY.idFromName('test-identity');
      const stub = env.AGENT_IDENTITY.get(id);
      const result = await stub.ping();
      expect(result).toBe('pong');
    });
  });
});
