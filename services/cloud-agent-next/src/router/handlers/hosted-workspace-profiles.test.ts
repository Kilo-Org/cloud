import type * as CloudAgentProfile from '@kilocode/cloud-agent-profile';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env, TRPCContext } from '../../types.js';
import { router } from '../auth.js';
import {
  clearHostedWorkspacePersonalDefaultProfile,
  listHostedWorkspaceProfiles,
  setHostedWorkspacePersonalDefaultProfile,
} from './hosted-workspace-profiles.js';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  listProfiles: vi.fn(),
  setDefaultProfile: vi.fn(),
  clearDefaultProfile: vi.fn(),
  hasOrganizationAccess: vi.fn(),
}));

vi.mock('../../db/pg', () => ({ getPgDb: mocks.getDb }));
vi.mock('@kilocode/worker-utils', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, hasOrganizationAccess: mocks.hasOrganizationAccess };
});
vi.mock('@kilocode/cloud-agent-profile', async importActual => ({
  ...(await importActual<typeof CloudAgentProfile>()),
  listProfiles: mocks.listProfiles,
  setDefaultProfile: mocks.setDefaultProfile,
  clearDefaultProfile: mocks.clearDefaultProfile,
}));

const userId = 'oauth/google:profile-owner';
const organizationId = '11111111-1111-4111-8111-111111111111';
const profileId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherProfileId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const ctx = {
  env: {} as Env,
  userId,
  authToken: 'authenticated-user-token',
  request: new Request('https://worker.test/trpc/listHostedWorkspaceProfiles'),
} satisfies TRPCContext;

function summary(id: string, name: string, isDefault: boolean): CloudAgentProfile.ProfileSummary {
  return {
    id,
    name,
    description: null,
    isDefault,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    varCount: 0,
    commandCount: 0,
    mcpServerCount: 0,
    skillCount: 0,
    agentCount: 0,
    kiloCommandCount: 0,
    instructionCount: 0,
  };
}

function caller() {
  return router({
    listHostedWorkspaceProfiles,
    setHostedWorkspacePersonalDefaultProfile,
    clearHostedWorkspacePersonalDefaultProfile,
  }).createCaller(ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDb.mockReturnValue({});
  mocks.hasOrganizationAccess.mockResolvedValue(true);
  mocks.listProfiles.mockImplementation((_db, owner: { type: string; id: string }) =>
    owner.type === 'user'
      ? Promise.resolve([summary(profileId, 'Personal default', true)])
      : Promise.resolve([summary(otherProfileId, 'Org default', true)])
  );
  mocks.setDefaultProfile.mockResolvedValue(undefined);
  mocks.clearDefaultProfile.mockResolvedValue(undefined);
});

describe('hosted workspace profiles', () => {
  it('returns personal profiles and marks the personal default without an organization', async () => {
    const result = await caller().listHostedWorkspaceProfiles({});

    expect(result).toEqual({
      personalProfiles: [
        {
          id: profileId,
          name: 'Personal default',
          description: null,
          ownerType: 'user',
          isPersonalDefault: true,
          isOrganizationDefault: false,
        },
      ],
      organizationProfiles: [],
      personalDefaultProfileId: profileId,
      organizationDefaultProfileId: null,
      effectiveDefaultProfileId: profileId,
    });
    expect(mocks.hasOrganizationAccess).not.toHaveBeenCalled();
  });

  it('returns organization profiles with organization-default attributes', async () => {
    mocks.listProfiles.mockImplementation((_db, owner: { type: string }) =>
      owner.type === 'user'
        ? Promise.resolve([summary(profileId, 'Personal', false)])
        : Promise.resolve([summary(otherProfileId, 'Org default', true)])
    );

    const result = await caller().listHostedWorkspaceProfiles({
      kilocodeOrganizationId: organizationId,
    });

    expect(result).toEqual({
      personalProfiles: [
        {
          id: profileId,
          name: 'Personal',
          description: null,
          ownerType: 'user',
          isPersonalDefault: false,
          isOrganizationDefault: false,
        },
      ],
      organizationProfiles: [
        {
          id: otherProfileId,
          name: 'Org default',
          description: null,
          ownerType: 'organization',
          isPersonalDefault: false,
          isOrganizationDefault: true,
        },
      ],
      personalDefaultProfileId: null,
      organizationDefaultProfileId: otherProfileId,
      effectiveDefaultProfileId: otherProfileId,
    });
    expect(mocks.hasOrganizationAccess).toHaveBeenCalledWith(expect.anything(), {
      kiloUserId: userId,
      organizationId,
    });
  });

  it('prefers a personal default over an organization default', async () => {
    const result = await caller().listHostedWorkspaceProfiles({
      kilocodeOrganizationId: organizationId,
    });

    expect(result.personalDefaultProfileId).toBe(profileId);
    expect(result.organizationDefaultProfileId).toBe(otherProfileId);
    expect(result.effectiveDefaultProfileId).toBe(profileId);
  });

  it('rejects an organization the caller cannot access', async () => {
    mocks.hasOrganizationAccess.mockResolvedValue(false);

    await expect(
      caller().listHostedWorkspaceProfiles({ kilocodeOrganizationId: organizationId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Profile access denied' });
    expect(mocks.listProfiles).not.toHaveBeenCalled();
  });

  it('sets a personal default with the authenticated user as owner', async () => {
    await expect(caller().setHostedWorkspacePersonalDefaultProfile({ profileId })).resolves.toEqual(
      { success: true }
    );

    expect(mocks.setDefaultProfile).toHaveBeenCalledWith(expect.anything(), profileId, {
      type: 'user',
      id: userId,
    });
  });

  it('clears a personal default with the authenticated user as owner', async () => {
    await expect(
      caller().clearHostedWorkspacePersonalDefaultProfile({ profileId })
    ).resolves.toEqual({ success: true });

    expect(mocks.clearDefaultProfile).toHaveBeenCalledWith(expect.anything(), profileId, {
      type: 'user',
      id: userId,
    });
  });

  it('propagates a not-found rejection for a profile the caller does not own', async () => {
    mocks.setDefaultProfile.mockRejectedValue(
      new TRPCError({ code: 'NOT_FOUND', message: 'Profile not found' })
    );

    await expect(
      caller().setHostedWorkspacePersonalDefaultProfile({ profileId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Profile not found' });
  });

  it('rejects malformed profile input before touching the profile service', async () => {
    await expect(
      caller().setHostedWorkspacePersonalDefaultProfile({ profileId: 'not-a-uuid' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.setDefaultProfile).not.toHaveBeenCalled();
  });
});
