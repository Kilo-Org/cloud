import * as z from 'zod';

/**
 * Agent ids the Kilo CLI owns, plus the cloud mode aliases that resolve to them.
 * The wrapper build copies only `src/shared` and `wrapper`, so this list cannot
 * come from a workspace package; a parity test keeps it equal to
 * `RESERVED_AGENT_SLUGS` in `@kilocode/app-shared/agent-profile`.
 */
export const RESERVED_RUNTIME_AGENT_SLUGS = [
  'code',
  'plan',
  'debug',
  'orchestrator',
  'ask',
  'build',
  'architect',
  'custom',
  'general',
  'explore',
  'compaction',
  'title',
  'summary',
] as const;

/** True when an agent id belongs to the CLI's own agents. */
export function isReservedRuntimeAgentSlug(slug: string): boolean {
  return RESERVED_RUNTIME_AGENT_SLUGS.some(reserved => reserved === slug);
}

export const RuntimeProfileLimits = {
  MAX_RUNTIME_INSTRUCTIONS: 50,
  MAX_RUNTIME_INSTRUCTION_NAME_LENGTH: 100,
  MAX_RUNTIME_INSTRUCTION_CONTENT: 100_000,
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
  MAX_RUNTIME_AGENT_DESCRIPTION: 2000,
  MAX_RUNTIME_AGENT_MODEL_LENGTH: 200,
  MAX_RUNTIME_KILO_COMMANDS: 50,
  MAX_RUNTIME_KILO_COMMAND_NAME_LENGTH: 100,
  MAX_RUNTIME_KILO_COMMAND_TEMPLATE: 100_000,
  MAX_RUNTIME_KILO_COMMAND_DESCRIPTION: 2000,
  MAX_MODEL_CONTEXT_LIMITS: 50,
  MAX_MODEL_CONTEXT_LIMIT_MODEL_LENGTH: 200,
  MIN_MODEL_CONTEXT_TOKENS: 1_000,
  MAX_MODEL_CONTEXT_TOKENS: 10_000_000,
} as const;

/** Profile rules share the legacy rules directory with the reserved built-in file. */
export const RuntimeInstructionSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(RuntimeProfileLimits.MAX_RUNTIME_INSTRUCTION_NAME_LENGTH)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Instruction name must be a lowercase slug')
    .refine(name => name !== 'cloud-agent', {
      message:
        'Instruction name conflicts with the Cloud-Agent-owned rules file; choose another name',
    }),
  content: z.string().min(1).max(RuntimeProfileLimits.MAX_RUNTIME_INSTRUCTION_CONTENT),
});

export const RuntimeInstructionsSchema = z
  .array(RuntimeInstructionSchema)
  .max(
    RuntimeProfileLimits.MAX_RUNTIME_INSTRUCTIONS,
    `Maximum ${RuntimeProfileLimits.MAX_RUNTIME_INSTRUCTIONS} runtime instructions allowed`
  );

export type RuntimeInstructionInput = z.infer<typeof RuntimeInstructionSchema>;

const SKILL_FILE_PATH_PATTERN = /^[a-zA-Z0-9._\-/]+$/;

/** Shared by schema validation and the writer that keeps only accepted paths. */
export function isSafeSkillFilePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= RuntimeProfileLimits.MAX_RUNTIME_SKILL_COMPANION_PATH_LENGTH &&
    SKILL_FILE_PATH_PATTERN.test(path) &&
    path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..') &&
    !path.includes('..') &&
    path.toLowerCase() !== 'skill.md'
  );
}

export type AcceptedRuntimeSkillFiles = {
  accepted: Record<string, string>;
  rejected: Array<{ path: string; reason: 'path' | 'duplicate' }>;
};

/** Split a companion-file map into the entries the writer keeps and why the rest are dropped. */
export function acceptedRuntimeSkillFiles(
  files: Record<string, string>
): AcceptedRuntimeSkillFiles {
  const accepted: Array<[string, string]> = [];
  const rejected: AcceptedRuntimeSkillFiles['rejected'] = [];
  const seen = new Set<string>();
  for (const [path, content] of Object.entries(files)) {
    if (!isSafeSkillFilePath(path)) {
      rejected.push({ path, reason: 'path' });
      continue;
    }
    const folded = path.toLowerCase();
    if (seen.has(folded)) {
      rejected.push({ path, reason: 'duplicate' });
      continue;
    }
    seen.add(folded);
    accepted.push([path, content]);
  }
  return { accepted: Object.fromEntries(accepted), rejected };
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
    const { accepted, rejected } = acceptedRuntimeSkillFiles(files);
    const first = rejected[0];
    if (first) {
      ctx.addIssue({
        code: 'custom',
        message:
          first.reason === 'path'
            ? `Skill file path rejected: ${first.path}`
            : `Skill file path duplicates another companion file: ${first.path}`,
      });
      return;
    }
    let total = 0;
    for (const content of Object.values(accepted)) {
      total += content.length;
    }
    if (total > RuntimeProfileLimits.MAX_RUNTIME_SKILL_COMPANION_FILES_TOTAL) {
      ctx.addIssue({
        code: 'custom',
        message: `Skill companion files total ${total} characters, over the limit of ${RuntimeProfileLimits.MAX_RUNTIME_SKILL_COMPANION_FILES_TOTAL} characters`,
      });
    }
  });

