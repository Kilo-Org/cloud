import type { WorkerDb } from '@kilocode/db';
import {
  agent_environment_profile_skills,
  type AgentEnvironmentProfileSkill,
} from '@kilocode/db/schema';
import { and, eq, count } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type { ProfileOwner, ProfileSkillResponse } from './types';
import { verifyProfileOwnership } from './profile-utils';

export const MAX_PROFILE_SKILLS = 50;
export const MAX_SKILL_NAME_LENGTH = 100;
export const MAX_SKILL_MARKDOWN_LENGTH = 100_000; // ~100 KB
export const MAX_SKILL_DESCRIPTION_LENGTH = 2000;
/** Companion-file limits for multi-file skills (SKILL.md itself is stored in raw_markdown). */
export const MAX_SKILL_COMPANION_FILES = 20;
export const MAX_SKILL_COMPANION_FILE_SIZE = 100_000; // ~100 KB per file
export const MAX_SKILL_COMPANION_FILES_TOTAL = 500_000; // ~500 KB across all companion files
export const MAX_SKILL_COMPANION_PATH_LENGTH = 200;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SKILL_FILE_PATH_PATTERN = /^[a-zA-Z0-9._\-/]+$/;

export const skillNameSchema = z
  .string()
  .min(1)
  .max(MAX_SKILL_NAME_LENGTH)
  .regex(
    SKILL_NAME_PATTERN,
    'Skill name must be lowercase, start with a letter or digit, and contain only letters, digits, and dashes'
  );

/**
 * Validate a map of companion files. Keys are relative paths inside the skill
 * directory, values are the file contents. `SKILL.md` itself is stored in
 * `raw_markdown` and must not appear here.
 */
export const skillFilesSchema = z
  .record(z.string(), z.string())
  .refine(
    files => Object.keys(files).length <= MAX_SKILL_COMPANION_FILES,
    `Skill may have at most ${MAX_SKILL_COMPANION_FILES} companion files`
  )
  .superRefine((files, ctx) => {
    let total = 0;
    for (const [path, content] of Object.entries(files)) {
      if (path.length === 0 || path.length > MAX_SKILL_COMPANION_PATH_LENGTH) {
        ctx.addIssue({
          code: 'custom',
          message: `Invalid skill file path length: ${path.slice(0, 80)}`,
        });
        return;
      }
      if (!SKILL_FILE_PATH_PATTERN.test(path)) {
        ctx.addIssue({
          code: 'custom',
          message: `Skill file path contains invalid characters: ${path}`,
        });
        return;
      }
      if (path.startsWith('/') || path.includes('..') || path.includes('//')) {
        ctx.addIssue({ code: 'custom', message: `Skill file path rejected: ${path}` });
        return;
      }
      if (path === 'SKILL.md' || path.toLowerCase() === 'skill.md') {
        ctx.addIssue({
          code: 'custom',
          message: 'SKILL.md must be supplied as rawMarkdown, not in files',
        });
        return;
      }
      if (content.length > MAX_SKILL_COMPANION_FILE_SIZE) {
        ctx.addIssue({
          code: 'custom',
          message: `Skill companion file ${path} exceeds ${MAX_SKILL_COMPANION_FILE_SIZE} bytes`,
        });
        return;
      }
      total += content.length;
    }
    if (total > MAX_SKILL_COMPANION_FILES_TOTAL) {
      ctx.addIssue({
        code: 'custom',
        message: `Skill companion files total ${total} bytes, exceeds ${MAX_SKILL_COMPANION_FILES_TOTAL}`,
      });
    }
  });

/** Input for creating a custom skill by pasting SKILL.md directly. */
export const skillCustomInputSchema = z.object({
  name: skillNameSchema,
  description: z.string().max(MAX_SKILL_DESCRIPTION_LENGTH).optional(),
  rawMarkdown: z
    .string()
    .min(1)
    .max(MAX_SKILL_MARKDOWN_LENGTH, `Skill markdown exceeds ${MAX_SKILL_MARKDOWN_LENGTH} bytes`),
  files: skillFilesSchema.optional(),
  enabled: z.boolean().optional(),
});

/** Input for updating a skill. */
export const skillUpdateInputSchema = z.object({
  name: skillNameSchema.optional(),
  description: z.string().max(MAX_SKILL_DESCRIPTION_LENGTH).nullable().optional(),
  rawMarkdown: z
    .string()
    .min(1)
    .max(MAX_SKILL_MARKDOWN_LENGTH, `Skill markdown exceeds ${MAX_SKILL_MARKDOWN_LENGTH} bytes`)
    .optional(),
  files: skillFilesSchema.optional(),
  enabled: z.boolean().optional(),
});

export type SkillCustomInput = z.infer<typeof skillCustomInputSchema>;
export type SkillUpdateInput = z.infer<typeof skillUpdateInputSchema>;

/**
 * Extract YAML frontmatter `name` and `description` from SKILL.md.
 * Supports both --- and +++ delimiters. Returns `null` if no frontmatter.
 */
