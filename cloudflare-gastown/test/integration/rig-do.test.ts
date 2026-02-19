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

    it('should close bead on successful merge via completeReviewWithResult', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `merge-success-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Merge me' });

      await rig.submitToReviewQueue({
        agent_id: agent.id,
        bead_id: bead.id,
        branch: 'feature/merge-test',
      });

      const entry = await rig.popReviewQueue();
      expect(entry).toBeDefined();

      await rig.completeReviewWithResult({
        entry_id: entry!.id,
        status: 'merged',
        message: 'Merge successful',
        commit_sha: 'abc123',
      });

      // Bead should be closed
      const updatedBead = await rig.getBeadAsync(bead.id);
      expect(updatedBead?.status).toBe('closed');
      expect(updatedBead?.closed_at).toBeDefined();

      // Review queue should be empty
      const empty = await rig.popReviewQueue();
      expect(empty).toBeNull();
    });

    it('should create escalation bead on merge conflict via completeReviewWithResult', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `merge-conflict-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Conflict me' });

      await rig.submitToReviewQueue({
        agent_id: agent.id,
        bead_id: bead.id,
        branch: 'feature/conflict-test',
      });

      const entry = await rig.popReviewQueue();
      expect(entry).toBeDefined();

      await rig.completeReviewWithResult({
        entry_id: entry!.id,
        status: 'conflict',
        message: 'CONFLICT (content): Merge conflict in src/index.ts',
      });

      // Original bead should NOT be closed (conflict means it stays as-is)
      const updatedBead = await rig.getBeadAsync(bead.id);
      expect(updatedBead?.status).not.toBe('closed');

      // An escalation bead should have been created
      const escalations = await rig.listBeads({ type: 'escalation' });
      expect(escalations).toHaveLength(1);
      expect(escalations[0].title).toBe('Merge conflict: feature/conflict-test');
      expect(escalations[0].priority).toBe('high');
      expect(escalations[0].body).toContain('CONFLICT (content)');
      expect(escalations[0].metadata).toMatchObject({
        source_bead_id: bead.id,
        source_branch: 'feature/conflict-test',
        agent_id: agent.id,
      });

      // Review queue entry should be marked as failed
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

  // ── Bead Events ──────────────────────────────────────────────────────────

  describe('bead events', () => {
    it('should write events on createBead', async () => {
      const bead = await rig.createBead({ type: 'issue', title: 'Event test' });
      const events = await rig.listBeadEvents({ beadId: bead.id });
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('created');
      expect(events[0].bead_id).toBe(bead.id);
      expect(events[0].metadata).toMatchObject({ title: 'Event test' });
    });

    it('should write events on hookBead', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `evt-hook-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Hook event test' });
      await rig.hookBead(agent.id, bead.id);

      const events = await rig.listBeadEvents({ beadId: bead.id });
      // created + hooked
      expect(events).toHaveLength(2);
      expect(events[0].event_type).toBe('created');
      expect(events[1].event_type).toBe('hooked');
      expect(events[1].agent_id).toBe(agent.id);
      expect(events[1].new_value).toBe(agent.id);
    });

    it('should write events on unhookBead', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `evt-unhook-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Unhook event test' });
      await rig.hookBead(agent.id, bead.id);
      await rig.unhookBead(agent.id);

      const events = await rig.listBeadEvents({ beadId: bead.id });
      // created + hooked + unhooked
      expect(events).toHaveLength(3);
      expect(events[2].event_type).toBe('unhooked');
    });

    it('should write events on updateBeadStatus', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `evt-status-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Status event test' });
      await rig.updateBeadStatus(bead.id, 'in_progress', agent.id);

      const events = await rig.listBeadEvents({ beadId: bead.id });
      // created + status_changed
      expect(events).toHaveLength(2);
      expect(events[1].event_type).toBe('status_changed');
      expect(events[1].old_value).toBe('open');
      expect(events[1].new_value).toBe('in_progress');
    });

    it('should write closed event on closeBead', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `evt-close-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Close event test' });
      await rig.closeBead(bead.id, agent.id);

      const events = await rig.listBeadEvents({ beadId: bead.id });
      // created + closed
      expect(events).toHaveLength(2);
      expect(events[1].event_type).toBe('closed');
    });

    it('should filter events by since timestamp', async () => {
      const bead = await rig.createBead({ type: 'issue', title: 'Since filter test' });
      const events = await rig.listBeadEvents({ beadId: bead.id });
      expect(events).toHaveLength(1);

      // Query with a future timestamp should return nothing
      const futureEvents = await rig.listBeadEvents({
        beadId: bead.id,
        since: '2099-01-01T00:00:00.000Z',
      });
      expect(futureEvents).toHaveLength(0);
    });

    it('should list all events across beads', async () => {
      await rig.createBead({ type: 'issue', title: 'Multi 1' });
      await rig.createBead({ type: 'issue', title: 'Multi 2' });

      const allEvents = await rig.listBeadEvents({});
      expect(allEvents.length).toBeGreaterThanOrEqual(2);
    });

    it('should write review_submitted event on submitToReviewQueue', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `evt-review-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Review event test' });
      await rig.submitToReviewQueue({
        agent_id: agent.id,
        bead_id: bead.id,
        branch: 'feature/test',
      });

      const events = await rig.listBeadEvents({ beadId: bead.id });
      const reviewEvents = events.filter(e => e.event_type === 'review_submitted');
      expect(reviewEvents).toHaveLength(1);
      expect(reviewEvents[0].new_value).toBe('feature/test');
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
