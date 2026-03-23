/**
 * Integration tests for GUPP nudge spam fix (#1412).
 *
 * Two bugs:
 * 1. send_nudge INSERT used SQLite's default datetime('now') format (space separator)
 *    while hasRecentNudge compared against JS toISOString() (T separator). The string
 *    comparison always failed, so every alarm tick emitted a new nudge.
 * 2. reconcileGUPP didn't exclude mayor agents. Mayors are permanently 'working' but
 *    only produce SDK events when the user chats, so they always triggered GUPP warn.
 */

import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getTownStub(name = 'test-town') {
  const id = env.TOWN.idFromName(name);
  return env.TOWN.get(id);
}

describe('reconcileGUPP nudge fixes (#1412)', () => {
  let town: ReturnType<typeof getTownStub>;
  let townName: string;

  beforeEach(async () => {
    townName = `gupp-nudge-${crypto.randomUUID()}`;
    town = getTownStub(townName);
    await town.setTownId(townName);
    await town.addRig({
      rigId: 'rig-1',
      name: 'main-rig',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });
  });

  // ── Bug 2: Mayor agents should be excluded from GUPP ──────────────

  describe('mayor exclusion from GUPP', () => {
    it('should NOT nudge a mayor even when last_event_at is stale', async () => {
      // sendMayorMessage auto-creates a mayor agent, but we can also use
      // ensureMayor to get the mayor agent ID without needing a full container.
      const { agentId: mayorId } = await town.ensureMayor();

      // Set the mayor to 'working' (simulating active chat session)
      await town.updateAgentStatus(mayorId, 'working');

      // Set last_event_at to 20 min ago (exceeds 15-min warn threshold)
      const staleTimestamp = new Date(Date.now() - 20 * 60_000).toISOString();
      await town.touchAgentHeartbeat(mayorId, {
        lastEventType: 'assistant_message',
        lastEventAt: staleTimestamp,
        activeTools: [],
      });

      // Run alarm — reconciler should skip the mayor in GUPP
      await runDurableObjectAlarm(town);

      // No nudges should exist for the mayor
      const nudges = await town.getPendingNudges(mayorId);
      const guppNudges = nudges.filter(n => n.source.startsWith('reconciler:'));
      expect(guppNudges).toHaveLength(0);
    });
  });

  // ── Bug 1: Timestamp format consistency (dedup works) ─────────────

  describe('nudge dedup after timestamp fix', () => {
    it('should nudge a stale polecat once, not on every alarm tick', async () => {
      const agent = await town.registerAgent({
        role: 'polecat',
        name: 'P1',
        identity: `gupp-dedup-${townName}`,
        rig_id: 'rig-1',
      });

      const bead = await town.createBead({
        type: 'issue',
        title: 'GUPP dedup test',
        rig_id: 'rig-1',
      });

      // Hook the agent to a bead and set to working
      await town.hookBead(agent.id, bead.bead_id);
      await town.updateAgentStatus(agent.id, 'working');

      // Set last_event_at to 20 min ago (exceeds 15-min warn threshold)
      const staleTimestamp = new Date(Date.now() - 20 * 60_000).toISOString();
      await town.touchAgentHeartbeat(agent.id, {
        lastEventType: 'tool_use',
        lastEventAt: staleTimestamp,
        activeTools: [],
      });

      // First alarm — should produce exactly one warn nudge
      await runDurableObjectAlarm(town);

      const nudgesAfterFirst = await town.getPendingNudges(agent.id);
      const warnNudges1 = nudgesAfterFirst.filter(n => n.source === 'reconciler:warn');
      expect(warnNudges1).toHaveLength(1);

      // Second alarm — hasRecentNudge should find the existing nudge and skip
      await runDurableObjectAlarm(town);

      const nudgesAfterSecond = await town.getPendingNudges(agent.id);
      const warnNudges2 = nudgesAfterSecond.filter(n => n.source === 'reconciler:warn');
      expect(warnNudges2).toHaveLength(1); // Still 1, not 2
    });
  });
});
