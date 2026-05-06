import * as z from 'zod';
import type { WorkerDb } from '@kilocode/db';
import { agent_environment_profiles } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import type { EncryptedEnvelope } from '@kilocode/encryption';
import { getEffectiveDefaultProfileId, getDefaultProfile } from './profile-service';
import { getBindingForRepo } from './repo-binding-service';
import { getVarsForSession } from './profile-vars-service';
import { getCommandsForSession } from './profile-commands-service';
import { getMcpServersForSession, type McpServerForSession } from './profile-mcp-service';
import { getSkillsForSession, type SkillForSession } from './profile-skills-service';
import { getAgentsForSession, type AgentForSession } from './profile-agents-service';
import { resolveProfileLayers } from './profile-resolution';
import { buildOwnershipCondition } from './profile-utils';
import type { ProfileOwner } from './types';

// Schema to validate encrypted envelope structure from database
const encryptedEnvelopeSchema = z.object({
  encryptedData: z.string(),
  encryptedDEK: z.string(),
  algorithm: z.literal('rsa-aes-256-gcm'),
  version: z.literal(1),
});

export class ProfileNotFoundError extends Error {
  constructor(public profileId: string) {
    super(`Profile '${profileId}' not found`);
    this.name = 'ProfileNotFoundError';
  }
}

export type MergedSkillForSession = {
  name: string;
  rawMarkdown: string;
  files: Record<string, string>;
};

export type MergedAgentForSession = AgentForSession;

export type MergeProfileConfigurationArgs = {
  /** Unambiguous profile identifier selected by the caller. */
  profileId?: string;
  owner: ProfileOwner;
  /** When in org context, enables selecting a personal profile and using effective default. */
  userId?: string;
  repoFullName?: string;
  platform?: 'github' | 'gitlab';
  envVars?: Record<string, string>;
  setupCommands?: string[];
};

export type MergeProfileConfigurationResult = {
  envVars?: Record<string, string>;
  setupCommands?: string[];
  encryptedSecrets?: Record<string, EncryptedEnvelope>;
  mcpServers?: McpServerForSession[];
  skills?: MergedSkillForSession[];
  agents?: MergedAgentForSession[];
};

/** Ensure a profileId belongs to the given owner (or, for org context, to the user personally). */
async function verifyProfileIdAccessible(
  db: WorkerDb,
  profileId: string,
  owner: ProfileOwner,
  userId?: string
): Promise<void> {
  // Check direct ownership.
  const [asOwner] = await db
    .select({ id: agent_environment_profiles.id })
    .from(agent_environment_profiles)
    .where(and(eq(agent_environment_profiles.id, profileId), buildOwnershipCondition(owner)))
    .limit(1);
  if (asOwner) return;

  // In org context, a user may also select their personal profile.
  if (owner.type === 'organization' && userId) {
    const [asPersonal] = await db
      .select({ id: agent_environment_profiles.id })
      .from(agent_environment_profiles)
      .where(
        and(
          eq(agent_environment_profiles.id, profileId),
          buildOwnershipCondition({ type: 'user', id: userId })
        )
      )
      .limit(1);
    if (asPersonal) return;
  }

  throw new ProfileNotFoundError(profileId);
}

