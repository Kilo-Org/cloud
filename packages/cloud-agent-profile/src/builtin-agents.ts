import * as z from 'zod';

export const MAX_BUILTIN_AGENT_MODEL_LENGTH = 200;
export const MAX_BUILTIN_AGENT_VARIANT_LENGTH = 50;

export type CloudAgentBuiltinAgentDefinition = {
  slug: string;
  name: string;
  description: string;
  kind: 'primary' | 'subagent';
  /** Primary agents the user may hide from the picker. */
  canDisable: boolean;
};

/**
 * Built-in CLI agents whose model or visibility a Cloud Agent user may tune.
 *
 * `code` stays enabled because Cloud Agent sessions start in it. `explore` and
 * `compaction` exist only as subagents, so they can change model but never be
 * disabled. Aliases (`build`, `architect`) and internal agents (`custom`,
 * `title`, `summary`, `general`) are not exposed: the CLI resolves the former
 * to a canonical slug and the latter are not user-facing.
 */
export const CLOUD_AGENT_BUILTIN_AGENTS = [
  {
    slug: 'code',
    name: 'Code',
    description: 'Default agent for writing and modifying code.',
    kind: 'primary',
    canDisable: false,
  },
  {
    slug: 'plan',
    name: 'Plan',
    description: 'Plans and designs solutions before implementation.',
    kind: 'primary',
    canDisable: true,
  },
  {
    slug: 'debug',
    name: 'Debug',
    description: 'Finds and fixes issues.',
    kind: 'primary',
    canDisable: true,
  },
  {
    slug: 'orchestrator',
    name: 'Orchestrator',
    description: 'Coordinates complex multi-step tasks.',
    kind: 'primary',
    canDisable: true,
  },
  {
    slug: 'ask',
    name: 'Ask',
    description: 'Answers questions and explains code.',
    kind: 'primary',
    canDisable: true,
  },
  {
    slug: 'explore',
    name: 'Explore',
    description: 'Searches and reads the repository for a task.',
    kind: 'subagent',
    canDisable: false,
  },
  {
    slug: 'compaction',
    name: 'Compaction',
    description: 'Summarizes conversation history when the context is compacted.',
    kind: 'subagent',
    canDisable: false,
  },
] as const satisfies readonly CloudAgentBuiltinAgentDefinition[];

export type CloudAgentBuiltinAgentSlug = (typeof CLOUD_AGENT_BUILTIN_AGENTS)[number]['slug'];

export const CLOUD_AGENT_BUILTIN_AGENT_SLUGS = CLOUD_AGENT_BUILTIN_AGENTS.map(
  agent => agent.slug
) as unknown as readonly CloudAgentBuiltinAgentSlug[];

const BUILTIN_AGENT_BY_SLUG = new Map(
  CLOUD_AGENT_BUILTIN_AGENTS.map(agent => [agent.slug, agent] as const)
);

export function getCloudAgentBuiltinAgent(
  slug: string
): CloudAgentBuiltinAgentDefinition | undefined {
  return BUILTIN_AGENT_BY_SLUG.get(slug as CloudAgentBuiltinAgentSlug);
}

export const BuiltinAgentOverrideSchema = z
  .strictObject({
    model: z.string().trim().min(1).max(MAX_BUILTIN_AGENT_MODEL_LENGTH).nullable().optional(),
    variant: z.string().trim().min(1).max(MAX_BUILTIN_AGENT_VARIANT_LENGTH).optional(),
    disable: z.boolean().optional(),
  })
  .refine(override => !override.variant || typeof override.model === 'string', {
    message: 'variant requires a model — variants are model-specific',
    path: ['variant'],
  });

export type BuiltinAgentOverride = z.infer<typeof BuiltinAgentOverrideSchema>;

export const BuiltinAgentSettingsSchema = z.partialRecord(
  z.enum(CLOUD_AGENT_BUILTIN_AGENT_SLUGS),
  BuiltinAgentOverrideSchema
);

export type BuiltinAgentSettings = z.infer<typeof BuiltinAgentSettingsSchema>;

/** API input: same shape, but a disable flag is only accepted where the UI offers it. */
export const BuiltinAgentSettingsInputSchema = BuiltinAgentSettingsSchema.superRefine(
  (settings, ctx) => {
    for (const [slug, override] of Object.entries(settings)) {
      if (override.disable !== true) continue;
      const definition = getCloudAgentBuiltinAgent(slug);
      if (!definition?.canDisable) {
        ctx.addIssue({
          code: 'custom',
          path: [slug, 'disable'],
          message: `The ${definition?.name ?? slug} agent cannot be disabled`,
        });
      }
    }
  }
);

/**
 * Drop empty rows and disallowed disable flags so an empty control never
 * persists as an override. Unknown slugs are already rejected by the schema.
 */
export function normalizeBuiltinAgentSettings(
  settings: BuiltinAgentSettings
): BuiltinAgentSettings {
  const normalized: BuiltinAgentSettings = {};
  for (const [slug, override] of Object.entries(settings)) {
    const definition = getCloudAgentBuiltinAgent(slug);
    if (!definition) continue;
    const next: BuiltinAgentOverride = {};
    if (override.model !== undefined) next.model = override.model;
    if (override.variant !== undefined) next.variant = override.variant;
    if (override.disable === true && definition.canDisable) next.disable = true;
    if (Object.keys(next).length > 0) normalized[slug as CloudAgentBuiltinAgentSlug] = next;
  }
  return normalized;
}

export function hasBuiltinAgentSettings(settings: BuiltinAgentSettings | undefined): boolean {
  return settings !== undefined && Object.keys(settings).length > 0;
}
