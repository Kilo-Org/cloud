import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getTownStub(name = 'test-town') {
  const id = env.TOWN.idFromName(name);
  return env.TOWN.get(id);
}

describe('Town DO Alarm', () => {
  let townName: string;
  let town: ReturnType<typeof getTownStub>;

  beforeEach(() => {
    townName = `town-alarm-${crypto.randomUUID()}`;
    town = getTownStub(townName);
  });

  // ── Rig config management ─────────────────────────────────────────────

  const testRigConfig = (rigId = 'test-rig') => ({
    rigId,
    townId: 'town-abc',
    gitUrl: 'https://github.com/org/repo.git',
    defaultBranch: 'main',
    userId: 'test-user',
  });

  describe('rig config', () => {
    it('should store and retrieve rig config', async () => {
      const cfg = testRigConfig();
      await town.configureRig(cfg);
      const retrieved = await town.getRigConfig(cfg.rigId);
      expect(retrieved).toMatchObject(cfg);
    });

    it('should return null when no rig config is set', async () => {
      const retrieved = await town.getRigConfig('nonexistent');
      expect(retrieved).toBeNull();
    });
  });

  // ── Alarm arming ────────────────────────────────────────────────────────

  describe('alarm arming', () => {
    it('should arm alarm when hookBead is called', async () => {
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `alarm-hook-${townName}`,
      });
      const bead = await town.createBead({ type: 'issue', title: 'Test bead' });

      await town.hookBead(agent.id, bead.id);

      // The alarm should fire without error
      const ran = await runDurableObjectAlarm(town);
      expect(ran).toBe(true);
    });

    it('should arm alarm when agentDone is called', async () => {
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `alarm-done-${townName}`,
      });
      const bead = await town.createBead({ type: 'issue', title: 'Done bead' });
      await town.hookBead(agent.id, bead.id);

      // Run the initial alarm from hookBead
      await runDurableObjectAlarm(town);

      await town.agentDone(agent.id, {
        branch: 'feature/test',
        summary: 'Test done',
      });

      // Another alarm should be armed
      const ran = await runDurableObjectAlarm(town);
      expect(ran).toBe(true);
    });

    it('should arm alarm when slingBead is called', async () => {
      await town.slingBead({
        type: 'issue',
        title: 'Alarm trigger test',
        rigId: 'test-rig',
      });

      const ran = await runDurableObjectAlarm(town);
      expect(ran).toBe(true);
    });

    it('should arm alarm when touchAgentHeartbeat is called', async () => {
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `alarm-heartbeat-${townName}`,
      });

      await town.touchAgentHeartbeat(agent.id);

      const ran = await runDurableObjectAlarm(town);
      expect(ran).toBe(true);
    });
  });

  // ── Alarm handler behavior ──────────────────────────────────────────────

  describe('alarm handler', () => {
    it('should re-arm when there is active work', async () => {
      await town.configureRig(testRigConfig());
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `rearm-${townName}`,
      });
      const bead = await town.createBead({ type: 'issue', title: 'Active work' });
      await town.hookBead(agent.id, bead.id);

      // First alarm from hookBead
      await runDurableObjectAlarm(town);

      // Agent is working with an in-progress bead — alarm should re-arm
      const ranAgain = await runDurableObjectAlarm(town);
      expect(ranAgain).toBe(true);
    });

    it('should re-arm with idle interval when there is no active work', async () => {
      // Arm alarm via slingBead
      await town.slingBead({ type: 'issue', title: 'Arm alarm', rigId: 'test-rig' });

      // First alarm — no agents working, so idle interval
      const ran = await runDurableObjectAlarm(town);
      expect(ran).toBe(true);

      // TownDO always re-arms (idle interval when no active work)
      const ranAgain = await runDurableObjectAlarm(town);
      expect(ranAgain).toBe(true);
    });

    it('should process review queue entries during alarm', async () => {
      await town.configureRig(testRigConfig());
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `alarm-review-${townName}`,
      });
      const bead = await town.createBead({ type: 'issue', title: 'Review bead' });

      await town.submitToReviewQueue({
        agent_id: agent.id,
        bead_id: bead.id,
        branch: 'feature/review',
      });

      // Run alarm — the container isn't available in tests, so the merge will
      // fail gracefully and mark the review as 'failed'
      await runDurableObjectAlarm(town);

      // The pending entry should have been popped (no more pending entries)
      const nextEntry = await town.popReviewQueue();
      expect(nextEntry).toBeNull();
    });
  });

  // ── schedulePendingWork ─────────────────────────────────────────────────

  describe('schedule pending work', () => {
    it('should not dispatch agents without rig config', async () => {
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `no-town-${townName}`,
      });
      const bead = await town.createBead({ type: 'issue', title: 'Pending bead' });
      await town.hookBead(agent.id, bead.id);

      // Run alarm — no rig config, so scheduling should be skipped
      await runDurableObjectAlarm(town);

      // Agent should still be idle (not dispatched)
      const updatedAgent = await town.getAgentAsync(agent.id);
      expect(updatedAgent?.status).toBe('idle');
    });

    it('should attempt to dispatch idle agents with hooked beads', async () => {
      await town.configureRig(testRigConfig());

      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `dispatch-${townName}`,
      });
      const bead = await town.createBead({ type: 'issue', title: 'Dispatch bead' });
      await town.hookBead(agent.id, bead.id);

      // Run alarm — container not available in tests, so startAgentInContainer
      // will fail, but the attempt should be made
      await runDurableObjectAlarm(town);

      // Agent stays idle because container start failed
      const updatedAgent = await town.getAgentAsync(agent.id);
      expect(updatedAgent?.status).toBe('idle');
    });
  });

  // ── witnessPatrol with alarm ────────────────────────────────────────────

  describe('witness patrol via alarm', () => {
    it('should still detect dead agents when alarm fires', async () => {
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'DeadAgent',
        identity: `alarm-dead-${townName}`,
      });
      await town.updateAgentStatus(agent.id, 'dead');
      await town.configureRig(testRigConfig());

      // Run alarm — witnessPatrol runs as part of alarm
      await runDurableObjectAlarm(town);

      // Verify via direct witnessPatrol call
      const result = await town.witnessPatrol();
      expect(result.dead_agents).toContain(agent.id);
    });

    it('should detect orphaned beads during alarm', async () => {
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'OrphanMaker',
        identity: `alarm-orphan-${townName}`,
      });
      const bead = await town.createBead({ type: 'issue', title: 'Orphan bead' });
      await town.hookBead(agent.id, bead.id);

      // Kill the agent
      await town.updateAgentStatus(agent.id, 'dead');

      await town.configureRig(testRigConfig());
      await runDurableObjectAlarm(town);

      const result = await town.witnessPatrol();
      expect(result.orphaned_beads).toContain(bead.id);
    });
  });

  // ── Full end-to-end: bead created → alarm fires ─────────────────────────

  describe('end-to-end alarm flow', () => {
    it('should handle the full bead → hook → alarm → patrol cycle', async () => {
      await town.configureRig(testRigConfig());

      // Register agent
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'E2E-Polecat',
        identity: `e2e-${townName}`,
      });

      // Create and assign bead
      const bead = await town.createBead({
        type: 'issue',
        title: 'E2E test bead',
        priority: 'high',
      });
      await town.hookBead(agent.id, bead.id);

      // hookBead arms alarm — run it (container unavailable in tests,
      // so agent stays idle since dispatch fails)
      const alarmRan = await runDurableObjectAlarm(town);
      expect(alarmRan).toBe(true);

      const agentAfterAlarm = await town.getAgentAsync(agent.id);
      expect(agentAfterAlarm?.status).toBe('idle');
      expect(agentAfterAlarm?.current_hook_bead_id).toBe(bead.id);

      // Simulate agent completing work (in production the container
      // would have started the agent and it would call agentDone)
      await town.agentDone(agent.id, {
        branch: 'feature/e2e',
        pr_url: 'https://github.com/org/repo/pull/99',
        summary: 'E2E work complete',
      });

      // Agent should be idle now
      const agentAfterDone = await town.getAgentAsync(agent.id);
      expect(agentAfterDone?.status).toBe('idle');
      expect(agentAfterDone?.current_hook_bead_id).toBeNull();

      // Run alarm — should process the review queue entry
      // (will fail at container level but that's expected in tests)
      await runDurableObjectAlarm(town);

      // Review queue entry should have been popped and processed (failed in test env)
      const reviewEntry = await town.popReviewQueue();
      expect(reviewEntry).toBeNull();
    });
  });
});
