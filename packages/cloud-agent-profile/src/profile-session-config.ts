import * as z from 'zod';
import type { WorkerDb } from '@kilocode/db';
import { agent_environment_profiles } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import type { EncryptedEnvelope } from '@kilocode/encryption';
import type { AgentConfig } from '@kilocode/db/schema-types';
import { getEffectiveDefaultProfileId, getDefaultProfile } from './profile-service';
import { getBindingForRepo } from './repo-binding-service';
import { getVarsForSession } from './profile-vars-service';
import { getCommandsForSession } from './profile-commands-service';
import {
  getMcpServersForSession,
  type McpServerForSession,
  type StoredMcpSecretValue,
} from './profile-mcp-service';
import { getSkillsForSession, type SkillForSession } from './profile-skills-service';
import { getAgentsForSession, type AgentForSession } from './profile-agents-service';
import {
  getKiloCommandsForSession,
  type KiloCommandForSession,
} from './profile-kilo-commands-service';
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

export type MergedKiloCommandForSession = KiloCommandForSession;

/**
 * Permissive shape for an inline runtime skill supplied by the caller. The
 * cloud-agent-next service validates a stricter shape at its API boundary;
 * this type stays loose so the package does not depend on service-side
 * schemas.
 */
export type InlineSkillInput = {
  name: string;
  rawMarkdown: string;
  files?: Record<string, string>;
};

/**
 * Permissive shape for an inline runtime agent. `config` aliases the
 * authoritative `AgentConfig` from the db package — runtime configs that
 * round-trip through cloud-agent-next are structurally compatible.
 */
export type InlineAgentInput = {
  slug: string;
  name: string;
  config: AgentConfig;
};

export type MergeProfileConfigurationArgs = {
  /** Unambiguous profile identifier selected by the caller. */
  profileId?: string;
  owner: ProfileOwner;
  /** When in org context, enables selecting a personal profile and using effective default. */
  userId?: string;
  repoFullName?: string;
  platform?: 'github' | 'gitlab';
  /**
   * Inline values supplied alongside the profile stack. They form a single
   * implicit "inline layer" applied on top of the resolved profile layers,
   * so each collection follows the same precedence: repo-binding base <
   * effective default / explicit override (top) < inline.
   */
  envVars?: Record<string, string>;
  setupCommands?: string[];
  encryptedSecrets?: Record<string, EncryptedEnvelope>;
  mcpServers?: Record<string, ClientMcpServerValue>;
  runtimeSkills?: InlineSkillInput[];
  runtimeAgents?: InlineAgentInput[];
};

