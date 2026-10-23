import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getTownContainerStub } from '../../src/dos/TownContainer.do';
import { OWNER_ACCESS_STORAGE_KEY } from '../../src/dos/town/owner-access';

function newTownId() {
  return `owner-access-${crypto.randomUUID()}`;
}

// Await the RPC call directly: `expect().rejects` pipelines extra RPC calls
// that reject unhandled.
async function startError(start: () => Promise<unknown>): Promise<string | null> {
  try {
    await start();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('Town container access revocation', () => {
  it('stops a running container and blocks every start', async () => {
    const container = getTownContainerStub(env, newTownId());
    await container.warmUp();
    expect(await container.getState()).toEqual({ status: 'healthy' });

    await container.setAccessRevoked(true);

    expect(await container.getState()).toEqual({ status: 'stopped' });
    expect(await startError(() => container.warmUp())).toContain('Gastown access is not enabled');
    expect(await startError(() => container.fetch('http://container/health'))).toContain(
      'Gastown access is not enabled'
    );
  });

  it('does not let the owner clear the block with the run policy', async () => {
    const container = getTownContainerStub(env, newTownId());
    await container.setAccessRevoked(true);

    await container.setRunPolicy('automatic');

    expect(await startError(() => container.warmUp())).toContain('Gastown access is not enabled');
  });

  it('allows starts again when access is restored', async () => {
    const container = getTownContainerStub(env, newTownId());
    await container.setAccessRevoked(true);

    await container.setAccessRevoked(false);

    expect(await container.warmUp()).toMatchObject({ coldStart: true });
  });
});

describe('Town alarm owner access', () => {
  async function configuredTown() {
    const townId = newTownId();
    const town = env.TOWN.get(env.TOWN.idFromName(townId));
    await town.setTownId(townId);
    await town.addRig({
      rigId: 'rig-1',
      name: 'Rig',
      gitUrl: 'https://github.com/org/repo.git',
      defaultBranch: 'main',
    });
    // Hooked work keeps the alarm from stopping the container as idle.
    const agent = await town.registerAgent({
      role: 'polecat',
      name: 'P1',
      identity: `polecat-${townId}`,
    });
    const bead = await town.createBead({ type: 'issue', title: 'Work', rig_id: 'rig-1' });
    await town.hookBead(agent.id, bead.bead_id);
    await runInDurableObject(town, (_instance, state) =>
      state.storage.setAlarm(Date.now() + 60_000)
    );
    return { townId, town };
  }

  it('starts the container of a town with work', async () => {
    const { townId, town } = await configuredTown();

    expect(await runDurableObjectAlarm(town)).toBe(true);

    const { status } = await getTownContainerStub(env, townId).getState();
    expect(['healthy', 'running']).toContain(status);
  });

  it('does not start the container while the owner is revoked', async () => {
    const { townId, town } = await configuredTown();
    await runInDurableObject(town, (_instance, state) =>
      state.storage.put(OWNER_ACCESS_STORAGE_KEY, { revoked: true, checkedAt: Date.now() })
    );

    expect(await runDurableObjectAlarm(town)).toBe(true);

    expect(await getTownContainerStub(env, townId).getState()).toMatchObject({ status: 'stopped' });
  });
});
