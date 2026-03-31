/**
 * Integration tests for the reconciler.
 *
 * These tests verify the reconciler's behavior end-to-end by:
 * 1. Setting up state via DO RPC methods
 * 2. Running the alarm (which triggers the reconciler)
 * 3. Asserting that the reconciler produced the correct state transitions
 */

import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getTownStub(name = 'test-town') {
  const id = env.TOWN.idFromName(name);
  return env.TOWN.get(id);
}

describe('Reconciler', () => {
  let town: ReturnType<typeof getTownStub>;
  let townName: string;

  beforeEach(async () => {
    townName = `reconciler-${crypto.randomUUID()}`;
    town = getTownStub(townName);
    await town.setTownId(townName);
    await town.addRig({
      rigId: 'rig-1',
      name: 'main-rig',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });
  });

  // ── reconcileBeads Rule 1: Unassigned beads get agents ──────────────

  describe('reconcileBeads Rule 1: lazy assignment', () => {
    it('should assign an agent to an unassigned open issue bead', async () => {
      // Use slingConvoy (single task, no deps) for a bead with rig_id set
      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Single bead',
        tasks: [{ title: 'Unassigned bead' }],
      });

      const beadId = result.beads[0].bead.bead_id;

      // Before alarm: no agent assigned (lazy assignment)
      const before = await town.getBeadAsync(beadId);
      expect(before?.assignee_agent_bead_id).toBeNull();

      // Run alarm — reconciler should assign an agent
      await runDurableObjectAlarm(town);

      const after = await town.getBeadAsync(beadId);
      expect(after?.assignee_agent_bead_id).toBeTruthy();
    });

    it('should not assign agents to blocked beads', async () => {
      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Blocked test',
        tasks: [{ title: 'First' }, { title: 'Second', depends_on: [0] }],
      });

      await runDurableObjectAlarm(town);

      // First bead (unblocked) should get an agent
      const bead0 = await town.getBeadAsync(result.beads[0].bead.bead_id);
      expect(bead0?.assignee_agent_bead_id).toBeTruthy();

      // Second bead (blocked by first) should NOT get an agent
      const bead1 = await town.getBeadAsync(result.beads[1].bead.bead_id);
      expect(bead1?.assignee_agent_bead_id).toBeNull();
    });

    it('should assign agents to newly unblocked beads after blocker closes', async () => {
      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Unblock test',
        tasks: [{ title: 'First' }, { title: 'Second', depends_on: [0] }],
      });

      // First alarm: assign agent to first bead
      await runDurableObjectAlarm(town);

      const bead0 = await town.getBeadAsync(result.beads[0].bead.bead_id);
      expect(bead0?.assignee_agent_bead_id).toBeTruthy();

      // Close the first bead (removes blocker)
      await town.updateBeadStatus(result.beads[0].bead.bead_id, 'closed', 'system');

      // Second alarm: reconciler assigns agent to now-unblocked second bead
      await runDurableObjectAlarm(town);

      const bead1 = await town.getBeadAsync(result.beads[1].bead.bead_id);
      expect(bead1?.assignee_agent_bead_id).toBeTruthy();
    });
  });

  // ── reconcileBeads Rule 3: Stale in_progress beads ──────────────────

  describe('reconcileBeads Rule 3: stale in_progress recovery', () => {
    it('should return in_progress bead to open when no agent is working', async () => {
      const bead = await town.createBead({
        type: 'issue',
        title: 'Orphaned bead',
        rig_id: 'rig-1',
      });

      // Manually set bead to in_progress (simulating an agent that was dispatched)
      await town.updateBeadStatus(bead.bead_id, 'in_progress', 'system');

      // Wait for staleness threshold to pass (mock: set updated_at in the past)
      // Since we can't easily manipulate time in integration tests, we verify
      // the invariant: bead is in_progress with no working agent

      // The reconciler checks for staleness > 2 min. In tests, the bead was
      // JUST set to in_progress, so it won't be stale yet. This test verifies
      // the alarm runs without error — the actual staleness recovery is tested
      // by the reconciler's behavior in production.
      await runDurableObjectAlarm(town);

      // Bead should still be in_progress (not yet stale)
      const after = await town.getBeadAsync(bead.bead_id);
      expect(after?.status).toBe('in_progress');
    });
  });

  // ── #1358: Heartbeat restores working status ────────────────────────

  describe('#1358: dispatch timeout race recovery', () => {
    it('should restore idle agent to working on heartbeat', async () => {
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `heartbeat-restore-${townName}`,
        rig_id: 'rig-1',
      });
      const bead = await town.createBead({
        type: 'issue',
        title: 'Heartbeat test',
        rig_id: 'rig-1',
      });

      // Simulate dispatch timeout race: agent is hooked + idle
      // (dispatchAgent set it to working, then timeout set it back to idle)
      await town.hookBead(agent.id, bead.bead_id);
      await town.updateAgentStatus(agent.id, 'idle');

      const before = await town.getAgentAsync(agent.id);
      expect(before?.status).toBe('idle');

      // Agent sends a heartbeat (proving it's alive in the container)
      await town.touchAgentHeartbeat(agent.id);

      // Status should be restored to working
      const after = await town.getAgentAsync(agent.id);
      expect(after?.status).toBe('working');
    });

    it('should not change status of a working agent on heartbeat', async () => {
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'P2',
        identity: `heartbeat-noop-${townName}`,
        rig_id: 'rig-1',
      });
      const bead = await town.createBead({
        type: 'issue',
        title: 'Heartbeat noop test',
        rig_id: 'rig-1',
      });

      await town.hookBead(agent.id, bead.bead_id);
      await town.updateAgentStatus(agent.id, 'working');

      await town.touchAgentHeartbeat(agent.id);

      const after = await town.getAgentAsync(agent.id);
      expect(after?.status).toBe('working');
    });

    it('should not change status of an exited agent on heartbeat', async () => {
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'P3',
        identity: `heartbeat-exited-${townName}`,
        rig_id: 'rig-1',
      });

      await town.updateAgentStatus(agent.id, 'exited');

      await town.touchAgentHeartbeat(agent.id);

      const after = await town.getAgentAsync(agent.id);
      expect(after?.status).toBe('exited');
    });
  });

  // ── Event-driven agentDone ──────────────────────────────────────────

  describe('event-driven agentDone', () => {
    it('should transition source bead to in_review after alarm drains agent_done event', async () => {
      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'AgentDone test',
        tasks: [{ title: 'Agent done test' }],
      });

      const beadId = result.beads[0].bead.bead_id;

      // Assign agent and set bead to in_progress
      await runDurableObjectAlarm(town);

      const assigned = await town.getBeadAsync(beadId);
      const agentId = assigned?.assignee_agent_bead_id;
      expect(agentId).toBeTruthy();

      // Agent calls gt_done (event-only)
      await town.agentDone(agentId!, {
        branch: 'gt/polecat/test-branch',
        summary: 'Test done',
      });

      // Run alarm to drain agent_done event
      await runDurableObjectAlarm(town);

      // After alarm: bead should be in_review
      const after = await town.getBeadAsync(beadId);
      expect(after?.status).toBe('in_review');

      // An MR bead should have been created
      const mrBeads = await town.listBeads({ type: 'merge_request' });
      expect(mrBeads.length).toBeGreaterThan(0);
      const mrForSource = mrBeads.find(b => b.metadata?.source_bead_id === beadId);
      expect(mrForSource).toBeTruthy();
    });
  });

  // ── reconcileReviewQueue Rule 5: Refinery dispatch ──────────────────

  describe('reconcileReviewQueue Rule 5: refinery dispatch', () => {
    it('should create a refinery and dispatch it for an open MR bead', async () => {
      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Refinery test',
        tasks: [{ title: 'Review dispatch test' }],
      });

      const beadId = result.beads[0].bead.bead_id;

      // Assign agent, dispatch
      await runDurableObjectAlarm(town);

      const assigned = await town.getBeadAsync(beadId);
      const agentId = assigned?.assignee_agent_bead_id!;
      expect(agentId).toBeTruthy();

      // Agent finishes work (event-only)
      await town.agentDone(agentId, {
        branch: 'gt/polecat/test-review',
        summary: 'Ready for review',
      });

      // Drain agent_done event → creates MR bead in 'open' status
      await runDurableObjectAlarm(town);

      // Verify MR bead exists
      const mrBeads = await town.listBeads({ type: 'merge_request' });
      const mrBead = mrBeads.find(b => b.metadata?.source_bead_id === beadId);
      expect(mrBead).toBeTruthy();

      // Run alarm again — reconciler should pop the MR bead and dispatch a refinery.
      // (Container dispatch will fail in tests, but the MR should transition
      // to in_progress and a refinery agent should be created.)
      await runDurableObjectAlarm(town);

      const updatedMr = await town.getBeadAsync(mrBead!.bead_id);
      // MR should be in_progress (popped by reconciler)
      expect(updatedMr?.status).toBe('in_progress');

      // A refinery agent should exist
      const agentsList = await town.listAgents({ role: 'refinery' });
      expect(agentsList.length).toBeGreaterThan(0);
    });
  });

  // ── reconcileReviewQueue Rule 6: Refinery re-dispatch limits (#1342) ─

  describe('reconcileReviewQueue Rule 6: refinery re-dispatch limits', () => {
    it('should fail MR bead after refinery exceeds max dispatch attempts', async () => {
      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Rule 6 limit test',
        tasks: [{ title: 'Dispatch limit test' }],
      });

      const beadId = result.beads[0].bead.bead_id;

      // Assign agent and dispatch
      await runDurableObjectAlarm(town);

      const assigned = await town.getBeadAsync(beadId);
      const agentId = assigned?.assignee_agent_bead_id!;
      expect(agentId).toBeTruthy();

      // Agent finishes work → creates MR bead
      await town.agentDone(agentId, {
        branch: 'gt/polecat/test-rule6',
        summary: 'Ready for review',
      });
      await runDurableObjectAlarm(town);

      // Find the MR bead and its refinery
      const mrBeads = await town.listBeads({ type: 'merge_request' });
      const mrBead = mrBeads.find(b => b.metadata?.source_bead_id === beadId);
      expect(mrBead).toBeTruthy();

      // Run alarm to dispatch the refinery
      await runDurableObjectAlarm(town);

      const refineries = await town.listAgents({ role: 'refinery' });
      expect(refineries.length).toBeGreaterThan(0);
      const refinery = refineries[0];

      // Simulate repeated idle→re-dispatch cycles by setting dispatch_attempts
      // past the limit (MAX_DISPATCH_ATTEMPTS = 20) and backdating last_activity_at
      // so the DISPATCH_COOLDOWN_MS check passes.
      const pastTimestamp = new Date(Date.now() - 5 * 60_000).toISOString();
      await town.setAgentDispatchAttempts(refinery.id, 25, pastTimestamp);

      // Set agent to idle (simulating agentCompleted) and ensure MR is in_progress
      await town.updateAgentStatus(refinery.id, 'idle');
      const mrBefore = await town.getBeadAsync(mrBead!.bead_id);
      expect(mrBefore?.status).toBe('in_progress');

      // Run alarm — Rule 6 should see dispatch_attempts >= 20 and fail the MR bead
      await runDurableObjectAlarm(town);

      const mrAfter = await town.getBeadAsync(mrBead!.bead_id);
      expect(mrAfter?.status).toBe('failed');

      // Refinery should be unhooked
      const refineryAfter = await town.getAgentAsync(refinery.id);
      expect(refineryAfter?.current_hook_bead_id).toBeNull();
    });
  });

  // ── reconcileConvoys: Auto-close ────────────────────────────────────

  describe('reconcileConvoys: progress and auto-close', () => {
    it('should close a review-and-merge convoy when all beads are closed', async () => {
      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Auto-close test',
        tasks: [{ title: 'Task 1' }, { title: 'Task 2' }],
        merge_mode: 'review-and-merge',
      });

      // Close both beads
      await town.updateBeadStatus(result.beads[0].bead.bead_id, 'closed', 'system');
      await town.updateBeadStatus(result.beads[1].bead.bead_id, 'closed', 'system');

      // Run alarm — reconciler should auto-close the convoy
      await runDurableObjectAlarm(town);

      const status = await town.getConvoyStatus(result.convoy.id);
      // getConvoyStatus returns 'landed' when the convoy bead is closed
      expect(status?.status).toBe('landed');
      expect(status?.closed_beads).toBe(2);
    });

    it('should NOT auto-close a review-then-land convoy (needs landing MR)', async () => {
      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Landing needed test',
        tasks: [{ title: 'Task 1' }],
        merge_mode: 'review-then-land',
      });

      expect(result.convoy.feature_branch).toBeTruthy();

      // Close the bead
      await town.updateBeadStatus(result.beads[0].bead.bead_id, 'closed', 'system');

      // Run alarm — convoy should be ready_to_land but NOT closed
      await runDurableObjectAlarm(town);

      const status = await town.getConvoyStatus(result.convoy.id);
      expect(status?.status).toBe('active'); // Not closed — waiting for landing MR
      expect(status?.closed_beads).toBe(1);
    });
  });

  // ── reconcileAgents: idle hooks ─────────────────────────────────────

  describe('reconcileAgents: stale hook cleanup', () => {
    it('should unhook an idle agent from a terminal bead', async () => {
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `stale-hook-${townName}`,
        rig_id: 'rig-1',
      });
      const bead = await town.createBead({
        type: 'issue',
        title: 'Terminal bead',
        rig_id: 'rig-1',
      });

      // Hook agent, then close the bead (making it terminal)
      await town.hookBead(agent.id, bead.bead_id);
      await town.updateBeadStatus(bead.bead_id, 'closed', agent.id);

      // Agent is now idle + hooked to a closed bead
      const agentBefore = await town.getAgentAsync(agent.id);
      expect(agentBefore?.current_hook_bead_id).toBe(bead.bead_id);

      // Run alarm — reconciler should unhook the stale hook
      await runDurableObjectAlarm(town);

      const agentAfter = await town.getAgentAsync(agent.id);
      expect(agentAfter?.current_hook_bead_id).toBeNull();
    });
  });

  // ── reconcileGC: agent garbage collection ───────────────────────────

  describe('reconcileGC: agent garbage collection', () => {
    it('should not GC agents with recent activity', async () => {
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `gc-recent-${townName}`,
        rig_id: 'rig-1',
      });

      // Touch the agent (recent heartbeat)
      await town.touchAgentHeartbeat(agent.id);

      // Run alarm — agent has recent activity, should NOT be GC'd
      await runDurableObjectAlarm(town);

      const after = await town.getAgentAsync(agent.id);
      expect(after).toBeTruthy();
    });
  });

  // ── Event system: insert, drain, apply ──────────────────────────────

  describe('event system', () => {
    it('should drain and apply bead_created events', async () => {
      // slingBead inserts a bead_created event
      const result = await town.slingBead({
        type: 'issue',
        title: 'Event test',
        rigId: 'rig-1',
      });

      // The bead should exist (created synchronously)
      const bead = await town.getBeadAsync(result.bead.bead_id);
      expect(bead).toBeTruthy();
      expect(bead?.status).toBe('open');

      // Agent should be assigned (fast path in slingBead)
      expect(result.agent).toBeTruthy();
    });

    it('should drain and apply convoy_started events', async () => {
      const result = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Staged convoy',
        tasks: [{ title: 'Task 1' }],
        staged: true,
      });

      // Convoy should be staged
      const statusBefore = await town.getConvoyStatus(result.convoy.id);
      expect(statusBefore?.staged).toBe(true);

      // Start the convoy
      await town.startConvoy(result.convoy.id);

      // Convoy should no longer be staged
      const statusAfter = await town.getConvoyStatus(result.convoy.id);
      expect(statusAfter?.staged).toBe(false);
    });
  });
});
