import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TownDO } from '../../src/dos/Town.do';
import type { ApplyActionContext } from '../../src/dos/town/actions';

const GIT_URL = 'git@github.com:acme/repo.with.dots.git';
const EXPECTED_LOOKUP = {
  githubRepo: 'acme/repo.with.dots',
  userId: 'user-1',
  expectedIntegrationId: 'integration-1',
};

type LookupParams = typeof EXPECTED_LOOKUP & { orgId?: string };
type RuntimeTown = {
  setupRigRepoInContainer: (rigConfig: RigConfig) => Promise<void>;
  rigListForMayor: () => Promise<unknown>;
  applyActionCtx: ApplyActionContext;
};
type RigConfig = {
  townId: string;
  rigId: string;
  gitUrl: string;
  defaultBranch: string;
  userId: string;
  platformIntegrationId: string;
};

function getTown() {
  return env.TOWN.get(env.TOWN.idFromName(`dotted-runtime-${crypto.randomUUID()}`));
}

function installRejectingTokenService(instance: TownDO): LookupParams[] {
  const calls: LookupParams[] = [];
  const runtime = instance as unknown as { env: Env };
  runtime.env = {
    ...runtime.env,
    GIT_TOKEN_SERVICE: {
      getTokenForRepo: async params => {
        calls.push(params as LookupParams);
        return { success: false, reason: 'integration_mismatch' };
      },
      getToken: async () => '',
    },
  };
  return calls;
}

async function seedRig(instance: TownDO, state: DurableObjectState): Promise<RigConfig> {
  const rigConfig = {
    townId: 'town-1',
    rigId: 'rig-1',
    gitUrl: GIT_URL,
    defaultBranch: 'main',
    userId: 'user-1',
    platformIntegrationId: 'integration-1',
  };
  await instance.addRig({
    rigId: rigConfig.rigId,
    name: 'dotted-rig',
    gitUrl: rigConfig.gitUrl,
    defaultBranch: rigConfig.defaultBranch,
  });
  await state.storage.put(`rig:${rigConfig.rigId}:config`, rigConfig);
  return rigConfig;
}

describe('dotted repository runtime paths', () => {
  it('preserves the repository during proactive rig clone setup', async () => {
    const town = getTown();

    const calls = await runInDurableObject(town, async (instance: TownDO) => {
      const lookups = installRejectingTokenService(instance);
      const rigConfig = {
        townId: 'town-1',
        rigId: 'rig-1',
        gitUrl: GIT_URL,
        defaultBranch: 'main',
        userId: 'user-1',
        platformIntegrationId: 'integration-1',
      };
      await (instance as unknown as RuntimeTown).setupRigRepoInContainer(rigConfig);
      return lookups;
    });

    expect(calls).toEqual([EXPECTED_LOOKUP]);
  });

  it('preserves the repository for PR status, feedback, and merge operations', async () => {
    const town = getTown();

    const calls = await runInDurableObject(town, async (instance: TownDO, state) => {
      await seedRig(instance, state);
      const lookups = installRejectingTokenService(instance);
      const actions = (instance as unknown as RuntimeTown).applyActionCtx;

      await actions.checkPRStatus('https://github.com/acme/repo.with.dots/pull/1', 'rig-1');
      await actions.checkPRFeedback('https://github.com/acme/repo.with.dots/pull/1', 'rig-1');
      await actions.mergePR('https://github.com/acme/repo.with.dots/pull/1', 'rig-1');
      return lookups;
    });

    expect(calls).toEqual([EXPECTED_LOOKUP, EXPECTED_LOOKUP, EXPECTED_LOOKUP]);
  });

  it('preserves the repository while preparing mayor browse worktrees', async () => {
    const town = getTown();

    const calls = await runInDurableObject(town, async (instance: TownDO, state) => {
      await seedRig(instance, state);
      const lookups = installRejectingTokenService(instance);
      await (instance as unknown as RuntimeTown).rigListForMayor();
      return lookups;
    });

    expect(calls).toEqual([EXPECTED_LOOKUP]);
  });

  it('preserves the repository when creating a convoy branch', async () => {
    const town = getTown();

    const calls = await runInDurableObject(town, async (instance: TownDO, state) => {
      await seedRig(instance, state);
      const lookups = installRejectingTokenService(instance);
      await instance.slingConvoy({
        rigId: 'rig-1',
        convoyTitle: 'Dotted repository convoy',
        tasks: [{ title: 'Task one' }],
        staged: true,
      });
      return lookups;
    });

    expect(calls).toEqual([EXPECTED_LOOKUP]);
  });
});
