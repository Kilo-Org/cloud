import { AgentConfigSchema } from '@kilocode/db/schema-types';
import * as z from 'zod';

export const MAX_PROFILE_AGENTS = 20;
export const MAX_AGENT_NAME_LENGTH = 100;
export const MAX_AGENT_SLUG_LENGTH = 50;

/**
 * Built-in kilo agent slugs reserved by cloud-agent-next. Profile-scoped
 * agents must not collide with these to keep the picker unambiguous.
 */
export const BUILTIN_AGENT_SLUGS = new Set([
  'code',
  'plan',
  'debug',
  'orchestrator',
  'ask',
  'build',
  'architect',
  'custom',
]);

// First char must be a letter — matches the kilocode extension's import
// validator (`/^[a-z][a-z0-9-]*$/`) so agents round-trip cleanly.
const AGENT_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

export const agentSlugSchema = z
  .string()
  .min(1)
  .max(MAX_AGENT_SLUG_LENGTH)
  .regex(
    AGENT_SLUG_PATTERN,
    'Agent slug must start with a lowercase letter and contain only lowercase letters, digits, and dashes'
  )
  .refine((slug: string) => !BUILTIN_AGENT_SLUGS.has(slug), {
    message: 'Slug conflicts with a built-in agent; choose a different slug',
  });

export const agentNameSchema = z.string().min(1).max(MAX_AGENT_NAME_LENGTH);

export const agentCreateInputSchema = z.object({
  slug: agentSlugSchema,
  name: agentNameSchema,
  config: AgentConfigSchema,
});

export const agentUpdateInputSchema = z.object({
  slug: agentSlugSchema.optional(),
  name: agentNameSchema.optional(),
  config: AgentConfigSchema.optional(),
});

export type AgentCreateInput = z.infer<typeof agentCreateInputSchema>;
export type AgentUpdateInput = z.infer<typeof agentUpdateInputSchema>;
