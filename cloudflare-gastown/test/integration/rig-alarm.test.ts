import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getRigStub(name = 'test-rig') {
  const id = env.RIG.idFromName(name);
  return env.RIG.get(id);
}

describe('Rig DO Alarm', () => {
  let rigName: string;
  let rig: ReturnType<typeof getRigStub>;

  beforeEach(() => {
    rigName = `rig-alarm-${crypto.randomUUID()}`;
    rig = getRigStub(rigName);
  });

  // ── Town ID management ──────────────────────────────────────────────────

  describe('town ID', () => {
    it('should store and retrieve town ID', async () => {
      await rig.setTownId('town-abc');
      const townId = await rig.getTownId();
      expect(townId).toBe('town-abc');
    });

    it('should return null when no town ID is set', async () => {
      const townId = await rig.getTownId();
      expect(townId).toBeNull();
    });
  });

  // ── Alarm arming ────────────────────────────────────────────────────────

  describe('alarm arming', () => {
    it('should arm alarm when hookBead is called', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `alarm-hook-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Test bead' });

      await rig.hookBead(agent.id, bead.id);

      // The alarm should fire without error
      const ran = await runDurableObjectAlarm(rig);
      expect(ran).toBe(true);
    });

    it('should arm alarm when agentDone is called', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `alarm-done-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Done bead' });
      await rig.hookBead(agent.id, bead.id);

      // Run the initial alarm from hookBead
      await runDurableObjectAlarm(rig);

      await rig.agentDone(agent.id, {
        branch: 'feature/test',
        summary: 'Test done',
      });

      // Another alarm should be armed
      const ran = await runDurableObjectAlarm(rig);
      expect(ran).toBe(true);
    });

    it('should arm alarm when setTownId is called', async () => {
      await rig.setTownId('town-xyz');

      const ran = await runDurableObjectAlarm(rig);
      expect(ran).toBe(true);
    });

    it('should arm alarm when touchAgentHeartbeat is called', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `alarm-heartbeat-${rigName}`,
      });

      await rig.touchAgentHeartbeat(agent.id);

      const ran = await runDurableObjectAlarm(rig);
      expect(ran).toBe(true);
    });
  });

  // ── Alarm handler behavior ──────────────────────────────────────────────

  describe('alarm handler', () => {
    it('should re-arm when there is active work', async () => {
      await rig.setTownId('town-test');
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `rearm-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Active work' });
      await rig.hookBead(agent.id, bead.id);

      // First alarm from hookBead
      await runDurableObjectAlarm(rig);

      // Agent is working with an in-progress bead — alarm should re-arm
      const ranAgain = await runDurableObjectAlarm(rig);
      expect(ranAgain).toBe(true);
    });

    it('should not re-arm when there is no active work', async () => {
      await rig.setTownId('town-idle');
      // First alarm from setTownId — no active work
      await runDurableObjectAlarm(rig);

      // No active work means alarm should not re-arm
      const ranAgain = await runDurableObjectAlarm(rig);
      expect(ranAgain).toBe(false);
    });

    it('should process review queue entries during alarm', async () => {
      // No townId set — review queue processing should gracefully skip
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `alarm-review-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Review bead' });

      await rig.submitToReviewQueue({
        agent_id: agent.id,
        bead_id: bead.id,
        branch: 'feature/review',
      });

      // Without a townId, processReviewQueue should pop but skip container call
      await rig.setTownId('fake-town');

      // Run alarm — the container isn't available in tests, so the merge will
      // fail gracefully and mark the review as 'failed'
      await runDurableObjectAlarm(rig);

      // The pending entry should have been popped (no more pending entries)
      const nextEntry = await rig.popReviewQueue();
      expect(nextEntry).toBeNull();
    });
  });

  // ── schedulePendingWork ─────────────────────────────────────────────────

  describe('schedule pending work', () => {
    it('should not dispatch agents without townId', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `no-town-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Pending bead' });
      await rig.hookBead(agent.id, bead.id);

      // hookBead sets agent to 'working', but for schedulePendingWork to find
      // agents, they need to be 'idle' with a hooked bead — which is the state
      // after a container crash restarts them. Simulate that:
      await rig.updateAgentStatus(agent.id, 'idle');

      // Run alarm — no townId, so scheduling should be skipped
      await runDurableObjectAlarm(rig);

      // Agent should still be idle (not dispatched)
      const updatedAgent = await rig.getAgentAsync(agent.id);
      expect(updatedAgent?.status).toBe('idle');
    });

    it('should attempt to dispatch idle agents with hooked beads', async () => {
      await rig.setTownId('town-dispatch-test');

      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `dispatch-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Dispatch bead' });
      await rig.hookBead(agent.id, bead.id);

      // Simulate agent reset to idle (e.g., after container crash)
      await rig.updateAgentStatus(agent.id, 'idle');

      // Run alarm — container not available in tests, so startAgentInContainer
      // will fail, but the attempt should be made
      await runDurableObjectAlarm(rig);

      // In test env without a real container, the fetch will throw and
      // startAgentInContainer returns false, so agent remains idle
      const updatedAgent = await rig.getAgentAsync(agent.id);
      // Agent stays idle because container start failed
      expect(updatedAgent?.status).toBe('idle');
    });
  });

  // ── witnessPatrol with alarm ────────────────────────────────────────────

  describe('witness patrol via alarm', () => {
    it('should still detect dead agents when alarm fires', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'DeadAgent',
        identity: `alarm-dead-${rigName}`,
      });
      await rig.updateAgentStatus(agent.id, 'dead');
      await rig.setTownId('town-patrol');

      // Run alarm — witnessPatrol runs as part of alarm
      await runDurableObjectAlarm(rig);

      // Verify via direct witnessPatrol call
      const result = await rig.witnessPatrol();
      expect(result.dead_agents).toContain(agent.id);
    });

    it('should detect orphaned beads during alarm', async () => {
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'OrphanMaker',
        identity: `alarm-orphan-${rigName}`,
      });
      const bead = await rig.createBead({ type: 'issue', title: 'Orphan bead' });
      await rig.hookBead(agent.id, bead.id);

      // Kill the agent
      await rig.updateAgentStatus(agent.id, 'dead');

      await rig.setTownId('town-orphan');
      await runDurableObjectAlarm(rig);

      const result = await rig.witnessPatrol();
      expect(result.orphaned_beads).toContain(bead.id);
    });
  });

  // ── Full end-to-end: bead created → alarm fires ─────────────────────────

  describe('end-to-end alarm flow', () => {
    it('should handle the full bead → hook → alarm → patrol cycle', async () => {
      await rig.setTownId('town-e2e');

      // Register agent
      const agent = await rig.registerAgent({
        role: 'polecat',
        name: 'E2E-Polecat',
        identity: `e2e-${rigName}`,
      });

      // Create and assign bead
      const bead = await rig.createBead({
        type: 'issue',
        title: 'E2E test bead',
        priority: 'high',
      });
      await rig.hookBead(agent.id, bead.id);

      // hookBead arms alarm — run it
      const alarmRan = await runDurableObjectAlarm(rig);
      expect(alarmRan).toBe(true);

      // Agent should still be working (hookBead set it to working)
      const agentAfterAlarm = await rig.getAgentAsync(agent.id);
      expect(agentAfterAlarm?.status).toBe('working');

      // Agent finishes work
      await rig.agentDone(agent.id, {
        branch: 'feature/e2e',
        pr_url: 'https://github.com/org/repo/pull/99',
        summary: 'E2E work complete',
      });

      // Agent should be idle now
      const agentAfterDone = await rig.getAgentAsync(agent.id);
      expect(agentAfterDone?.status).toBe('idle');
      expect(agentAfterDone?.current_hook_bead_id).toBeNull();

      // Run alarm — should process the review queue entry
      // (will fail at container level but that's expected in tests)
      await runDurableObjectAlarm(rig);

      // Review queue entry should have been popped and processed (failed in test env)
      const reviewEntry = await rig.popReviewQueue();
      expect(reviewEntry).toBeNull();
    });
  });
});
