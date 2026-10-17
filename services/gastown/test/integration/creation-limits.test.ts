import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import {
  isCreationLimitError,
  MAX_RIGS_PER_TOWN,
  MAX_TOWNS_PER_OWNER,
  WATCHDOG_BATCH_SIZE,
} from '../../src/dos/creation-limits';

function getUserStub(name: string) {
  return env.GASTOWN_USER.get(env.GASTOWN_USER.idFromName(name));
}

function getOrgStub(name: string) {
  return env.GASTOWN_ORG.get(env.GASTOWN_ORG.idFromName(name));
}

describe('GastownUserDO creation limits', () => {
  it('should refuse town creation past the per-owner cap', async () => {
    const stub = getUserStub(`limits-towns-${crypto.randomUUID()}`);
    for (let i = 0; i < MAX_TOWNS_PER_OWNER; i++) {
      await stub.createTown({ name: `t${i}`, owner_user_id: 'u1' });
    }
    await expect(stub.createTown({ name: 'over', owner_user_id: 'u1' })).rejects.toThrow(
      /maximum number of towns/
    );
  });

  it('should free capacity when a town is deleted', async () => {
    const stub = getUserStub(`limits-free-${crypto.randomUUID()}`);
    for (let i = 0; i < MAX_TOWNS_PER_OWNER; i++) {
      await stub.createTown({ name: `t${i}`, owner_user_id: 'u1' });
    }
    const towns = await stub.listTowns();
    await stub.deleteTown(towns[0].id);
    const town = await stub.createTown({ name: 'after-delete', owner_user_id: 'u1' });
    expect(town.name).toBe('after-delete');
  });

  it('should refuse rig creation past the per-town cap', async () => {
    const stub = getUserStub(`limits-rigs-${crypto.randomUUID()}`);
    const town = await stub.createTown({ name: 'rigtown', owner_user_id: 'u1' });
    for (let i = 0; i < MAX_RIGS_PER_TOWN; i++) {
      await stub.createRig({
        town_id: town.id,
        name: `r${i}`,
        git_url: 'https://example.com/repo.git',
        default_branch: 'main',
      });
    }
    await expect(
      stub.createRig({
        town_id: town.id,
        name: 'over',
        git_url: 'https://example.com/repo.git',
        default_branch: 'main',
      })
    ).rejects.toThrow(/maximum number of rigs/);
  });

  it('should allow rigs up to the cap on other towns', async () => {
    const stub = getUserStub(`limits-othertown-${crypto.randomUUID()}`);
    const full = await stub.createTown({ name: 'full', owner_user_id: 'u1' });
    for (let i = 0; i < MAX_RIGS_PER_TOWN; i++) {
      await stub.createRig({
        town_id: full.id,
        name: `r${i}`,
        git_url: 'https://example.com/repo.git',
        default_branch: 'main',
      });
    }
    const other = await stub.createTown({ name: 'other', owner_user_id: 'u1' });
    const rig = await stub.createRig({
      town_id: other.id,
      name: 'fresh',
      git_url: 'https://example.com/repo.git',
      default_branch: 'main',
    });
    expect(rig.town_id).toBe(other.id);
  });
});

