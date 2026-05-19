import { createTRPCRouter, baseProcedure } from '@/lib/trpc/init';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import * as profileService from '@kilocode/cloud-agent-profile';
import * as profileVarsService from '@kilocode/cloud-agent-profile';
import * as profileCommandsService from '@kilocode/cloud-agent-profile';
import * as profileMcpService from '@kilocode/cloud-agent-profile';
import * as profileSkillsService from '@kilocode/cloud-agent-profile';
import * as profileAgentsService from '@kilocode/cloud-agent-profile';
import * as profileKiloCommandsService from '@kilocode/cloud-agent-profile';
import * as repoBindingService from '@kilocode/cloud-agent-profile';
import { AgentConfigSchema } from '@kilocode/db/schema-types';
import type { ProfileOwner } from '@kilocode/cloud-agent-profile';
import { db } from '@/lib/drizzle';
import { AGENT_ENV_VARS_PUBLIC_KEY } from '@/lib/config.server';

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
  mcpServerCount: z.number(),
  skillCount: z.number(),
  agentCount: z.number(),
  kiloCommandCount: z.number(),
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

const McpServerLocalConfigSchema = z.object({
  command: z.array(z.string()),
  environment: z.record(z.string(), z.string()).optional(),
});

const McpServerRemoteConfigSchema = z.object({
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
});

const ProfileMcpServerResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(['local', 'remote']),
  enabled: z.boolean(),
  timeout: z.number().nullable(),
  /** env/header values are always the masked placeholder on GET responses. */
  config: z.union([McpServerLocalConfigSchema, McpServerRemoteConfigSchema]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ProfileSkillResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  sourceType: z.enum(['marketplace', 'custom']),
  sourceUrl: z.string().nullable(),
  rawMarkdown: z.string(),
  files: z.record(z.string(), z.string()),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ProfileAgentResponseSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  config: AgentConfigSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ProfileKiloCommandResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  template: z.string(),
  agent: z.string().nullable(),
  model: z.string().nullable(),
  subtask: z.boolean(),
  enabled: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
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
  mcpServers: z.array(ProfileMcpServerResponseSchema),
  skills: z.array(ProfileSkillResponseSchema),
  agents: z.array(ProfileAgentResponseSchema),
  kiloCommands: z.array(ProfileKiloCommandResponseSchema),
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
 * The agent env vars public key, base64-encoded. Empty string when not
 * configured — the package helpers throw a clear error if encryption is
 * attempted in that case, matching the pre-refactor behavior.
 */
const publicKey = AGENT_ENV_VARS_PUBLIC_KEY ?? '';

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
      return profileService.listProfiles(db, owner);
    }),

  /**
   * List both org and personal profiles when in org context.
   * Returns profiles grouped by owner type with effective default resolution.
   * Personal default takes precedence over org default.
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
        profileService.listProfiles(db, { type: 'organization', id: input.organizationId }),
        profileService.listProfiles(db, { type: 'user', id: ctx.user.id }),
      ]);

      // Effective default: personal default takes precedence over org default
      const effectiveDefault =
        personalProfiles.find(p => p.isDefault) ?? orgProfiles.find(p => p.isDefault);

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
      return profileService.getProfile(db, input.profileId, owner);
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
      return profileService.createProfile(db, owner, ctx.user.id, input.name, input.description);
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
      await profileService.updateProfile(db, input.profileId, owner, {
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
        await profileService.deleteProfile(db, input.profileId, owner);
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
      await profileService.setDefaultProfile(db, input.profileId, owner);
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
      await profileService.clearDefaultProfile(db, input.profileId, owner);
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
        db,
        publicKey,
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
      await profileVarsService.deleteVar(db, input.profileId, input.key, owner);
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
      await profileCommandsService.setCommands(db, input.profileId, input.commands, owner);
      return { success: true };
    }),

  /**
   * Bind an environment profile to a repository.
   */
  bindToRepo: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
        profileId: z.uuid(),
        repoFullName: z.string().min(1).max(500),
        platform: z.enum(['github', 'gitlab']).default('github'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await repoBindingService.bindProfileToRepo(
        db,
        owner,
        input.repoFullName,
        input.platform,
        input.profileId
      );
    }),

  /**
   * Remove the profile binding for a repository.
   */
  unbindRepo: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
        repoFullName: z.string().min(1).max(500),
        platform: z.enum(['github', 'gitlab']).default('github'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await repoBindingService.unbindRepo(db, owner, input.repoFullName, input.platform);
    }),

  /**
   * List all repo-profile bindings for the current user or organization.
   */
  listRepoBindings: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      return repoBindingService.listBindings(db, owner);
    }),

  // ============ MCP SERVERS ============

  /**
   * Create an MCP server on a profile from a CLI-native input (local or remote).
   * Each env/header value is encrypted at-rest with the agent env vars public key
   * and stored inline in the server's config jsonb.
   */
  createMcp: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
        server: profileMcpService.mcpServerFullInputSchema,
      })
    )
    .output(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      return profileMcpService.createMcpServer(db, publicKey, input.profileId, input.server, owner);
    }),

  /**
   * Update an MCP server (replaces its config). Env/header values in the
   * input are plaintext; they are encrypted before write.
   */
  updateMcp: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
        mcpServerId: z.uuid(),
        server: profileMcpService.mcpServerFullInputSchema,
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileMcpService.updateMcpServer(
        db,
        publicKey,
        input.profileId,
        input.mcpServerId,
        input.server,
        owner
      );
      return { success: true };
    }),

  /**
   * Delete an MCP server.
   */
  deleteMcp: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
        mcpServerId: z.uuid(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileMcpService.deleteMcpServer(db, input.profileId, input.mcpServerId, owner);
      return { success: true };
    }),

  /**
   * Toggle an MCP server's enabled flag.
   */
  setMcpEnabled: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
        mcpServerId: z.uuid(),
        enabled: z.boolean(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileMcpService.setMcpEnabled(
        db,
        input.profileId,
        input.mcpServerId,
        input.enabled,
        owner
      );
      return { success: true };
    }),

  // ============ SKILLS ============

  /**
   * Create a custom skill by pasting SKILL.md directly (optionally with
   * companion files extracted from an uploaded archive by the client).
   */
  createCustomSkill: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
      }).merge(profileSkillsService.skillCustomInputSchema)
    )
    .output(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      return profileSkillsService.createCustomSkill(
        db,
        input.profileId,
        {
          name: input.name,
          description: input.description,
          rawMarkdown: input.rawMarkdown,
          files: input.files,
          enabled: input.enabled,
        },
        owner
      );
    }),

  /**
   * Update a skill's fields (name, description, rawMarkdown, files, enabled).
   */
  updateSkill: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
        skillId: z.uuid(),
      }).merge(profileSkillsService.skillUpdateInputSchema)
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileSkillsService.updateSkill(
        db,
        input.profileId,
        input.skillId,
        {
          name: input.name,
          description: input.description,
          rawMarkdown: input.rawMarkdown,
          files: input.files,
          enabled: input.enabled,
        },
        owner
      );
      return { success: true };
    }),

  /**
   * Delete a skill from a profile.
   */
  deleteSkill: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
        skillId: z.uuid(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileSkillsService.deleteSkill(db, input.profileId, input.skillId, owner);
      return { success: true };
    }),

  /**
   * Toggle a skill's enabled flag.
   */
  setSkillEnabled: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
        skillId: z.uuid(),
        enabled: z.boolean(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileSkillsService.setSkillEnabled(
        db,
        input.profileId,
        input.skillId,
        input.enabled,
        owner
      );
      return { success: true };
    }),

  // ============ AGENTS ============

  /**
   * Create an agent on a profile. The agent config is injected into
   * `KILO_CONFIG_CONTENT.agent.<slug>` at session preparation time.
   */
  createAgent: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
      }).merge(profileAgentsService.agentCreateInputSchema)
    )
    .output(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      return profileAgentsService.createAgent(
        db,
        input.profileId,
        {
          slug: input.slug,
          name: input.name,
          config: input.config,
        },
        owner
      );
    }),

  /**
   * Update an agent's fields (slug, name, config).
   */
  updateAgent: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
        agentId: z.uuid(),
      }).merge(profileAgentsService.agentUpdateInputSchema)
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileAgentsService.updateAgent(
        db,
        input.profileId,
        input.agentId,
        {
          slug: input.slug,
          name: input.name,
          config: input.config,
        },
        owner
      );
      return { success: true };
    }),

  /**
   * Delete an agent from a profile.
   */
  deleteAgent: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
        agentId: z.uuid(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileAgentsService.deleteAgent(db, input.profileId, input.agentId, owner);
      return { success: true };
    }),

  // ============ KILO COMMANDS ============

  createKiloCommand: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
      }).merge(profileKiloCommandsService.kiloCommandCreateInputSchema)
    )
    .output(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      return profileKiloCommandsService.createKiloCommand(
        db,
        input.profileId,
        {
          name: input.name,
          description: input.description,
          template: input.template,
          agent: input.agent,
          model: input.model,
          subtask: input.subtask,
        },
        owner
      );
    }),

  updateKiloCommand: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
        commandId: z.uuid(),
      }).merge(profileKiloCommandsService.kiloCommandUpdateInputSchema)
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileKiloCommandsService.updateKiloCommand(
        db,
        input.profileId,
        input.commandId,
        {
          name: input.name,
          description: input.description,
          template: input.template,
          agent: input.agent,
          model: input.model,
          subtask: input.subtask,
        },
        owner
      );
      return { success: true };
    }),

  deleteKiloCommand: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
        commandId: z.uuid(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileKiloCommandsService.deleteKiloCommand(
        db,
        input.profileId,
        input.commandId,
        owner
      );
      return { success: true };
    }),

  setKiloCommandEnabled: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
        commandId: z.uuid(),
        enabled: z.boolean(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileKiloCommandsService.setKiloCommandEnabled(
        db,
        input.profileId,
        input.commandId,
        input.enabled,
        owner
      );
      return { success: true };
    }),

  reorderKiloCommands: baseProcedure
    .input(
      ProfileIdSchema.extend({
        organizationId: z.uuid().optional(),
        orderedIds: z.array(z.uuid()),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = getOwner(input.organizationId, ctx.user.id);
      await profileKiloCommandsService.reorderKiloCommands(
        db,
        input.profileId,
        input.orderedIds,
        owner
      );
      return { success: true };
    }),
});
