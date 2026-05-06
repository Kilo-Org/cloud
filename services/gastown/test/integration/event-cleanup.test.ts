/**
 * Tests for the "orphaned bead_cancelled events retried forever" bug.
 *
 * Two independent fixes compose to eliminate the failure:
 *   Fix 1: deleteBead / deleteBeads purge town_events rows that reference
 *          the deleted bead (by bead_id or agent_id), so the drain loop
 *          never sees them.
 *   Fix 2a: reconciler.applyEvent('bead_cancelled') tolerates the bead
 *          being missing (returns early, logs warn — does not throw).
 *   Fix 2b: the Town.do.ts drain loop recognises "Bead/Agent ... not
 *          found" terminal errors and marks the offending event
 *          processed so it is not retried forever.
 */

import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getTownStub(name: string) {
  return env.TOWN.get(env.TOWN.idFromName(name));
}

describe('town_events cleanup on bead deletion (#fix-1)', () => {
  let town: ReturnType<typeof getTownStub>;
  let townName: string;

  beforeEach(async () => {
    townName = `evcleanup-${crypto.randomUUID()}`;
    town = getTownStub(townName);
    await town.setTownId(townName);
    await town.addRig({
      rigId: 'rig-1',
      name: 'main-rig',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });
  });

  it('deleteBead removes pending town_events referencing the bead by bead_id', async () => {
    const bead = await town.createBead({
      type: 'issue',
      title: 'To be deleted',
      rig_id: 'rig-1',
    });

    // Transitioning to a terminal status enqueues a bead_cancelled event.
    await town.updateBeadStatus(bead.bead_id, 'failed', 'system');

    const pendingBefore = (await town.debugTownEvents()) as Array<{
      bead_id: string | null;
      processed_at: string | null;
    }>;
    expect(
      pendingBefore.filter(e => e.bead_id === bead.bead_id && e.processed_at === null).length
    ).toBeGreaterThan(0);

    await town.deleteBead(bead.bead_id);

    const pendingAfter = (await town.debugTownEvents()) as Array<{
      bead_id: string | null;
      agent_id: string | null;
    }>;
    expect(pendingAfter.some(e => e.bead_id === bead.bead_id || e.agent_id === bead.bead_id)).toBe(
      false
    );
  });

  it('deleteBead also removes events referencing the bead as agent_id (agents are beads)', async () => {
    const agent = await town.registerAgent({
      role: 'polecat',
      name: 'P1',
      identity: `ev-agent-${townName}`,
      rig_id: 'rig-1',
    });

    // Upsert a container_status event keyed by agent_id — this is the shape
    // of events that hang off an agent's bead row.
    await town.debugRecordContainerStatus(agent.id, { status: 'running' });

    const beforeRows = (await town.debugTownEvents()) as Array<{ agent_id: string | null }>;
    expect(beforeRows.some(e => e.agent_id === agent.id)).toBe(true);

    // deleteBead is used for agents too (agents are beads).
    await town.deleteBead(agent.id);

    const afterRows = (await town.debugTownEvents()) as Array<{ agent_id: string | null }>;
    expect(afterRows.some(e => e.agent_id === agent.id)).toBe(false);
  });

  it('deleteBeads bulk path removes events for every deleted bead', async () => {
    const a = await town.createBead({ type: 'issue', title: 'A', rig_id: 'rig-1' });
    const b = await town.createBead({ type: 'issue', title: 'B', rig_id: 'rig-1' });

    await town.updateBeadStatus(a.bead_id, 'failed', 'system');
    await town.updateBeadStatus(b.bead_id, 'failed', 'system');

    const before = (await town.debugTownEvents()) as Array<{ bead_id: string | null }>;
    expect(before.filter(e => e.bead_id === a.bead_id).length).toBeGreaterThan(0);
    expect(before.filter(e => e.bead_id === b.bead_id).length).toBeGreaterThan(0);

    await town.deleteBeads([a.bead_id, b.bead_id]);

    const after = (await town.debugTownEvents()) as Array<{ bead_id: string | null }>;
    expect(after.some(e => e.bead_id === a.bead_id)).toBe(false);
    expect(after.some(e => e.bead_id === b.bead_id)).toBe(false);
  });
});

describe('applyEvent tolerance + drain loop marks missing-entity events processed (#fix-2)', () => {
  let town: ReturnType<typeof getTownStub>;
  let townName: string;

  beforeEach(async () => {
    townName = `evtolerate-${crypto.randomUUID()}`;
    town = getTownStub(townName);
    await town.setTownId(townName);
    await town.addRig({
      rigId: 'rig-1',
      name: 'main-rig',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });
  });

  it('drain loop marks a bead_cancelled event processed when the bead is gone', async () => {
    // Simulate the historical orphan: enqueue a bead_cancelled event whose
    // bead has been deleted (or never existed). Before Fix 2, applyEvent
    // would throw `Bead <id> not found` forever on every alarm tick.
    await town.debugInsertTownEvent({
      event_type: 'bead_cancelled',
      bead_id: '00000000-0000-4000-8000-000000000001',
      payload: { cancel_status: 'failed' },
    });

    const beforeDrain = (await town.debugTownEvents()) as Array<{
      event_type: string;
      bead_id: string | null;
      processed_at: string | null;
    }>;
    const orphan = beforeDrain.find(
      e => e.event_type === 'bead_cancelled' && e.bead_id === '00000000-0000-4000-8000-000000000001'
    );
    expect(orphan?.processed_at).toBeNull();

    await runDurableObjectAlarm(town);

    // After the alarm, the orphan event should be processed — not retried.
    const afterDrain = (await town.debugTownEvents()) as Array<{
      event_type: string;
      bead_id: string | null;
      processed_at: string | null;
    }>;
    const orphanAfter = afterDrain.find(
      e => e.event_type === 'bead_cancelled' && e.bead_id === '00000000-0000-4000-8000-000000000001'
    );
    // If retention GC already pruned it, that's also acceptable — the key
    // invariant is that it is no longer pending.
    if (orphanAfter) {
      expect(orphanAfter.processed_at).not.toBeNull();
    }
  });

  it('drain loop marks an agent-missing event processed too', async () => {
    await town.debugInsertTownEvent({
      event_type: 'agent_done',
      agent_id: '00000000-0000-4000-8000-0000000000aa',
      payload: { branch: 'gt/ghost' },
    });

    await runDurableObjectAlarm(town);

    const after = (await town.debugTownEvents()) as Array<{
      event_type: string;
      agent_id: string | null;
      processed_at: string | null;
    }>;
    const orphanAfter = after.find(
      e => e.event_type === 'agent_done' && e.agent_id === '00000000-0000-4000-8000-0000000000aa'
    );
    if (orphanAfter) {
      expect(orphanAfter.processed_at).not.toBeNull();
    }
  });
});
