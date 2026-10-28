import * as z from 'zod';

/**
 * Field constraints for the session (runtime) delivery contract, mirrored from
 * `services/cloud-agent-next/src/persistence/schemas.ts`. The web package must
 * not import that service (it pulls drizzle/trpc), so this module mirrors the
 * runtime shapes and a parity test in the service asserts behavioural
 * equivalence. Import validation must satisfy the intersection of these
 * constraints and the profile storage validators.
 *
 * Verified divergences from the storage contract: kilo command `agent` is
 * capped at 50 and `model` at 200 here, while the profile schema leaves both
 * unbounded; the runtime command name cap (100) is looser than the profile cap
 * (50).
 */
export const RUNTIME_LIMITS = {
  MAX_RUNTIME_SKILLS: 50,
  MAX_RUNTIME_SKILL_MARKDOWN: 100_000,
  MAX_RUNTIME_SKILL_NAME_LENGTH: 100,
  MAX_RUNTIME_SKILL_COMPANION_FILES: 40,
  MAX_RUNTIME_SKILL_COMPANION_FILE_SIZE: 100_000,
  MAX_RUNTIME_SKILL_COMPANION_FILES_TOTAL: 500_000,
  MAX_RUNTIME_SKILL_COMPANION_PATH_LENGTH: 200,
  MAX_RUNTIME_AGENTS: 20,
  MAX_RUNTIME_AGENT_SLUG_LENGTH: 50,
  MAX_RUNTIME_AGENT_NAME_LENGTH: 100,
  MAX_RUNTIME_AGENT_PROMPT: 50_000,
  MAX_RUNTIME_AGENT_DESCRIPTION: 2_000,
  MAX_RUNTIME_AGENT_MODEL_LENGTH: 200,
  MAX_RUNTIME_KILO_COMMANDS: 50,
  MAX_RUNTIME_KILO_COMMAND_NAME_LENGTH: 100,
  MAX_RUNTIME_KILO_COMMAND_TEMPLATE: 100_000,
  MAX_RUNTIME_KILO_COMMAND_DESCRIPTION: 2_000,
} as const;

/** Built-in mode slugs recognized by the CLI. */
export const RUNTIME_BUILTIN_AGENT_SLUGS = new Set<string>([
  'code',
  'plan',
  'debug',
  'orchestrator',
  'ask',
  'build',
  'architect',
  'custom',
]);

const SKILL_FILE_PATH_PATTERN = /^[a-zA-Z0-9._\-/]+$/;

const RuntimeSkillFilesContractSchema = z
  .record(
    z.string().min(1).max(RUNTIME_LIMITS.MAX_RUNTIME_SKILL_COMPANION_PATH_LENGTH),
    z.string().max(RUNTIME_LIMITS.MAX_RUNTIME_SKILL_COMPANION_FILE_SIZE)
  )
  .refine(
    files => Object.keys(files).length <= RUNTIME_LIMITS.MAX_RUNTIME_SKILL_COMPANION_FILES,
    `A skill may have at most ${RUNTIME_LIMITS.MAX_RUNTIME_SKILL_COMPANION_FILES} companion files`
  )
  .superRefine((files, ctx) => {
    let total = 0;
    for (const [path, content] of Object.entries(files)) {
      if (!SKILL_FILE_PATH_PATTERN.test(path)) {
        ctx.addIssue({ code: 'custom', message: `Skill file path rejected: ${path}` });
        return;
      }
      if (path.startsWith('/') || path.includes('..') || path.includes('//')) {
        ctx.addIssue({ code: 'custom', message: `Skill file path rejected: ${path}` });
        return;
      }
      if (path === 'SKILL.md' || path.toLowerCase() === 'skill.md') {
        ctx.addIssue({
          code: 'custom',
          message: 'SKILL.md must be passed as rawMarkdown, not inside files',
        });
        return;
      }
      total += content.length;
    }
    if (total > RUNTIME_LIMITS.MAX_RUNTIME_SKILL_COMPANION_FILES_TOTAL) {
      ctx.addIssue({
        code: 'custom',
        message: `Skill companion files total ${total} bytes, exceeds ${RUNTIME_LIMITS.MAX_RUNTIME_SKILL_COMPANION_FILES_TOTAL}`,
      });
    }
  });

