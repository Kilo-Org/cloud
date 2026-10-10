import * as z from 'zod';
import { BUILTIN_AGENT_MODES } from './agent-modes.js';

export const RuntimeProfileLimits = {
  MAX_RUNTIME_SKILLS: 50,
  MAX_RUNTIME_SKILL_MARKDOWN: 100_000, // ~100KB
  MAX_RUNTIME_SKILL_NAME_LENGTH: 100,
  MAX_RUNTIME_SKILL_COMPANION_FILES: 40,
  MAX_RUNTIME_SKILL_COMPANION_FILE_SIZE: 100_000,
  MAX_RUNTIME_SKILL_COMPANION_FILES_TOTAL: 500_000,
  MAX_RUNTIME_SKILL_COMPANION_PATH_LENGTH: 200,
  MAX_RUNTIME_AGENTS: 20,
  MAX_RUNTIME_AGENT_SLUG_LENGTH: 50,
  MAX_RUNTIME_AGENT_NAME_LENGTH: 100,
  MAX_RUNTIME_AGENT_PROMPT: 50_000,
  MAX_RUNTIME_AGENT_DESCRIPTION: 2000,
  MAX_RUNTIME_AGENT_MODEL_LENGTH: 200,
  MAX_RUNTIME_KILO_COMMANDS: 50,
  MAX_RUNTIME_KILO_COMMAND_NAME_LENGTH: 100,
  MAX_RUNTIME_KILO_COMMAND_TEMPLATE: 100_000,
  MAX_RUNTIME_KILO_COMMAND_DESCRIPTION: 2000,
} as const;

const SKILL_FILE_PATH_PATTERN = /^[a-zA-Z0-9._\-/]+$/;

/** Shared by schema validation and the legacy writer that skips unsafe files. */
export function isSafeSkillFilePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= RuntimeProfileLimits.MAX_RUNTIME_SKILL_COMPANION_PATH_LENGTH &&
    SKILL_FILE_PATH_PATTERN.test(path) &&
    !path.startsWith('/') &&
    !path.includes('..') &&
    !path.includes('//') &&
    path.toLowerCase() !== 'skill.md'
  );
}

/** Validate a map of companion files bundled with a skill. */
const RuntimeSkillFilesSchema = z
  .record(
    z.string().min(1).max(RuntimeProfileLimits.MAX_RUNTIME_SKILL_COMPANION_PATH_LENGTH),
    z.string().max(RuntimeProfileLimits.MAX_RUNTIME_SKILL_COMPANION_FILE_SIZE)
  )
  .refine(
    files => Object.keys(files).length <= RuntimeProfileLimits.MAX_RUNTIME_SKILL_COMPANION_FILES,
    `A skill may have at most ${RuntimeProfileLimits.MAX_RUNTIME_SKILL_COMPANION_FILES} companion files`
  )
  .superRefine((files, ctx) => {
    let total = 0;
    for (const [path, content] of Object.entries(files)) {
      if (!isSafeSkillFilePath(path)) {
        ctx.addIssue({ code: 'custom', message: `Skill file path rejected: ${path}` });
        return;
      }
      total += content.length;
    }
    if (total > RuntimeProfileLimits.MAX_RUNTIME_SKILL_COMPANION_FILES_TOTAL) {
      ctx.addIssue({
        code: 'custom',
        message: `Skill companion files total ${total} bytes, exceeds ${RuntimeProfileLimits.MAX_RUNTIME_SKILL_COMPANION_FILES_TOTAL}`,
      });
    }
  });

/**
 * Runtime skill schema. Each entry is materialized to
 * `${SESSION_HOME}/.kilocode/skills/<name>/` at preparation time — `rawMarkdown`
 * is written to `SKILL.md`, and each `files[path]` is written under the same
 * directory.
 */
export const RuntimeSkillSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(RuntimeProfileLimits.MAX_RUNTIME_SKILL_NAME_LENGTH)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Skill name must be a slug'),
  rawMarkdown: z.string().min(1).max(RuntimeProfileLimits.MAX_RUNTIME_SKILL_MARKDOWN),
  files: RuntimeSkillFilesSchema.optional(),
});

export const RuntimeSkillsSchema = z
  .array(RuntimeSkillSchema)
  .max(
    RuntimeProfileLimits.MAX_RUNTIME_SKILLS,
    `Maximum ${RuntimeProfileLimits.MAX_RUNTIME_SKILLS} runtime skills allowed`
  );

export type RuntimeSkillInput = z.infer<typeof RuntimeSkillSchema>;

