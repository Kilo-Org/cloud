import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getTownContainerStub } from '../../src/dos/TownContainer.do';
import { HELD_LABEL } from '../../src/dos/town/patrol';

// Older than the 5-minute window in which a new rig keeps the container warm.
const OLD_RIG_CREATED_AT = new Date(Date.now() - 60 * 60_000).toISOString();

async function townWithRunningContainer() {
  const townId = `container-idle-${crypto.randomUUID()}`;
  const town = env.TOWN.get(env.TOWN.idFromName(townId));
  await town.setTownId(townId);
  await town.addRig({
    rigId: 'rig-1',
    name: 'Rig',
    gitUrl: 'https://github.com/org/repo.git',
    defaultBranch: 'main',
  });
  await runInDurableObject(town, (_instance, state) => {
    state.storage.sql.exec('UPDATE rigs SET created_at = ?', OLD_RIG_CREATED_AT);
    return state.storage.setAlarm(Date.now() + 60_000);
  });
  const container = getTownContainerStub(env, townId);
  await container.warmUp();
  return { townId, town, container };
}

describe('Town alarm idle container stop', () => {
  it('stops the container when the town only has work it never dispatches', async () => {
    const { town, container } = await townWithRunningContainer();
    // A held issue counts as active work, but the reconciler never dispatches it.
    await town.createBead({ type: 'issue', title: 'Held', rig_id: 'rig-1', labels: [HELD_LABEL] });

    expect(await runDurableObjectAlarm(town)).toBe(true);

    expect(await container.getState()).toEqual({ status: 'stopped' });
  });

  it('keeps the container while an agent is working', async () => {
    const { townId, town, container } = await townWithRunningContainer();
    const agent = await town.registerAgent({
      role: 'polecat',
      name: 'P1',
      identity: `polecat-${townId}`,
    });
    const bead = await town.createBead({ type: 'issue', title: 'Work', rig_id: 'rig-1' });
    await town.hookBead(agent.id, bead.bead_id);
    await town.updateAgentStatus(agent.id, 'working');
    await town.touchAgentHeartbeat(agent.id);

    expect(await runDurableObjectAlarm(town)).toBe(true);

    expect(await container.getState()).toEqual({ status: 'healthy' });
  });
});
