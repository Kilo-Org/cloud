import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getTownStub(name = 'test-town') {
  const id = env.TOWN.idFromName(name);
  return env.TOWN.get(id);
}

/**
 * The container's own storage, used as proof of whether a dispatch reached it:
 * the @cloudflare/containers mock writes `container:state` on /agents/start.
 */
async function containerState(townName: string): Promise<unknown> {
  const stub = env.TOWN_CONTAINER.get(env.TOWN_CONTAINER.idFromName(townName));
  return runInDurableObject(stub, (_instance, state) => state.storage.get('container:state'));
}

describe('Town DO Alarm', () => {
  let townName: string;
  let town: ReturnType<typeof getTownStub>;

  beforeEach(async () => {
    townName = `town-alarm-${crypto.randomUUID()}`;
    town = getTownStub(townName);
    // Both armAlarmIfNeeded and escalateToActiveCadence bail out when the DO
    // has no stored town:id, so the alarm is only armed for a real town.
    await town.setTownId(townName);
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

      await town.hookBead(agent.id, bead.bead_id);

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
      await town.hookBead(agent.id, bead.bead_id);

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
      await town.hookBead(agent.id, bead.bead_id);

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
        bead_id: bead.bead_id,
        rig_id: 'test-rig',
        branch: 'feature/review',
      });

      // Run alarm — the container isn't available in tests, so the merge will
      // fail gracefully and mark the review as 'failed'
      await runDurableObjectAlarm(town);

      // The MR bead should no longer be open (alarm processed it)
      const mrBeads = await town.listBeads({ type: 'merge_request' });
      expect(mrBeads).toHaveLength(1);
      expect(mrBeads[0].status).not.toBe('open');
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
      await town.hookBead(agent.id, bead.bead_id);

      // Run alarm — no rig config, so the container must never be asked to start
      await runDurableObjectAlarm(town);

      expect(await containerState(townName)).toBeUndefined();
      // The reconciler marks a hooked agent 'working' before dispatchAgent()
      // bails out on the missing rig config, so the hook is retained.
      const updatedAgent = await town.getAgentAsync(agent.id);
      expect(updatedAgent?.current_hook_bead_id).toBe(bead.bead_id);
    });

    it('should attempt to dispatch idle agents with hooked beads', async () => {
      await town.addRig({
        rigId: 'test-rig',
        name: 'test-rig',
        gitUrl: 'https://github.com/org/repo.git',
        defaultBranch: 'main',
      });
      await town.configureRig(testRigConfig());

      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `dispatch-${townName}`,
      });
      const bead = await town.createBead({ type: 'issue', title: 'Dispatch bead' });
      await town.hookBead(agent.id, bead.bead_id);

      // Run alarm — dispatchAgent() records the attempt on the bead before it
      // asks the container to start (the container start itself aborts here
      // because the test env cannot mint the container auth tokens).
      await runDurableObjectAlarm(town);

      const updatedAgent = await town.getAgentAsync(agent.id);
      expect(updatedAgent?.status).toBe('working');
      const updatedBead = await town.getBeadAsync(bead.bead_id);
      expect(updatedBead?.dispatch_attempts).toBeGreaterThan(0);
    });
  });

  // ── witnessPatrol with alarm ────────────────────────────────────────────

  describe('witness patrol via alarm', () => {
    it('should reap dead agents when alarm fires', async () => {
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'DeadAgent',
        identity: `alarm-dead-${townName}`,
      });
      await town.updateAgentStatus(agent.id, 'dead');
      await town.configureRig(testRigConfig());

      // Run alarm — witnessPatrol runs internally and reaps the dead agent
      await runDurableObjectAlarm(town);

      expect(await town.getAgentAsync(agent.id)).toBeNull();
    });

    it('should handle orphaned beads during alarm', async () => {
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'OrphanMaker',
        identity: `alarm-orphan-${townName}`,
      });
      const bead = await town.createBead({ type: 'issue', title: 'Orphan bead' });
      await town.hookBead(agent.id, bead.bead_id);

      // Kill the agent — bead is now orphaned (hooked to dead agent)
      await town.updateAgentStatus(agent.id, 'dead');

      await town.configureRig(testRigConfig());
      await runDurableObjectAlarm(town);

      // Bead should still exist and be in_progress (patrol doesn't auto-reassign yet)
      const beadAfter = await town.getBeadAsync(bead.bead_id);
      expect(beadAfter).not.toBeNull();
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
      await town.hookBead(agent.id, bead.bead_id);

      // hookBead arms alarm — run it (the container start aborts in tests
      // because no auth tokens can be minted, so the agent is left as the
      // reconciler marked it; agent status is asserted in the
      // "schedule pending work" cases above)
      const alarmRan = await runDurableObjectAlarm(town);
      expect(alarmRan).toBe(true);

      // Simulate agent completing work (in production the container
      // would have started the agent and it would call agentDone)
      await town.agentDone(agent.id, {
        branch: 'feature/e2e',
        pr_url: 'https://github.com/org/repo/pull/99',
        summary: 'E2E work complete',
      });

      // Run alarm — drains the agent_done event: the source bead moves to
      // in_review and an MR bead is created, which the alarm then tries to
      // merge (the merge fails without a container, but it is no longer open).
      await runDurableObjectAlarm(town);

      const sourceBead = await town.getBeadAsync(bead.bead_id);
      expect(sourceBead?.status).toBe('in_review');

      // MR bead should have been picked up and processed (failed in test env)
      const mrBeads = await town.listBeads({ type: 'merge_request' });
      expect(mrBeads).toHaveLength(1);
      expect(mrBeads[0].status).not.toBe('open');
    });
  });
});
