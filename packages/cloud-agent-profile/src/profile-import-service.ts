import type { WorkerDb } from '@kilocode/db';
import {
  agent_environment_profiles,
  agent_environment_profile_agents,
  agent_environment_profile_skills,
  agent_environment_profile_kilo_commands,
  agent_environment_profile_instructions,
} from '@kilocode/db/schema';
import { AgentConfigSchema } from '@kilocode/db/schema-types';
import { eq, max, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { MAX_PROFILE_AGENTS } from './contracts/agents';
import { MAX_PROFILE_KILO_COMMANDS } from './contracts/kilo-commands';
import { MAX_PROFILE_SKILLS } from './contracts/skills';
import { MAX_IMPORT_INSTRUCTIONS } from './import/instructions';
import { importItemId } from './import/selection';
import { listAgentsForProfile } from './profile-agents-service';
import { listSkillsForProfile } from './profile-skills-service';
import { listKiloCommandsForProfile } from './profile-kilo-commands-service';
import { listInstructionsForProfile } from './profile-instructions-service';
import { verifyProfileOwnership } from './profile-utils';
import type {
  ProfileAgentResponse,
  ProfileInstructionResponse,
  ProfileKiloCommandResponse,
  ProfileOwner,
  ProfileSkillResponse,
} from './types';
import type {
  ImportCategory,
  ImportedAgent,
  ImportedInstruction,
  ImportedKiloCommand,
  ImportedSkill,
  ImportIssue,
  ImportPreview,
  ParsedLocalConfig,
} from './import/types';

/**
 * Canonical post-import shapes. Apply writes exactly these values and preview
 * compares them against the stored rows normalized the same way, so the
 * defaults apply injects (activation, custom skill source) are visible in the
 * diff instead of being silently overwritten. Command order is not part of the
 * shape: apply keeps an existing command's position and appends new ones.
 */
export type PostImportAgent = ImportedAgent;

export type PostImportKiloCommand = {
  name: string;
  description: string | null;
  template: string;
  agent: string | null;
  model: string | null;
  subtask: boolean;
  enabled: boolean;
};

export type PostImportSkill = {
  name: string;
  description: string | null;
  rawMarkdown: string;
  files: Record<string, string>;
  enabled: boolean;
  sourceType: 'marketplace' | 'custom';
  sourceUrl: string | null;
};

export type PostImportInstruction = {
  name: string;
  content: string;
  enabled: boolean;
};

/** One field-level difference between the stored item and the imported item. */
export type ImportFieldChange = {
  /** Dotted path inside the item, for example `config.prompt` or `model`. */
  field: string;
  before: unknown;
  after: unknown;
};

/** Items that already exist on the profile, keyed by slug/name. */
export type ImportChangedItem<T> = {
  id: string;
  before: T;
  after: T;
  changes: ImportFieldChange[];
};

/**
 * Importable definitions that would change the profile. Definitions identical
 * to the stored row are omitted, and cloud-only rows are not listed because
 * import never deletes them.
 */
export type ImportCategoryPreview<T> = {
  added: Array<{ id: string; item: T }>;
  changed: ImportChangedItem<T>[];
};

/**
 * Advisory diff of one parsed archive against the profile's current contents.
 * Comparison uses the post-import contract on both sides, so `before` is the
 * stored item normalized to the same shape apply will write.
 */
export type ConfigImportPreview = {
  agents: ImportCategoryPreview<PostImportAgent>;
  commands: ImportCategoryPreview<PostImportKiloCommand>;
  skills: ImportCategoryPreview<PostImportSkill>;
  instructions: ImportCategoryPreview<PostImportInstruction>;
  issues: ImportIssue[];
};

type ImportTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];

const PROFILE_CAPS: Record<ImportCategory, number> = {
  agents: MAX_PROFILE_AGENTS,
  commands: MAX_PROFILE_KILO_COMMANDS,
  skills: MAX_PROFILE_SKILLS,
  instructions: MAX_IMPORT_INSTRUCTIONS,
};