export const RuntimeSkillContractSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(RUNTIME_LIMITS.MAX_RUNTIME_SKILL_NAME_LENGTH)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Skill name must be a slug'),
  rawMarkdown: z.string().min(1).max(RUNTIME_LIMITS.MAX_RUNTIME_SKILL_MARKDOWN),
  files: RuntimeSkillFilesContractSchema.optional(),
});

const PermissionActionContractSchema = z.enum(['allow', 'ask', 'deny']);
const PermissionConfigContractSchema = z.union([
  PermissionActionContractSchema,
  z.record(z.string(), z.unknown()),
]);

export const RuntimeAgentContractSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(RUNTIME_LIMITS.MAX_RUNTIME_AGENT_SLUG_LENGTH)
    .regex(/^[a-z][a-z0-9-]*$/, 'Agent slug must start with a letter')
    .refine(slug => !RUNTIME_BUILTIN_AGENT_SLUGS.has(slug), {
      message: 'Slug conflicts with a built-in agent; choose a different slug',
    }),
  name: z.string().min(1).max(RUNTIME_LIMITS.MAX_RUNTIME_AGENT_NAME_LENGTH),
  config: z
    .object({
      prompt: z.string().max(RUNTIME_LIMITS.MAX_RUNTIME_AGENT_PROMPT).optional(),
      description: z.string().max(RUNTIME_LIMITS.MAX_RUNTIME_AGENT_DESCRIPTION).optional(),
      mode: z.enum(['subagent', 'primary', 'all']).optional(),
      model: z.string().max(RUNTIME_LIMITS.MAX_RUNTIME_AGENT_MODEL_LENGTH).nullable().optional(),
      variant: z.string().max(50).optional(),
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      steps: z.number().int().positive().optional(),
      hidden: z.boolean().optional(),
      disable: z.boolean().optional(),
      color: z.string().max(50).optional(),
      permission: PermissionConfigContractSchema.optional(),
      options: z.record(z.string(), z.unknown()).optional(),
    })
    .refine(c => !c.variant || (typeof c.model === 'string' && c.model.length > 0), {
      message: 'variant requires a model — variants are model-specific',
      path: ['variant'],
    }),
});

export const RuntimeKiloCommandContractSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(RUNTIME_LIMITS.MAX_RUNTIME_KILO_COMMAND_NAME_LENGTH)
    .regex(/^[a-z][a-z0-9-]*$/, 'Command name must start with a letter and be a slug'),
  template: z.string().min(1).max(RUNTIME_LIMITS.MAX_RUNTIME_KILO_COMMAND_TEMPLATE),
  description: z
    .string()
    .max(RUNTIME_LIMITS.MAX_RUNTIME_KILO_COMMAND_DESCRIPTION)
    .nullable()
    .optional(),
  agent: z.string().max(RUNTIME_LIMITS.MAX_RUNTIME_AGENT_SLUG_LENGTH).nullable().optional(),
  model: z.string().max(RUNTIME_LIMITS.MAX_RUNTIME_AGENT_MODEL_LENGTH).nullable().optional(),
  subtask: z.boolean().optional(),
});

export const RuntimeAgentsContractSchema = z
  .array(RuntimeAgentContractSchema)
  .max(RUNTIME_LIMITS.MAX_RUNTIME_AGENTS);

export const RuntimeSkillsContractSchema = z
  .array(RuntimeSkillContractSchema)
  .max(RUNTIME_LIMITS.MAX_RUNTIME_SKILLS);

export const RuntimeKiloCommandsContractSchema = z
  .array(RuntimeKiloCommandContractSchema)
  .max(RUNTIME_LIMITS.MAX_RUNTIME_KILO_COMMANDS);