// --- Runtime agents ---

const PermissionActionSchema = z.enum(['allow', 'ask', 'deny']);
// Flat permissive shape — the runtime tolerates any shape the CLI accepts
// (bare action string, per-tool map with per-pattern maps, null sentinels).
// Schema-level typing kept loose so the zod inference used by MetadataSchema
// stays tractable; tighter validation lives at the web-app boundary.
const PermissionConfigSchema = z.union([PermissionActionSchema, z.record(z.string(), z.unknown())]);

/**
 * Runtime agent schema. Each entry is materialized into
 * `KILO_CONFIG_CONTENT.agent.<slug>` at session preparation time. Mirrors the
 * CLI's AgentConfig shape so we pass through verbatim.
 *
 * Reserved built-in slugs (`code`, `plan`, `architect`, `custom`, …) are
 * rejected here so an inline or persisted runtime agent cannot override a
 * built-in agent's prompt or permissions inside the sandbox. The web-side
 * profile service applies the same rule when persisting agents.
 */
export const RuntimeAgentSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(RuntimeProfileLimits.MAX_RUNTIME_AGENT_SLUG_LENGTH)
    .regex(/^[a-z][a-z0-9-]*$/, 'Agent slug must start with a letter')
    .refine(slug => !BUILTIN_AGENT_MODES.has(slug), {
      message: 'Slug conflicts with a built-in agent; choose a different slug',
    }),
  name: z.string().min(1).max(RuntimeProfileLimits.MAX_RUNTIME_AGENT_NAME_LENGTH),
  config: z
    .object({
      prompt: z.string().max(RuntimeProfileLimits.MAX_RUNTIME_AGENT_PROMPT).optional(),
      description: z.string().max(RuntimeProfileLimits.MAX_RUNTIME_AGENT_DESCRIPTION).optional(),
      mode: z.enum(['subagent', 'primary', 'all']).optional(),
      model: z
        .string()
        .max(RuntimeProfileLimits.MAX_RUNTIME_AGENT_MODEL_LENGTH)
        .nullable()
        .optional(),
      variant: z.string().max(50).optional(),
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      steps: z.number().int().positive().optional(),
      hidden: z.boolean().optional(),
      disable: z.boolean().optional(),
      color: z.string().max(50).optional(),
      permission: PermissionConfigSchema.optional(),
      options: z.record(z.string(), z.unknown()).optional(),
    })
    // Variant keys are model-specific, so a `variant` without a `model`
    // has no anchor — mirror the web-side AgentConfigSchema invariant.
    .refine(c => !c.variant || (typeof c.model === 'string' && c.model.length > 0), {
      message: 'variant requires a model — variants are model-specific',
      path: ['variant'],
    }),
});

export const RuntimeAgentsSchema = z
  .array(RuntimeAgentSchema)
  .max(
    RuntimeProfileLimits.MAX_RUNTIME_AGENTS,
    `Maximum ${RuntimeProfileLimits.MAX_RUNTIME_AGENTS} runtime agents allowed`
  );

export type RuntimeAgentInput = z.infer<typeof RuntimeAgentSchema>;

// --- Runtime kilo commands ---

export const RuntimeKiloCommandSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(RuntimeProfileLimits.MAX_RUNTIME_KILO_COMMAND_NAME_LENGTH)
    .regex(/^[a-z][a-z0-9-]*$/, 'Command name must start with a letter and be a slug'),
  template: z.string().min(1).max(RuntimeProfileLimits.MAX_RUNTIME_KILO_COMMAND_TEMPLATE),
  description: z
    .string()
    .max(RuntimeProfileLimits.MAX_RUNTIME_KILO_COMMAND_DESCRIPTION)
    .nullable()
    .optional(),
  agent: z.string().max(RuntimeProfileLimits.MAX_RUNTIME_AGENT_SLUG_LENGTH).nullable().optional(),
  model: z.string().max(RuntimeProfileLimits.MAX_RUNTIME_AGENT_MODEL_LENGTH).nullable().optional(),
  subtask: z.boolean().optional(),
});

export const RuntimeKiloCommandsSchema = z
  .array(RuntimeKiloCommandSchema)
  .max(
    RuntimeProfileLimits.MAX_RUNTIME_KILO_COMMANDS,
    `Maximum ${RuntimeProfileLimits.MAX_RUNTIME_KILO_COMMANDS} runtime kilo commands allowed`
  );

export type RuntimeKiloCommandInput = z.infer<typeof RuntimeKiloCommandSchema>;
