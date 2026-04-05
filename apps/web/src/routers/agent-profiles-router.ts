import { createTRPCRouter, baseProcedure } from '@/lib/trpc/init';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import * as profileService from '@/lib/agent/profile-service';
import * as profileVarsService from '@/lib/agent/profile-vars-service';
import * as profileCommandsService from '@/lib/agent/profile-commands-service';
import type { ProfileOwner } from '@/lib/agent/types';

function isForeignKeyViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: string }).code === '23503'
  );
}

// Input schemas
const ProfileIdSchema = z.object({
  profileId: z.uuid(),
});

const ProfileNameSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

const VarSchema = z.object({
  key: z.string().min(1).max(256),
  value: z.string().max(10000),
  isSecret: z.boolean(),
});

const CommandsSchema = z.object({
  commands: z.array(z.string().max(500)).max(20),
});

// Owner type schema
const ProfileOwnerTypeSchema = z.enum(['organization', 'user']);

// Output schemas
const ProfileSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  varCount: z.number(),
  commandCount: z.number(),
});

const ProfileSummaryWithOwnerSchema = ProfileSummarySchema.extend({
  ownerType: ProfileOwnerTypeSchema,
});

const ProfileVarResponseSchema = z.object({
  key: z.string(),
  value: z.string(),
  isSecret: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ProfileCommandResponseSchema = z.object({
  sequence: z.number(),
  command: z.string(),
});

const ProfileResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  vars: z.array(ProfileVarResponseSchema),
  commands: z.array(ProfileCommandResponseSchema),
});

/**
 * Helper to determine owner from input.
 * If organizationId is provided, returns org owner; otherwise returns user owner.
 */
function getOwner(organizationId: string | undefined, userId: string): ProfileOwner {
  if (organizationId) {
    return { type: 'organization', id: organizationId };
  }
  return { type: 'user', id: userId };
}

/**
 * Agent Environment Profiles Router
 *
 * Supports both user-owned and organization-owned profiles.
 * When organizationId is provided, operates on org profiles (requires org membership).
 * When organizationId is omitted, operates on user's personal profiles.
 */
export const agentProfilesRouter = createTRPCRouter({
  /**
   * List all profiles for the current user or organization.
   */
  list: baseProcedure
    .input(z.object({ organizationId: z.uuid().optional() }))
    .output(z.array(ProfileSummarySchema))
    .query(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      return profileService.listProfiles(owner);
    }),

  /**
   * List both org and personal profiles when in org context.
   * Returns profiles grouped by owner type with effective default resolution.
   * Org default takes precedence over personal default.
   */
  listCombined: baseProcedure
    .input(z.object({ organizationId: z.uuid() }))
    .output(
      z.object({
        orgProfiles: z.array(ProfileSummaryWithOwnerSchema),
        personalProfiles: z.array(ProfileSummaryWithOwnerSchema),
        effectiveDefaultId: z.uuid().nullable(),
      })
    )
    .query(async ({ ctx, input }) => {
      await ensureOrganizationAccess(ctx, input.organizationId);

      const [orgProfiles, personalProfiles] = await Promise.all([
        profileService.listProfiles({ type: 'organization', id: input.organizationId }),
        profileService.listProfiles({ type: 'user', id: ctx.user.id }),
      ]);

      // Effective default: org default takes precedence over personal default
      const effectiveDefault =
        orgProfiles.find(p => p.isDefault) ?? personalProfiles.find(p => p.isDefault);

      return {
        orgProfiles: orgProfiles.map(p => ({ ...p, ownerType: 'organization' as const })),
        personalProfiles: personalProfiles.map(p => ({ ...p, ownerType: 'user' as const })),
        effectiveDefaultId: effectiveDefault?.id ?? null,
      };
    }),

  /**
   * Get a single profile by ID.
   */
  get: baseProcedure
    .input(ProfileIdSchema.extend({ organizationId: z.uuid().optional() }))
    .output(ProfileResponseSchema)
    .query(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      return profileService.getProfile(input.profileId, owner);
    }),

  /**
   * Create a new profile.
   */
  create: baseProcedure
    .input(ProfileNameSchema.extend({ organizationId: z.uuid().optional() }))
    .output(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      return profileService.createProfile(owner, input.name, input.description);
    }),

  /**
   * Update profile metadata (name, description).
   */
  update: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileService.updateProfile(input.profileId, owner, {
        name: input.name,
        description: input.description,
      });
      return { success: true };
    }),

  /**
   * Delete a profile.
   * Returns an error if the profile is referenced by webhook triggers.
   */
  delete: baseProcedure
    .input(ProfileIdSchema.extend({ organizationId: z.uuid().optional() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      try {
        await profileService.deleteProfile(input.profileId, owner);
        return { success: true };
      } catch (error) {
        // Check for FK violation (profile referenced by webhook triggers)
        if (isForeignKeyViolation(error)) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              'Cannot delete profile: it is referenced by one or more webhook triggers. Remove the profile from those triggers first.',
          });
        }
        throw error;
      }
    }),

  /**
   * Set a profile as the default for the user/org.
   */
  setAsDefault: baseProcedure
    .input(ProfileIdSchema.extend({ organizationId: z.uuid().optional() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileService.setDefaultProfile(input.profileId, owner);
      return { success: true };
    }),

  /**
   * Clear the default status from a profile.
   */
  clearDefault: baseProcedure
    .input(ProfileIdSchema.extend({ organizationId: z.uuid().optional() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileService.clearDefaultProfile(input.profileId, owner);
      return { success: true };
    }),

  /**
   * Set or update an environment variable.
   * If isSecret is true, the value is encrypted before storage.
   */
  setVar: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
      }).merge(VarSchema)
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileVarsService.setVar(
        input.profileId,
        input.key,
        input.value,
        input.isSecret,
        owner
      );
      return { success: true };
    }),

  /**
   * Delete an environment variable.
   */
  deleteVar: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
        key: z.string().min(1).max(256),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileVarsService.deleteVar(input.profileId, input.key, owner);
      return { success: true };
    }),

  /**
   * Set commands for a profile (replaces all existing commands).
   */
  setCommands: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
      }).merge(CommandsSchema)
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileCommandsService.setCommands(input.profileId, input.commands, owner);
      return { success: true };
    }),
});