const RuntimeSkillNameSchema = z
  .string()
  .min(1)
  .max(RuntimeProfileLimits.MAX_RUNTIME_SKILL_NAME_LENGTH)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Skill name must be a slug');

export const RuntimeSkillSchema = z.union([
  z.object({
    name: RuntimeSkillNameSchema,
    rawMarkdown: z.string().min(1).max(RuntimeProfileLimits.MAX_RUNTIME_SKILL_MARKDOWN),
    files: RuntimeSkillFilesSchema.optional(),
    source: z.never().optional(),
  }),
  z.strictObject({
    name: RuntimeSkillNameSchema,
    source: z
      .string()
      .max(140)
      .regex(
        /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}\/[a-z0-9._][a-z0-9._-]{0,99}$/,
        'Skill source must be a GitHub owner/repo'
      )
      .refine(source => !source.includes('..') && !source.endsWith('/.')),
  }),
]);

export const RuntimeSkillsSchema = z
  .array(RuntimeSkillSchema)
  .max(
    RuntimeProfileLimits.MAX_RUNTIME_SKILLS,
    `Maximum ${RuntimeProfileLimits.MAX_RUNTIME_SKILLS} runtime skills allowed`
  );

/** Keep only the companion files the current path rule accepts, whatever the stored shape. */
export function projectStoredRuntimeSkills(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const skills: unknown[] = value;
  return skills.map(skill => {
    if (typeof skill !== 'object' || skill === null || !('files' in skill)) return skill;
    const files = skill.files;
    if (typeof files !== 'object' || files === null || Array.isArray(files)) return skill;
    const companions = Object.fromEntries(
      Object.entries(files as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    );
    return { ...skill, files: acceptedRuntimeSkillFiles(companions).accepted };
  });
}

/** Drop stored runtime agents whose slug the CLI owns, whatever the stored shape. */
export function projectStoredRuntimeAgents(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const agents: unknown[] = value;
  return agents.filter(agent => {
    if (typeof agent !== 'object' || agent === null) return true;
    if (!('slug' in agent)) return true;
    const slug = agent.slug;
    return typeof slug !== 'string' || !isReservedRuntimeAgentSlug(slug);
  });
}

/**
 * Route spec read back from storage: its runtime skills keep the entries the
 * current path rule accepts and its runtime agents keep the entries whose slug
 * the CLI leaves to the profile, so a spec written under an earlier rule still
 * loads. A spec that arrives on the wire is parsed with
 * `controlPlaneRouteSpecSchema` and stays strict.
 */
export function projectStoredRouteSpec(spec: unknown): unknown {
  if (typeof spec !== 'object' || spec === null) return spec;
  let projected = spec;
  if ('runtimeSkills' in projected) {
    projected = {
      ...projected,
      runtimeSkills: projectStoredRuntimeSkills(projected.runtimeSkills),
    };
  }
  if ('runtimeAgents' in projected) {
    projected = {
      ...projected,
      runtimeAgents: projectStoredRuntimeAgents(projected.runtimeAgents),
    };
  }
  return projected;
}

/**
 * Runtime skills read back from storage. A bundle written under an earlier path
 * rule keeps the companion files the current rule accepts, so a stored session
 * or registration parses with the rest of its configuration. Anything a caller
 * supplies is validated with `RuntimeSkillsSchema` instead.
 */
export const PersistedRuntimeSkillsSchema = z.preprocess(
  projectStoredRuntimeSkills,
  RuntimeSkillsSchema.optional()
);

export type RuntimeSkillInput = z.infer<typeof RuntimeSkillSchema>;

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
 * A runtime agent slug uses an id of its own. The CLI's own agent ids
 * (`build`, `plan`, `general`, `explore`, `compaction`, `title`, `summary`) and
 * the cloud mode aliases that resolve to them (`code`, `debug`, `orchestrator`,
 * `ask`, `architect`, `custom`) stay reserved, for an inline runtime agent and
 * for a stored one alike. The web-side profile service applies the same rule
 * when persisting agents.
 */
export const RuntimeAgentSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(RuntimeProfileLimits.MAX_RUNTIME_AGENT_SLUG_LENGTH)
    .regex(/^[a-z][a-z0-9-]*$/, 'Agent slug must start with a letter')
    .refine(slug => !isReservedRuntimeAgentSlug(slug), {
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

/**
 * Runtime agents read back from storage. A bundle written under an earlier
 * slug rule keeps loading: entries whose slug the CLI owns are dropped, so a
 * stored session or registration parses with the rest of its configuration.
 * Anything a caller supplies is validated with `RuntimeAgentsSchema` instead.
 */
export const PersistedRuntimeAgentsSchema = z.preprocess(
  projectStoredRuntimeAgents,
  RuntimeAgentsSchema.optional()
);

export type RuntimeAgentInput = z.infer<typeof RuntimeAgentSchema>;

/**
 * Built-in CLI agents whose model or visibility a Cloud Agent user may tune.
 * Keep this list in sync with `CLOUD_AGENT_BUILTIN_AGENTS` in
 * `@kilocode/cloud-agent-profile`; a parity test asserts they match.
 */
export const RUNTIME_BUILTIN_AGENT_SLUGS = [
  'code',
  'plan',
  'debug',
  'orchestrator',
  'ask',
  'explore',
  'compaction',
] as const;

/** Agents whose visibility the user may turn off. `code` is the session default. */
export const RUNTIME_DISABLEABLE_BUILTIN_AGENT_SLUGS = [
  'plan',
  'debug',
  'orchestrator',
  'ask',
] as const;

const RuntimeBuiltinAgentOverrideSchema = z
  .strictObject({
    model: z
      .string()
      .trim()
      .min(1)
      .max(RuntimeProfileLimits.MAX_RUNTIME_AGENT_MODEL_LENGTH)
      .nullable()
      .optional(),
    variant: z.string().trim().min(1).max(50).optional(),
    disable: z.boolean().optional(),
  })
  .refine(override => !override.variant || typeof override.model === 'string', {
    message: 'variant requires a model — variants are model-specific',
    path: ['variant'],
  });

/**
 * User-scoped overrides for CLI built-in agents. Unlike `runtimeAgents`, these
 * entries target existing agents and may be disabled rather than replacing
 * their prompt. Materialized into `KILO_CONFIG_CONTENT.agent.<slug>` beside
 * custom runtime agents.
 */
export const RuntimeBuiltinAgentsSchema = z
  .partialRecord(z.enum(RUNTIME_BUILTIN_AGENT_SLUGS), RuntimeBuiltinAgentOverrideSchema)
  .superRefine((agents, ctx) => {
    for (const [slug, override] of Object.entries(agents)) {
      if (
        override.disable === true &&
        !RUNTIME_DISABLEABLE_BUILTIN_AGENT_SLUGS.includes(
          slug as (typeof RUNTIME_DISABLEABLE_BUILTIN_AGENT_SLUGS)[number]
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [slug, 'disable'],
          message: 'This built-in agent cannot be disabled',
        });
      }
    }
  });
export type RuntimeBuiltinAgents = z.infer<typeof RuntimeBuiltinAgentsSchema>;

/**
 * User-scoped per-model context-window caps, keyed by gateway model id without
 * the `kilo/` prefix. Materialized into `KILO_CONFIG_CONTENT.provider.kilo.models`
 * at session preparation time. Keep the bounds in sync with
 * `ModelContextLimitsSchema` in `@kilocode/cloud-agent-profile`; a parity test
 * asserts they match.
 */
export const RuntimeModelContextLimitsSchema = z
  .record(
    z.string().min(1).max(RuntimeProfileLimits.MAX_MODEL_CONTEXT_LIMIT_MODEL_LENGTH),
    z
      .number()
      .int()
      .min(RuntimeProfileLimits.MIN_MODEL_CONTEXT_TOKENS)
      .max(RuntimeProfileLimits.MAX_MODEL_CONTEXT_TOKENS)
  )
  .refine(
    limits => Object.keys(limits).length <= RuntimeProfileLimits.MAX_MODEL_CONTEXT_LIMITS,
    `Maximum ${RuntimeProfileLimits.MAX_MODEL_CONTEXT_LIMITS} model context limits allowed`
  );
export type RuntimeModelContextLimits = z.infer<typeof RuntimeModelContextLimitsSchema>;

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
