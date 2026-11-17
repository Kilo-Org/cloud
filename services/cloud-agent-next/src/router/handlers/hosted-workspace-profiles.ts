import {
  clearDefaultProfile,
  listProfiles,
  setDefaultProfile,
  type ProfileOwnerType,
  type ProfileSummary,
} from '@kilocode/cloud-agent-profile';
import { hasOrganizationAccess } from '@kilocode/worker-utils';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { getPgDb } from '../../db/pg.js';
import { protectedProcedure } from '../auth.js';

const hostedWorkspaceProfileSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1),
    description: z.string().nullable(),
    ownerType: z.enum(['user', 'organization']),
    isPersonalDefault: z.boolean(),
    isOrganizationDefault: z.boolean(),
  })
  .strict();

export const listHostedWorkspaceProfilesInput = z
  .object({
    kilocodeOrganizationId: z.uuid().optional(),
  })
  .strict();

export const listHostedWorkspaceProfilesOutput = z
  .object({
    personalProfiles: z.array(hostedWorkspaceProfileSummarySchema),
    organizationProfiles: z.array(hostedWorkspaceProfileSummarySchema),
    personalDefaultProfileId: z.uuid().nullable(),
    organizationDefaultProfileId: z.uuid().nullable(),
    effectiveDefaultProfileId: z.uuid().nullable(),
  })
  .strict();

export type ListHostedWorkspaceProfilesOutput = z.infer<typeof listHostedWorkspaceProfilesOutput>;

export const setHostedWorkspacePersonalDefaultProfileInput = z
  .object({ profileId: z.uuid() })
  .strict();
export const setHostedWorkspacePersonalDefaultProfileOutput = z
  .object({ success: z.literal(true) })
  .strict();
export const clearHostedWorkspacePersonalDefaultProfileInput =
  setHostedWorkspacePersonalDefaultProfileInput;
export const clearHostedWorkspacePersonalDefaultProfileOutput =
  setHostedWorkspacePersonalDefaultProfileOutput;

function projectProfile(profile: ProfileSummary, ownerType: ProfileOwnerType) {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    ownerType,
    isPersonalDefault: ownerType === 'user' && profile.isDefault,
    isOrganizationDefault: ownerType === 'organization' && profile.isDefault,
  };
}

export const listHostedWorkspaceProfiles = protectedProcedure
  .input(listHostedWorkspaceProfilesInput)
  .output(listHostedWorkspaceProfilesOutput)
  .query(async ({ input, ctx }) => {
    const db = getPgDb(ctx.env);
    const organizationId = input.kilocodeOrganizationId;
    if (
      organizationId !== undefined &&
      !(await hasOrganizationAccess(db, {
        kiloUserId: ctx.userId,
        organizationId,
      }))
    ) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Profile access denied' });
    }

    const [personalProfiles, organizationProfiles] = await Promise.all([
      listProfiles(db, { type: 'user', id: ctx.userId }),
      organizationId === undefined
        ? Promise.resolve([])
        : listProfiles(db, { type: 'organization', id: organizationId }),
    ]);
    const personalDefaultProfileId =
      personalProfiles.find(profile => profile.isDefault)?.id ?? null;
    const organizationDefaultProfileId =
      organizationProfiles.find(profile => profile.isDefault)?.id ?? null;

    return {
      personalProfiles: personalProfiles.map(profile => projectProfile(profile, 'user')),
      organizationProfiles: organizationProfiles.map(profile =>
        projectProfile(profile, 'organization')
      ),
      personalDefaultProfileId,
      organizationDefaultProfileId,
      effectiveDefaultProfileId: personalDefaultProfileId ?? organizationDefaultProfileId,
    };
  });

export const setHostedWorkspacePersonalDefaultProfile = protectedProcedure
  .input(setHostedWorkspacePersonalDefaultProfileInput)
  .output(setHostedWorkspacePersonalDefaultProfileOutput)
  .mutation(async ({ input, ctx }) => {
    await setDefaultProfile(getPgDb(ctx.env), input.profileId, {
      type: 'user',
      id: ctx.userId,
    });
    return { success: true as const };
  });

export const clearHostedWorkspacePersonalDefaultProfile = protectedProcedure
  .input(clearHostedWorkspacePersonalDefaultProfileInput)
  .output(clearHostedWorkspacePersonalDefaultProfileOutput)
  .mutation(async ({ input, ctx }) => {
    await clearDefaultProfile(getPgDb(ctx.env), input.profileId, {
      type: 'user',
      id: ctx.userId,
    });
    return { success: true as const };
  });

export function createHostedWorkspaceProfileHandlers() {
  return {
    listHostedWorkspaceProfiles,
    setHostedWorkspacePersonalDefaultProfile,
    clearHostedWorkspacePersonalDefaultProfile,
  };
}
