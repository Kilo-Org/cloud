import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TownConfig } from '../../types';
import { getTownContainerStub } from '../TownContainer.do';
import { startAgentInContainer, startMergeInContainer } from './container-dispatch';

vi.mock('../TownContainer.do', () => ({ getTownContainerStub: vi.fn() }));
vi.mock('../../util/jwt.util', () => ({
  signAgentJWT: vi.fn(() => 'agent-token'),
  signContainerJWT: vi.fn(() => 'container-token'),
}));
vi.mock('../../util/analytics.util', () => ({ writeEvent: vi.fn() }));
vi.mock('./config', () => ({
  buildContainerConfig: vi.fn().mockResolvedValue({}),
  resolveModel: vi.fn(() => 'test-model'),
  resolveSmallModel: vi.fn(() => 'test-small-model'),
  resolveRigConfig: vi.fn(() => ({ custom_instructions: {} })),
}));

const townConfig: TownConfig = {
  env_vars: {},
  git_auth: {},
  owner_user_id: 'owner-user',
  owner_type: 'user',
  merge_strategy: 'direct',
  staged_convoys_default: false,
  convoy_merge_mode: 'review-and-merge',
  disable_ai_coauthor: false,
};

function createEnv(getTokenForRepo: ReturnType<typeof vi.fn>): Env {
  return {
    GASTOWN_JWT_SECRET: 'test-secret',
    GIT_TOKEN_SERVICE: { getTokenForRepo },
  } as unknown as Env;
}

describe('container dispatch GitHub token resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTownContainerStub).mockReturnValue({
      setEnvVar: vi.fn().mockResolvedValue(undefined),
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    } as unknown as ReturnType<typeof getTownContainerStub>);
  });

  it('resolves the exact dotted repository when starting an agent', async () => {
    const getTokenForRepo = vi.fn().mockResolvedValue({
      success: true,
      token: 'fresh-token',
      platformIntegrationId: 'pinned-integration',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
    });

    await expect(
      startAgentInContainer(createEnv(getTokenForRepo), {} as DurableObjectStorage, {
        townId: 'town-1',
        rigId: 'rig-1',
        userId: 'owner-user',
        agentId: 'agent-1',
        agentName: 'Agent One',
        role: 'polecat',
        identity: 'Agent One',
        beadId: 'bead-1',
        beadTitle: 'Test bead',
        beadBody: '',
        checkpoint: null,
        gitUrl: 'git@github.com:acme/repo.with.dots.git',
        defaultBranch: 'main',
        townConfig,
        platformIntegrationId: 'pinned-integration',
      })
    ).resolves.toMatchObject({ started: true });

    expect(getTokenForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/repo.with.dots',
      userId: 'owner-user',
      expectedIntegrationId: 'pinned-integration',
    });
  });

  it('resolves the exact dotted repository when starting a merge', async () => {
    const getTokenForRepo = vi.fn().mockResolvedValue({
      success: true,
      token: 'fresh-token',
      platformIntegrationId: 'pinned-integration',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
    });

    await expect(
      startMergeInContainer(createEnv(getTokenForRepo), {} as DurableObjectStorage, {
        townId: 'town-1',
        rigId: 'rig-1',
        agentId: 'agent-1',
        entryId: 'entry-1',
        beadId: 'bead-1',
        branch: 'gt/agent-one/bead-1',
        targetBranch: 'main',
        gitUrl: 'https://github.com/acme/repo.with.dots.git',
        townConfig,
        platformIntegrationId: 'pinned-integration',
      })
    ).resolves.toBe(true);

    expect(getTokenForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/repo.with.dots',
      userId: 'owner-user',
      expectedIntegrationId: 'pinned-integration',
    });
  });
});