describe('CreationLimitError RPC mapping', () => {
  it('should match the caller-side error and strip the serialization prefix', async () => {
    const stub = getUserStub(`limits-mapping-${crypto.randomUUID()}`);
    for (let i = 0; i < MAX_TOWNS_PER_OWNER; i++) {
      await stub.createTown({ name: `t${i}`, owner_user_id: 'u1' });
    }
    let caught: unknown = null;
    try {
      await stub.createTown({ name: 'over', owner_user_id: 'u1' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isCreationLimitError(caught)).toBe(true);
    expect((caught as Error).message).not.toContain('CreationLimitError:');
    expect((caught as Error).message).toContain('maximum number of towns');
  });
});

describe('GastownUserDO watchdog batching', () => {
  it('should process towns in bounded batches and reset the cursor at cycle end', async () => {
    const stub = getUserStub(`watchdog-${crypto.randomUUID()}`);
    const count = WATCHDOG_BATCH_SIZE + 5;
    for (let i = 0; i < count; i++) {
      await stub.createTown({ name: `w${i}`, owner_user_id: 'u1' });
    }

    // First tick: one full batch.
    await runDurableObjectAlarm(stub);
    let status = await stub.watchdogStatus();
    expect(status.remaining).toBe(count - WATCHDOG_BATCH_SIZE);
    expect(status.cursor).not.toBeNull();

    // Second tick: the tail of the cycle, cursor resets to a fresh cycle.
    await runDurableObjectAlarm(stub);
    status = await stub.watchdogStatus();
    expect(status.cursor).toBeNull();

    // Third tick: a new cycle starts from the beginning.
    await runDurableObjectAlarm(stub);
    status = await stub.watchdogStatus();
    expect(status.cursor).not.toBeNull();
    expect(status.remaining).toBe(count - WATCHDOG_BATCH_SIZE);
  });

  it('should not arm the watchdog when the owner has no towns', async () => {
    const stub = getUserStub(`watchdog-empty-${crypto.randomUUID()}`);
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(false);
  });
});

describe('GastownOrgDO creation limits', () => {
  it('should refuse town creation past the per-org cap', async () => {
    const stub = getOrgStub(`limits-org-towns-${crypto.randomUUID()}`);
    for (let i = 0; i < MAX_TOWNS_PER_OWNER; i++) {
      await stub.createTown({ name: `t${i}`, owner_org_id: 'o1', created_by_user_id: 'u1' });
    }
    await expect(
      stub.createTown({ name: 'over', owner_org_id: 'o1', created_by_user_id: 'u1' })
    ).rejects.toThrow(/maximum number of towns/);
  });

  it('should free capacity when an org town is deleted', async () => {
    const stub = getOrgStub(`limits-org-free-${crypto.randomUUID()}`);
    for (let i = 0; i < MAX_TOWNS_PER_OWNER; i++) {
      await stub.createTown({ name: `t${i}`, owner_org_id: 'o1', created_by_user_id: 'u1' });
    }
    const towns = await stub.listTowns();
    await stub.deleteTown(towns[0].id);
    const town = await stub.createTown({
      name: 'after-delete',
      owner_org_id: 'o1',
      created_by_user_id: 'u1',
    });
    expect(town.name).toBe('after-delete');
  });

  it('should refuse rig creation past the per-town cap', async () => {
    const stub = getOrgStub(`limits-org-rigs-${crypto.randomUUID()}`);
    const town = await stub.createTown({
      name: 'rigtown',
      owner_org_id: 'o1',
      created_by_user_id: 'u1',
    });
    for (let i = 0; i < MAX_RIGS_PER_TOWN; i++) {
      await stub.createRig({
        town_id: town.id,
        name: `r${i}`,
        git_url: 'https://example.com/repo.git',
        default_branch: 'main',
      });
    }
    await expect(
      stub.createRig({
        town_id: town.id,
        name: 'over',
        git_url: 'https://example.com/repo.git',
        default_branch: 'main',
      })
    ).rejects.toThrow(/maximum number of rigs/);
  });
});

describe('GastownOrgDO watchdog batching', () => {
  it('should process org towns in bounded batches and reset the cursor at cycle end', async () => {
    const stub = getOrgStub(`watchdog-org-${crypto.randomUUID()}`);
    const count = WATCHDOG_BATCH_SIZE + 5;
    for (let i = 0; i < count; i++) {
      await stub.createTown({ name: `w${i}`, owner_org_id: 'o1', created_by_user_id: 'u1' });
    }

    await runDurableObjectAlarm(stub);
    let status = await stub.watchdogStatus();
    expect(status.remaining).toBe(count - WATCHDOG_BATCH_SIZE);
    expect(status.cursor).not.toBeNull();

    // Second tick: the tail of the cycle, cursor resets to a fresh cycle.
    await runDurableObjectAlarm(stub);
    status = await stub.watchdogStatus();
    expect(status.cursor).toBeNull();

    // Third tick: a new cycle starts from the beginning.
    await runDurableObjectAlarm(stub);
    status = await stub.watchdogStatus();
    expect(status.cursor).not.toBeNull();
    expect(status.remaining).toBe(count - WATCHDOG_BATCH_SIZE);
  });
});
