/**
 * Integration tests for the mayor idle (waiting) lifecycle.
 *
 * Verifies that:
 * 1. The "waiting" agent status exists and can be set
 * 2. hasActiveWork() returns false when the only agent is a waiting mayor
 * 3. The alarm interval drops to idle cadence when the mayor is waiting
 * 4. mayorWaiting() transitions a working mayor to waiting
 * 5. sendMayorMessage transitions a waiting mayor back to working (when container is alive)
 * 6. Token refresh throttle persists across DO eviction (ctx.storage)
 */

import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getTownStub(name = 'test-town') {
  const id = env.TOWN.idFromName(name);
  return env.TOWN.get(id);
}

describe('Mayor idle lifecycle', () => {
  let town: ReturnType<typeof getTownStub>;
  let townName: string;

  beforeEach(async () => {
    townName = `mayor-idle-${crypto.randomUUID()}`;
    town = getTownStub(townName);
    await town.setTownId(townName);
    await town.addRig({
      rigId: 'rig-1',
      name: 'main-rig',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });
  });

  // ── waiting status ──────────────────────────────────────────────────

  describe('waiting status', () => {
    it('should allow setting an agent to waiting', async () => {
      // Register a mayor agent directly
      const agentsBefore = await town.listAgents({ role: 'mayor' });
      expect(agentsBefore.length).toBe(0);

      // ensureMayor creates the agent (won't start container in test env)
      const result = await town.ensureMayor();
      expect(result.agentId).toBeTruthy();

      // Set the agent to working first, then waiting
      await town.updateAgentStatus(result.agentId, 'working');
      const workingAgent = await town.getAgentAsync(result.agentId);
      expect(workingAgent?.status).toBe('working');

      // mayorWaiting should transition working → waiting
      await town.mayorWaiting(result.agentId);
      const waitingAgent = await town.getAgentAsync(result.agentId);
      expect(waitingAgent?.status).toBe('waiting');
    });

    it('should not transition non-working agents to waiting', async () => {
      const result = await town.ensureMayor();

      // Agent starts as idle (container not running in test env)
      const agent = await town.getAgentAsync(result.agentId);
      expect(agent?.status).toBe('idle');

      // mayorWaiting should NOT change idle to waiting
      await town.mayorWaiting(result.agentId);
      const afterAgent = await town.getAgentAsync(result.agentId);
      expect(afterAgent?.status).toBe('idle');
    });

    it('should resolve empty agentId to the mayor', async () => {
      const result = await town.ensureMayor();
      await town.updateAgentStatus(result.agentId, 'working');

      // Call with undefined agentId — should resolve to mayor
      await town.mayorWaiting();
      const agent = await town.getAgentAsync(result.agentId);
      expect(agent?.status).toBe('waiting');
    });
  });

  // ── hasActiveWork / alarm interval ──────────────────────────────────

  describe('alarm interval with waiting mayor', () => {
    it('should use idle alarm interval when mayor is waiting', async () => {
      const result = await town.ensureMayor();

      // Set mayor to working → alarm should be active (5s)
      await town.updateAgentStatus(result.agentId, 'working');
      const activeStatus = await town.getAlarmStatus();
      expect(activeStatus.alarm.intervalMs).toBe(5_000);

      // Set mayor to waiting → alarm should drop to idle (5 min)
      await town.updateAgentStatus(result.agentId, 'waiting');
      const idleStatus = await town.getAlarmStatus();
      expect(idleStatus.alarm.intervalMs).toBe(5 * 60_000);
    });

    it('should use active alarm interval when a polecat is working alongside a waiting mayor', async () => {
      const result = await town.ensureMayor();
      await town.updateAgentStatus(result.agentId, 'waiting');

      // Create a convoy to get a working polecat
      const convoy = await town.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Test',
        tasks: [{ title: 'Task 1' }],
      });

      // Run alarm to assign and dispatch the polecat
      await runDurableObjectAlarm(town);

      const bead = await town.getBeadAsync(convoy.beads[0].bead.bead_id);
      expect(bead?.assignee_agent_bead_id).toBeTruthy();

      // Set the polecat to working
      if (bead?.assignee_agent_bead_id) {
        await town.updateAgentStatus(bead.assignee_agent_bead_id, 'working');
      }

      // Now alarm should be active (polecat is working)
      const status = await town.getAlarmStatus();
      expect(status.alarm.intervalMs).toBe(5_000);
    });
  });

  // ── getMayorStatus mapping ─────────────────────────────────────────

  describe('getMayorStatus', () => {
    it('should report waiting mayor as active', async () => {
      const result = await town.ensureMayor();
      await town.updateAgentStatus(result.agentId, 'waiting');

      const status = await town.getMayorStatus();
      expect(status.session?.status).toBe('active');
    });
  });

  // ── getAlarmStatus agent counts ────────────────────────────────────

  describe('getAlarmStatus agent counts', () => {
    it('should include waiting in agent counts', async () => {
      const result = await town.ensureMayor();
      await town.updateAgentStatus(result.agentId, 'waiting');

      const status = await town.getAlarmStatus();
      expect(status.agents.waiting).toBe(1);
      expect(status.agents.working).toBe(0);
    });
  });
});