export type MergeProfileConfigurationResult = {
  envVars?: Record<string, string>;
  setupCommands?: string[];
  encryptedSecrets?: Record<string, EncryptedEnvelope>;
  mcpServers?: McpServerForSession[];
  skills?: MergedSkillForSession[];
  agents?: MergedAgentForSession[];
  kiloCommands?: KiloCommandForSession[];
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

/**
 * Normalized per-source contribution. Profile rows and inline args are both
 * shaped into this so the merge becomes a single reduce.
 */
type Layer = {
  envVars: Record<string, string>;
  secrets: Record<string, EncryptedEnvelope>;
  commands: string[];
  mcpServers: McpServerForSession[];
  skills: SkillForSession[];
  agents: AgentForSession[];
  kiloCommands: KiloCommandForSession[];
};

type ProfileLayerData = {
  vars: Awaited<ReturnType<typeof getVarsForSession>>;
  commands: string[];
  mcpServers: McpServerForSession[];
  skills: SkillForSession[];
  agents: AgentForSession[];
  kiloCommands: KiloCommandForSession[];
};

function profileToLayer(data: ProfileLayerData): Layer {
  const envVars: Record<string, string> = {};
  const secrets: Record<string, EncryptedEnvelope> = {};
  for (const variable of data.vars) {
    if (variable.isSecret) {
      secrets[variable.key] = encryptedEnvelopeSchema.parse(JSON.parse(variable.value));
    } else {
      envVars[variable.key] = variable.value;
    }
  }
  return {
    envVars,
    secrets,
    commands: [...data.commands],
    mcpServers: [...data.mcpServers],
    skills: [...data.skills],
    agents: [...data.agents],
    kiloCommands: [...data.kiloCommands],
  };
}

function clientRecordToMcpServers(
  record: Record<string, ClientMcpServerValue>
): McpServerForSession[] {
  return Object.entries(record).map(([name, server]) => {
    if (server.type === 'local') {
      return {
        name,
        type: 'local',
        enabled: server.enabled ?? true,
        timeout: server.timeout,
        command: server.command,
        environment: server.environment,
      };
    }
    return {
      name,
      type: 'remote',
      enabled: server.enabled ?? true,
      timeout: server.timeout,
      url: server.url,
      headers: server.headers,
    };
  });
}

function inlineToLayer(args: MergeProfileConfigurationArgs): Layer | null {
  const { envVars, encryptedSecrets, setupCommands, mcpServers, runtimeSkills, runtimeAgents } =
    args;
  const hasInline =
    !!envVars ||
    !!encryptedSecrets ||
    (setupCommands?.length ?? 0) > 0 ||
    !!mcpServers ||
    (runtimeSkills?.length ?? 0) > 0 ||
    (runtimeAgents?.length ?? 0) > 0;
  if (!hasInline) return null;

  return {
    envVars: { ...(envVars ?? {}) },
    secrets: { ...(encryptedSecrets ?? {}) },
    commands: setupCommands ? [...setupCommands] : [],
    mcpServers: mcpServers ? clientRecordToMcpServers(mcpServers) : [],
    skills: (runtimeSkills ?? []).map(s => ({
      name: s.name,
      rawMarkdown: s.rawMarkdown,
      files: s.files ?? {},
    })),
    agents: runtimeAgents ? [...runtimeAgents] : [],
    // Inline kilo commands are not supported — there is no `runtimeKiloCommands`
    // argument. Commands from resolved profiles flow through the DB query path
    // above (profileToLayer). Unresolved pass-through handles commands supplied
    // directly by the caller without merging.
    kiloCommands: [],
  };
}

/**
 * Reduce layers into a single result. Precedence: later layer wins per key.
 *
 * Disabled MCP servers (`enabled === false`) are skipped — they neither
 * contribute nor shadow an enabled entry of the same name in an earlier
 * layer. This matches the per-profile behavior so the inline layer behaves
 * symmetrically.
 */
function mergeLayers(layers: Layer[]): MergeProfileConfigurationResult {
  const envVars: Record<string, string> = {};
  const secrets: Record<string, EncryptedEnvelope> = {};
  const commands: string[] = [];
  const mcpByName = new Map<string, McpServerForSession>();
  const skillByName = new Map<string, MergedSkillForSession>();
  const agentBySlug = new Map<string, MergedAgentForSession>();
  const commandByName = new Map<string, KiloCommandForSession>();

  for (const layer of layers) {
    Object.assign(envVars, layer.envVars);
    Object.assign(secrets, layer.secrets);
    commands.push(...layer.commands);
    for (const server of layer.mcpServers) {
      if (!server.enabled) continue;
      mcpByName.set(server.name, server);
    }
    for (const skill of layer.skills) {
      skillByName.set(skill.name, {
        name: skill.name,
        rawMarkdown: skill.rawMarkdown,
        files: skill.files,
      });
    }
    for (const agent of layer.agents) {
      agentBySlug.set(agent.slug, agent);
    }
    for (const cmd of layer.kiloCommands) {
      commandByName.set(cmd.name, cmd);
    }
  }

  return {
    envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
    setupCommands: commands.length > 0 ? commands : undefined,
    encryptedSecrets: Object.keys(secrets).length > 0 ? secrets : undefined,
    mcpServers: mcpByName.size > 0 ? Array.from(mcpByName.values()) : undefined,
    skills: skillByName.size > 0 ? Array.from(skillByName.values()) : undefined,
    agents: agentBySlug.size > 0 ? Array.from(agentBySlug.values()) : undefined,
    kiloCommands: commandByName.size > 0 ? Array.from(commandByName.values()) : undefined,
  };
}

export async function mergeProfileConfiguration(
  db: WorkerDb,
  args: MergeProfileConfigurationArgs
): Promise<MergeProfileConfigurationResult> {
  const { profileId, owner, userId, repoFullName, platform } = args;

  // Look up the inputs to resolution.
  const repoBindingProfileId =
    repoFullName && platform ? await getBindingForRepo(db, owner, repoFullName, platform) : null;

  let explicitOverrideProfileId: string | null = null;
  if (profileId) {
    await verifyProfileIdAccessible(db, profileId, owner, userId);
    explicitOverrideProfileId = profileId;
  }

  // Default fills the top slot when no explicit pick is made — even if a
  // repo binding is also present, in which case the default layers on top.
  const effectiveDefaultProfileId = explicitOverrideProfileId
    ? null
    : owner.type === 'organization' && userId
      ? await getEffectiveDefaultProfileId(db, userId, owner.id)
      : ((await getDefaultProfile(db, owner))?.id ?? null);

  const { base, top } = resolveProfileLayers({
    repoBindingProfileId,
    effectiveDefaultProfileId,
    explicitOverrideProfileId,
  });

  // Load profile data for the resolved layers in parallel.
  const profilesToLoad: string[] = [];
  if (base) profilesToLoad.push(base.profileId);
  if (top) profilesToLoad.push(top.profileId);

  const profileData = await Promise.all(
    profilesToLoad.map(async id => {
      const [vars, commands, mcpServers, skills, agents, kiloCommands] = await Promise.all([
        getVarsForSession(db, id),
        getCommandsForSession(db, id),
        getMcpServersForSession(db, id),
        getSkillsForSession(db, id),
        getAgentsForSession(db, id),
        getKiloCommandsForSession(db, id),
      ]);
      return { profileId: id, vars, commands, mcpServers, skills, agents, kiloCommands };
    })
  );

  // Stack layers in precedence order: repo-binding base < explicit/default
  // top < inline. The inline layer is built from the args and treated as
  // just one more profile so the merge logic does not branch on its source.
  const layers: Layer[] = [];
  const baseData = base ? profileData.find(d => d.profileId === base.profileId) : null;
  const topData = top ? profileData.find(d => d.profileId === top.profileId) : null;
  if (baseData) layers.push(profileToLayer(baseData));
  if (topData) layers.push(profileToLayer(topData));
  const inline = inlineToLayer(args);
  if (inline) layers.push(inline);

  return mergeLayers(layers);
}

/**
 * Shape the cloud-agent-next client accepts for each MCP server in the
 * `mcpServers` record. Each env/header value is either a plain string or an
 * encrypted envelope; the worker decrypts envelope-shaped entries per key
 * just before writing KILO_CONFIG_CONTENT.
 */
export type ClientMcpServerValue =
  | {
      type: 'local';
      command: string[];
      environment?: Record<string, StoredMcpSecretValue>;
      enabled?: boolean;
      timeout?: number;
    }
  | {
      type: 'remote';
      url: string;
      headers?: Record<string, StoredMcpSecretValue>;
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