/** Queries run in sequence: one transaction owns one connection. */
async function readStoredIdentities(
  tx: ImportTransaction,
  profileId: string
): Promise<Record<ImportCategory, string[]>> {
  const agents = await tx
    .select({ id: agent_environment_profile_agents.slug })
    .from(agent_environment_profile_agents)
    .where(eq(agent_environment_profile_agents.profile_id, profileId));
  const commands = await tx
    .select({ id: agent_environment_profile_kilo_commands.name })
    .from(agent_environment_profile_kilo_commands)
    .where(eq(agent_environment_profile_kilo_commands.profile_id, profileId));
  const skills = await tx
    .select({ id: agent_environment_profile_skills.name })
    .from(agent_environment_profile_skills)
    .where(eq(agent_environment_profile_skills.profile_id, profileId));
  const instructions = await tx
    .select({ id: agent_environment_profile_instructions.name })
    .from(agent_environment_profile_instructions)
    .where(eq(agent_environment_profile_instructions.profile_id, profileId));
  const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id);
  return {
    agents: ids(agents),
    commands: ids(commands),
    skills: ids(skills),
    instructions: ids(instructions),
  };
}

/** Caps apply to the profile after import: stored rows plus the new identities. */
async function assertWithinCaps(
  tx: ImportTransaction,
  profileId: string,
  parsed: ParsedLocalConfig
): Promise<void> {
  const stored = await readStoredIdentities(tx, profileId);
  for (const category of Object.keys(PROFILE_CAPS) as ImportCategory[]) {
    const total = new Set([...stored[category], ...parsed[category].map(importItemId)]).size;
    const limit = PROFILE_CAPS[category];
    if (total > limit) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Import would leave ${total} ${category} on this profile, over the ${limit} ${category} limit; select fewer ${category}`,
      });
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    return aKeys.every(
      key => Object.prototype.hasOwnProperty.call(b, key) && valuesEqual(a[key], b[key])
    );
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => valuesEqual(value, b[index]));
  }
  return false;
}

function collectFieldChanges(
  before: unknown,
  after: unknown,
  path: string,
  changes: ImportFieldChange[]
): void {
  if (valuesEqual(before, after)) return;
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      collectFieldChanges(before[key], after[key], path ? `${path}.${key}` : key, changes);
    }
    return;
  }
  changes.push({ field: path, before: before ?? null, after: after ?? null });
}

function buildCategoryPreview<TCurrent, TImported, TCanonical>(
  current: TCurrent[],
  imported: TImported[],
  identity: (item: TCurrent | TImported) => string,
  normalizeCurrent: (item: TCurrent) => TCanonical,
  normalizeImported: (item: TImported) => TCanonical
): ImportCategoryPreview<TCanonical> {
  const currentById = new Map(current.map(item => [identity(item), item]));
  const added: Array<{ id: string; item: TCanonical }> = [];
  const changed: ImportChangedItem<TCanonical>[] = [];

  for (const importedItem of imported) {
    const id = identity(importedItem);
    const after = normalizeImported(importedItem);
    const currentItem = currentById.get(id);
    if (currentItem === undefined) {
      added.push({ id, item: after });
      continue;
    }
    const before = normalizeCurrent(currentItem);
    const changes: ImportFieldChange[] = [];
    collectFieldChanges(before, after, '', changes);
    if (changes.length > 0) changed.push({ id, before, after, changes });
  }

  return { added, changed };
}

function importedAgentToPostImport(agent: ImportedAgent): PostImportAgent {
  return agent;
}

function storedAgentToPostImport(agent: ProfileAgentResponse): PostImportAgent {
  return { slug: agent.slug, name: agent.name, config: AgentConfigSchema.parse(agent.config) };
}

function importedCommandToPostImport(command: ImportedKiloCommand): PostImportKiloCommand {
  return {
    name: command.name,
    description: command.description ?? null,
    template: command.template,
    agent: command.agent ?? null,
    model: command.model ?? null,
    subtask: command.subtask ?? false,
    enabled: true,
  };
}

function storedCommandToPostImport(command: ProfileKiloCommandResponse): PostImportKiloCommand {
  return {
    name: command.name,
    description: command.description ?? null,
    template: command.template,
    agent: command.agent ?? null,
    model: command.model ?? null,
    subtask: command.subtask,
    enabled: command.enabled,
  };
}

function importedSkillToPostImport(skill: ImportedSkill): PostImportSkill {
  return {
    name: skill.name,
    description: skill.description ?? null,
    rawMarkdown: skill.rawMarkdown,
    files: skill.files ?? {},
    enabled: true,
    sourceType: 'custom',
    sourceUrl: null,
  };
}

function storedSkillToPostImport(skill: ProfileSkillResponse): PostImportSkill {
  return {
    name: skill.name,
    description: skill.description ?? null,
    rawMarkdown: skill.rawMarkdown,
    files: skill.files ?? {},
    enabled: skill.enabled,
    sourceType: skill.sourceType,
    sourceUrl: skill.sourceUrl,
  };
}

function importedInstructionToPostImport(instruction: ImportedInstruction): PostImportInstruction {
  return { name: instruction.name, content: instruction.content, enabled: true };
}

function storedInstructionToPostImport(
  instruction: ProfileInstructionResponse
): PostImportInstruction {
  return {
    name: instruction.name,
    content: instruction.content,
    enabled: instruction.enabled,
  };
}

/**
 * Diff one parsed archive against the profile's current contents. Writes
 * nothing; apply re-parses the archive and imports the selected definitions.
 */
export async function buildImportPreview(
  db: WorkerDb,
  profileId: string,
  preview: ImportPreview,
  owner: ProfileOwner
): Promise<ConfigImportPreview> {
  await verifyProfileOwnership(db, profileId, owner);

  const [agents, commands, skills, instructions] = await Promise.all([
    listAgentsForProfile(db, profileId),
    listKiloCommandsForProfile(db, profileId),
    listSkillsForProfile(db, profileId),
    listInstructionsForProfile(db, profileId),
  ]);

  return {
    agents: buildCategoryPreview(
      agents,
      preview.config.agents,
      item => item.slug,
      storedAgentToPostImport,
      importedAgentToPostImport
    ),
    commands: buildCategoryPreview(
      commands,
      preview.config.commands,
      item => item.name,
      storedCommandToPostImport,
      importedCommandToPostImport
    ),
    skills: buildCategoryPreview(
      skills,
      preview.config.skills,
      item => item.name,
      storedSkillToPostImport,
      importedSkillToPostImport
    ),
    instructions: buildCategoryPreview(
      instructions,
      preview.config.instructions,
      item => item.name,
      storedInstructionToPostImport,
      importedInstructionToPostImport
    ),
    issues: preview.issues,
  };
}

async function upsertAgents(
  tx: ImportTransaction,
  profileId: string,
  agents: PostImportAgent[]
): Promise<void> {
  if (agents.length === 0) return;
  await tx
    .insert(agent_environment_profile_agents)
    .values(
      agents.map(agent => ({
        profile_id: profileId,
        slug: agent.slug,
        name: agent.name,
        config: agent.config,
      }))
    )
    .onConflictDoUpdate({
      target: [agent_environment_profile_agents.profile_id, agent_environment_profile_agents.slug],
      set: {
        name: sql`excluded.name`,
        config: sql`excluded.config`,
        updated_at: sql`now()`,
      },
    });
}

/** New commands are appended in archive order; existing commands keep their position. */
async function upsertCommands(
  tx: ImportTransaction,
  profileId: string,
  commands: PostImportKiloCommand[]
): Promise<void> {
  if (commands.length === 0) return;
  const [{ lastSortOrder }] = await tx
    .select({ lastSortOrder: max(agent_environment_profile_kilo_commands.sort_order) })
    .from(agent_environment_profile_kilo_commands)
    .where(eq(agent_environment_profile_kilo_commands.profile_id, profileId));
  const firstSortOrder = (lastSortOrder ?? -1) + 1;
  await tx
    .insert(agent_environment_profile_kilo_commands)
    .values(
      commands.map((command, index) => ({
        profile_id: profileId,
        name: command.name,
        description: command.description,
        template: command.template,
        agent: command.agent,
        model: command.model,
        subtask: command.subtask,
        enabled: command.enabled,
        sort_order: firstSortOrder + index,
      }))
    )
    .onConflictDoUpdate({
      target: [
        agent_environment_profile_kilo_commands.profile_id,
        agent_environment_profile_kilo_commands.name,
      ],
      set: {
        description: sql`excluded.description`,
        template: sql`excluded.template`,
        agent: sql`excluded.agent`,
        model: sql`excluded.model`,
        subtask: sql`excluded.subtask`,
        enabled: sql`excluded.enabled`,
        updated_at: sql`now()`,
      },
    });
}

async function upsertSkills(
  tx: ImportTransaction,
  profileId: string,
  skills: PostImportSkill[]
): Promise<void> {
  if (skills.length === 0) return;
  await tx
    .insert(agent_environment_profile_skills)
    .values(
      skills.map(skill => ({
        profile_id: profileId,
        name: skill.name,
        description: skill.description,
        source_type: skill.sourceType,
        source_url: skill.sourceUrl,
        raw_markdown: skill.rawMarkdown,
        files: skill.files,
        enabled: skill.enabled,
      }))
    )
    .onConflictDoUpdate({
      target: [agent_environment_profile_skills.profile_id, agent_environment_profile_skills.name],
      set: {
        description: sql`excluded.description`,
        source_type: sql`excluded.source_type`,
        source_url: sql`excluded.source_url`,
        raw_markdown: sql`excluded.raw_markdown`,
        files: sql`excluded.files`,
        enabled: sql`excluded.enabled`,
        updated_at: sql`now()`,
      },
    });
}

async function upsertInstructions(
  tx: ImportTransaction,
  profileId: string,
  instructions: PostImportInstruction[]
): Promise<void> {
  if (instructions.length === 0) return;
  await tx
    .insert(agent_environment_profile_instructions)
    .values(
      instructions.map(instruction => ({
        profile_id: profileId,
        name: instruction.name,
        content: instruction.content,
        enabled: instruction.enabled,
      }))
    )
    .onConflictDoUpdate({
      target: [
        agent_environment_profile_instructions.profile_id,
        agent_environment_profile_instructions.name,
      ],
      set: {
        content: sql`excluded.content`,
        enabled: sql`excluded.enabled`,
        updated_at: sql`now()`,
      },
    });
}

/**
 * Upsert the selected definitions in one transaction. Present definitions are
 * updated in place (so they keep their row ids), definitions not in `parsed`
 * are left untouched, and vars, setup commands, and MCP servers are not
 * changed. The parent profile row is locked first so concurrent imports on one
 * profile serialize and cannot each pass the cap check and together exceed it.
 */
export async function applyImport(
  db: WorkerDb,
  profileId: string,
  parsed: ParsedLocalConfig,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);

  const commands = parsed.commands.map(importedCommandToPostImport);
  const skills = parsed.skills.map(importedSkillToPostImport);
  const instructions = parsed.instructions.map(importedInstructionToPostImport);

  await db.transaction(async tx => {
    await tx
      .select({ id: agent_environment_profiles.id })
      .from(agent_environment_profiles)
      .where(eq(agent_environment_profiles.id, profileId))
      .for('update')
      .limit(1);

    await assertWithinCaps(tx, profileId, parsed);

    await upsertAgents(tx, profileId, parsed.agents);
    await upsertCommands(tx, profileId, commands);
    await upsertSkills(tx, profileId, skills);
    await upsertInstructions(tx, profileId, instructions);
  });
}