export function parseSkillFrontmatter(rawMarkdown: string): {
  name: string | null;
  description: string | null;
} {
  const match = rawMarkdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
  if (!match) {
    return { name: null, description: null };
  }
  const frontmatter = match[1];
  const nameMatch = frontmatter.match(/^name\s*:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description\s*:\s*(.+)$/m);
  const stripQuotes = (v: string): string => {
    const trimmed = v.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  };
  return {
    name: nameMatch ? stripQuotes(nameMatch[1]) : null,
    description: descMatch ? stripQuotes(descMatch[1]) : null,
  };
}

function toResponse(skill: AgentEnvironmentProfileSkill): ProfileSkillResponse {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    sourceType: skill.source_type,
    sourceUrl: skill.source_url,
    rawMarkdown: skill.raw_markdown,
    files: skill.files ?? {},
    enabled: skill.enabled,
    createdAt: skill.created_at,
    updatedAt: skill.updated_at,
  };
}

async function assertSkillLimit(db: WorkerDb, profileId: string): Promise<void> {
  const [row] = await db
    .select({ n: count() })
    .from(agent_environment_profile_skills)
    .where(eq(agent_environment_profile_skills.profile_id, profileId));
  if (Number(row.n) >= MAX_PROFILE_SKILLS) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Profiles are limited to ${MAX_PROFILE_SKILLS} skills`,
    });
  }
}

async function fetchSkill(
  db: WorkerDb,
  skillId: string,
  profileId: string
): Promise<AgentEnvironmentProfileSkill> {
  const [skill] = await db
    .select()
    .from(agent_environment_profile_skills)
    .where(
      and(
        eq(agent_environment_profile_skills.id, skillId),
        eq(agent_environment_profile_skills.profile_id, profileId)
      )
    )
    .limit(1);
  if (!skill) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Skill not found' });
  }
  return skill;
}

/**
 * List all skills for a profile in name order.
 * Internal: no ownership check; used by `profile-service.getProfile`.
 */
export async function listSkillsForProfile(
  db: WorkerDb,
  profileId: string
): Promise<ProfileSkillResponse[]> {
  const skills = await db
    .select()
    .from(agent_environment_profile_skills)
    .where(eq(agent_environment_profile_skills.profile_id, profileId))
    .orderBy(agent_environment_profile_skills.name);
  return skills.map(toResponse);
}

export async function createCustomSkill(
  db: WorkerDb,
  profileId: string,
  input: SkillCustomInput,
  owner: ProfileOwner
): Promise<{ id: string }> {
  await verifyProfileOwnership(db, profileId, owner);
  await assertSkillLimit(db, profileId);

  const [row] = await db
    .insert(agent_environment_profile_skills)
    .values({
      profile_id: profileId,
      name: input.name,
      description: input.description ?? null,
      source_type: 'custom',
      source_url: null,
      raw_markdown: input.rawMarkdown,
      files: input.files ?? {},
      enabled: input.enabled ?? true,
    })
    .returning({ id: agent_environment_profile_skills.id });

  return { id: row.id };
}

export async function updateSkill(
  db: WorkerDb,
  profileId: string,
  skillId: string,
  input: SkillUpdateInput,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  await fetchSkill(db, skillId, profileId);

  const updates: Partial<AgentEnvironmentProfileSkill> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.rawMarkdown !== undefined) updates.raw_markdown = input.rawMarkdown;
  if (input.files !== undefined) updates.files = input.files;
  if (input.enabled !== undefined) updates.enabled = input.enabled;

  if (Object.keys(updates).length === 0) {
    return;
  }

  await db
    .update(agent_environment_profile_skills)
    .set(updates)
    .where(eq(agent_environment_profile_skills.id, skillId));
}

export async function deleteSkill(
  db: WorkerDb,
  profileId: string,
  skillId: string,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  await fetchSkill(db, skillId, profileId);
  await db
    .delete(agent_environment_profile_skills)
    .where(eq(agent_environment_profile_skills.id, skillId));
}

export async function setSkillEnabled(
  db: WorkerDb,
  profileId: string,
  skillId: string,
  enabled: boolean,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  await fetchSkill(db, skillId, profileId);
  await db
    .update(agent_environment_profile_skills)
    .set({ enabled })
    .where(eq(agent_environment_profile_skills.id, skillId));
}

/**
 * Shape used for session materialization. Only enabled skills are returned.
 * Internal: no ownership check.
 */
export type SkillForSession = {
  name: string;
  rawMarkdown: string;
  files: Record<string, string>;
};

export async function getSkillsForSession(
  db: WorkerDb,
  profileId: string
): Promise<SkillForSession[]> {
  const skills = await db
    .select({
      name: agent_environment_profile_skills.name,
      rawMarkdown: agent_environment_profile_skills.raw_markdown,
      files: agent_environment_profile_skills.files,
    })
    .from(agent_environment_profile_skills)
    .where(
      and(
        eq(agent_environment_profile_skills.profile_id, profileId),
        eq(agent_environment_profile_skills.enabled, true)
      )
    )
    .orderBy(agent_environment_profile_skills.name);
  return skills.map(s => ({ ...s, files: s.files ?? {} }));
}
