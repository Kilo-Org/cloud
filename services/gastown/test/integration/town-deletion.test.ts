import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getTownStub(name: string) {
  return env.TOWN.get(env.TOWN.idFromName(name));
}

function getUserStub(name: string) {
  return env.GASTOWN_USER.get(env.GASTOWN_USER.idFromName(name));
}

function getAgentStub(name: string) {
  return env.AGENT.get(env.AGENT.idFromName(name));
}

describe('Town deletion (#1182)', () => {
  let townName: string;
  let town: ReturnType<typeof getTownStub>;

  beforeEach(() => {
    townName = `town-del-${crypto.randomUUID()}`;
    town = getTownStub(townName);
  });

  // ── TownDO.destroy() ──────────────────────────────────────────────────

  describe('TownDO.destroy()', () => {
    it('should clear all storage so beads are no longer retrievable', async () => {
      await town.createBead({ type: 'issue', title: 'Doomed bead' });
      await town.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `del-agent-${townName}`,
      });

      await town.destroy();

      // After destroy, the same stub should find no data (storage was cleared)
      const beads = await town.listBeads({});
      expect(beads).toHaveLength(0);
    });

    it('should clear all agents from storage', async () => {
      await town.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `del-agents-a-${townName}`,
      });
      await town.registerAgent({
        role: 'refinery',
        name: 'R1',
        identity: `del-agents-b-${townName}`,
      });

      const agentsBefore = await town.listAgents();
      expect(agentsBefore).toHaveLength(2);

      await town.destroy();

      const agentsAfter = await town.listAgents();
      expect(agentsAfter).toHaveLength(0);
    });

    it('should delete the alarm so it does not re-fire', async () => {
      // setTownId is required for armAlarmIfNeeded to arm the alarm
      await town.setTownId(townName);
      await town.slingBead({ type: 'issue', title: 'Alarm bead', rigId: 'test-rig' });
      const ranBefore = await runDurableObjectAlarm(town);
      expect(ranBefore).toBe(true);

      await town.destroy();

      // After destroy, the alarm should not re-fire
      const ranAfter = await runDurableObjectAlarm(town);
      expect(ranAfter).toBe(false);
    });

    it('should destroy AgentDOs (clearing their event tables)', async () => {
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `del-agentdo-${townName}`,
      });

      // Write events to the AgentDO
      const agentDO = getAgentStub(agent.id);
      await agentDO.appendEvents([{ type: 'session.start', data: JSON.stringify({ test: true }) }]);

      const eventsBefore = await agentDO.getEvents();
      expect(eventsBefore.length).toBeGreaterThan(0);

      await town.destroy();

      // AgentDO should have been destroyed — events cleared
      const eventsAfter = await agentDO.getEvents();
      expect(eventsAfter).toHaveLength(0);
    });
  });

  // ── Alarm exit condition ────────────────────────────────────────────────

  describe('alarm exit condition', () => {
    it('should not re-arm alarm on a destroyed DO', async () => {
      // setTownId is required for armAlarmIfNeeded to arm the alarm
      await town.setTownId(townName);
      await town.configureRig({
        rigId: 'test-rig',
        townId: townName,
        gitUrl: 'https://github.com/org/repo.git',
        defaultBranch: 'main',
        userId: 'test-user',
      });

      // Arm alarm
      await town.slingBead({ type: 'issue', title: 'Active bead', rigId: 'test-rig' });
      const ranBefore = await runDurableObjectAlarm(town);
      expect(ranBefore).toBe(true);

      await town.destroy();

      // deleteAll() with compat date >= 2026-02-24 clears alarms,
      // so this should return false
      const ranAfterDestroy = await runDurableObjectAlarm(town);
      expect(ranAfterDestroy).toBe(false);
    });

    it('should not resurrect alarm when accessing a destroyed town', async () => {
      await town.createBead({ type: 'issue', title: 'Soon to die' });

      await town.destroy();

      // Accessing the destroyed DO triggers ensureInitialized() →
      // armAlarmIfNeeded(), which should NOT re-arm because town:id is gone
      const beads = await town.listBeads({});
      expect(beads).toHaveLength(0);

      // Alarm should NOT have been re-armed
      const ran = await runDurableObjectAlarm(town);
      expect(ran).toBe(false);
    });
  });

  // ── GastownUserDO.deleteTown() ─────────────────────────────────────────

  describe('GastownUserDO.deleteTown()', () => {
    it('should remove the town from the user list', async () => {
      const userId = `user-${crypto.randomUUID()}`;
      const userStub = getUserStub(userId);

      // createTown generates its own id; it requires name + owner_user_id
      const created = await userStub.createTown({
        name: 'Test Town',
        owner_user_id: userId,
      });

      const townsBefore = await userStub.listTowns();
      expect(townsBefore).toHaveLength(1);

      const deleted = await userStub.deleteTown(created.id);
      expect(deleted).toBe(true);

      const townsAfter = await userStub.listTowns();
      expect(townsAfter).toHaveLength(0);
    });
  });

  // ── Full deletion flow (tRPC-equivalent) ─────────────────────────────────

  describe('full deletion flow', () => {
    it('should clean up TownDO storage and user records', async () => {
      const userId = `user-${crypto.randomUUID()}`;
      const userStub = getUserStub(userId);

      // createTown generates its own id; it requires name + owner_user_id
      const created = await userStub.createTown({
        name: 'Full Delete Town',
        owner_user_id: userId,
      });
      const townId = created.id;

      // Set up TownDO with data (setTownId mirrors the tRPC createTown flow)
      const townStub = getTownStub(townId);
      await townStub.setTownId(townId);
      await townStub.createBead({ type: 'issue', title: 'Bead in deleted town' });
      await townStub.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `full-del-${townId}`,
      });

      // Simulate the fixed tRPC deleteTown flow:
      // 1. Destroy TownDO (agents, container, alarms, storage)
      await townStub.destroy();
      // 2. Remove from user's list
      await userStub.deleteTown(townId);

      // Verify user-side cleanup
      const towns = await userStub.listTowns();
      expect(towns).toHaveLength(0);

      // Verify TownDO-side cleanup
      const beads = await townStub.listBeads({});
      expect(beads).toHaveLength(0);
      const agents = await townStub.listAgents();
      expect(agents).toHaveLength(0);

      // Verify alarm is dead
      const ran = await runDurableObjectAlarm(townStub);
      expect(ran).toBe(false);
    });
  });
});