export async function mergeProfileConfiguration(
  db: WorkerDb,
  {
    profileId,
    owner,
    userId,
    repoFullName,
    platform,
    envVars = {},
    setupCommands = [],
  }: MergeProfileConfigurationArgs
): Promise<MergeProfileConfigurationResult> {
  let mergedEnvVars = { ...envVars };
  let mergedSetupCommands = [...setupCommands];
  let encryptedSecrets: Record<string, EncryptedEnvelope> | undefined;

  // Look up the inputs to resolution.
  const repoBindingProfileId =
    repoFullName && platform ? await getBindingForRepo(db, owner, repoFullName, platform) : null;

  let explicitOverrideProfileId: string | null = null;
  if (profileId) {
    await verifyProfileIdAccessible(db, profileId, owner, userId);
    explicitOverrideProfileId = profileId;
  }

  // Default is a fallback — only fetch it when there's nothing else to apply.
  const effectiveDefaultProfileId =
    !repoBindingProfileId && !explicitOverrideProfileId
      ? owner.type === 'organization' && userId
        ? await getEffectiveDefaultProfileId(db, userId, owner.id)
        : ((await getDefaultProfile(db, owner))?.id ?? null)
      : null;

  const { automatic, explicit } = resolveProfileLayers({
    repoBindingProfileId,
    effectiveDefaultProfileId,
    explicitOverrideProfileId,
  });

  // Load profile data for the resolved layers in parallel.
  const profilesToLoad: string[] = [];
  if (automatic) profilesToLoad.push(automatic.profileId);
  if (explicit) profilesToLoad.push(explicit);

  const profileData = await Promise.all(
    profilesToLoad.map(async id => {
      const [vars, commands, mcpServers, skills, agents] = await Promise.all([
        getVarsForSession(db, id),
        getCommandsForSession(db, id),
        getMcpServersForSession(db, id),
        getSkillsForSession(db, id),
        getAgentsForSession(db, id),
      ]);
      return { profileId: id, vars, commands, mcpServers, skills, agents };
    })
  );

  const automaticData = automatic
    ? profileData.find(d => d.profileId === automatic.profileId)
    : null;
  const overrideData = explicit ? profileData.find(d => d.profileId === explicit) : null;

  // Process the automatic (base) layer.
  const baseEnvVars: Record<string, string> = {};
  const baseSecrets: Record<string, EncryptedEnvelope> = {};
  const baseCommands: string[] = [];
  const baseMcpServers: McpServerForSession[] = automaticData?.mcpServers ?? [];
  const baseSkills: SkillForSession[] = automaticData?.skills ?? [];
  const baseAgents: AgentForSession[] = automaticData?.agents ?? [];

  if (automaticData) {
    for (const variable of automaticData.vars) {
      if (variable.isSecret) {
        const parsed = encryptedEnvelopeSchema.parse(JSON.parse(variable.value));
        baseSecrets[variable.key] = parsed;
      } else {
        baseEnvVars[variable.key] = variable.value;
      }
    }
    baseCommands.push(...automaticData.commands);
  }

  // Process override profile
  const overrideEnvVars: Record<string, string> = {};
  const overrideSecrets: Record<string, EncryptedEnvelope> = {};
  const overrideCommands: string[] = [];
  const overrideMcpServers: McpServerForSession[] = overrideData?.mcpServers ?? [];
  const overrideSkills: SkillForSession[] = overrideData?.skills ?? [];
  const overrideAgents: AgentForSession[] = overrideData?.agents ?? [];

  if (overrideData) {
    for (const variable of overrideData.vars) {
      if (variable.isSecret) {
        const parsed = encryptedEnvelopeSchema.parse(JSON.parse(variable.value));
        overrideSecrets[variable.key] = parsed;
      } else {
        overrideEnvVars[variable.key] = variable.value;
      }
    }
    overrideCommands.push(...overrideData.commands);
  }

  // Merge env vars: base < override < manual
  mergedEnvVars = { ...baseEnvVars, ...overrideEnvVars, ...envVars };
  // Merge commands: base, then override, then manual
  mergedSetupCommands = [...baseCommands, ...overrideCommands, ...setupCommands];
  // Merge secrets: base < override (override wins on key collision)
  const allSecrets = { ...baseSecrets, ...overrideSecrets };
  if (Object.keys(allSecrets).length > 0) {
    encryptedSecrets = allSecrets;
  }

  // MCP servers: merge by name across profile layers only (later wins).
  // Skips disabled servers entirely.
  const mcpByName = new Map<string, McpServerForSession>();
  for (const server of [...baseMcpServers, ...overrideMcpServers]) {
    if (!server.enabled) continue;
    mcpByName.set(server.name, server);
  }
  const mcpServers = mcpByName.size > 0 ? Array.from(mcpByName.values()) : undefined;

  // Skills: merge by name across profile layers only (later wins).
  // Disabled skills are already filtered out in getSkillsForSession.
  const skillByName = new Map<string, MergedSkillForSession>();
  for (const skill of [...baseSkills, ...overrideSkills]) {
    skillByName.set(skill.name, {
      name: skill.name,
      rawMarkdown: skill.rawMarkdown,
      files: skill.files,
    });
  }
  const skills = skillByName.size > 0 ? Array.from(skillByName.values()) : undefined;

  // Agents: merge by slug across profile layers only (later wins).
  // Disabled agents are already filtered out in getAgentsForSession.
  const agentBySlug = new Map<string, MergedAgentForSession>();
  for (const agent of [...baseAgents, ...overrideAgents]) {
    agentBySlug.set(agent.slug, agent);
  }
  const agents = agentBySlug.size > 0 ? Array.from(agentBySlug.values()) : undefined;

  return {
    envVars: Object.keys(mergedEnvVars).length > 0 ? mergedEnvVars : undefined,
    setupCommands: mergedSetupCommands.length > 0 ? mergedSetupCommands : undefined,
    encryptedSecrets,
    mcpServers,
    skills,
    agents,
  };
}

/**
 * Shape the cloud-agent-next client accepts for each MCP server in the
 * `mcpServers` record. Env/header values travel as encrypted envelopes;
 * the worker decrypts them per-value just before writing KILO_CONFIG_CONTENT.
 */
export type ClientMcpServerValue =
  | {
      type: 'local';
      command: string[];
      environment?: Record<string, EncryptedEnvelope>;
      enabled?: boolean;
      timeout?: number;
    }
  | {
      type: 'remote';
      url: string;
      headers?: Record<string, EncryptedEnvelope>;
      enabled?: boolean;
      timeout?: number;
    };

/**
 * Convert the merged profile MCP servers into the Record<name, value>
 * shape accepted by the cloud-agent-next client.
 */
export function profileMcpServersToClientRecord(
  servers: McpServerForSession[] | undefined
): Record<string, ClientMcpServerValue> | undefined {
  if (!servers || servers.length === 0) return undefined;
  const out: Record<string, ClientMcpServerValue> = {};
  for (const server of servers) {
    if (server.type === 'local') {
      out[server.name] = {
        type: 'local',
        command: server.command ?? [],
        environment: server.environment,
        enabled: server.enabled,
        timeout: server.timeout,
      };
    } else {
      out[server.name] = {
        type: 'remote',
        url: server.url ?? '',
        headers: server.headers,
        enabled: server.enabled,
        timeout: server.timeout,
      };
    }
  }
  return out;
}
