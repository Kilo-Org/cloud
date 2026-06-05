import { z } from 'zod';

/**
 * Zod input schemas for agent config CRUD, shared by the personal
 * (kiloclaw-router) and org (organization-kiloclaw-router) tRPC namespaces.
 *
 * These mirror the controller's request schemas
 * (services/kiloclaw/controller/src/openclaw-agent-config.ts and
 * openclaw-agent-cli.ts). The controller re-validates everything; this is the
 * user-input validation boundary. Keep `.max()` lengths in sync with any
 * frontend `maxLength` on the corresponding inputs.
 */

// Agent ids normalize to <=64 chars on the controller.
export const AgentIdSchema = z.string().trim().min(1).max(64);

const ThinkingDefaultSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'adaptive',
  'max',
]);
const VerboseDefaultSchema = z.enum(['off', 'on', 'full']);
const ReasoningDefaultSchema = z.enum(['on', 'off', 'stream']);

// A model value to write: primary and/or fallbacks (at least one).
const ModelInputSchema = z
  .object({
    primary: z.string().trim().min(1).max(256).optional(),
    fallbacks: z.array(z.string().trim().min(1).max(256)).max(20).optional(),
  })
  .strict()
  // Require at least one actual value: `{ fallbacks: [] }` carries no model and
  // must be rejected (clear fallbacks via `unset: ['model.fallbacks']` instead).
  .refine(model => model.primary !== undefined || (model.fallbacks?.length ?? 0) > 0, {
    message: 'Model must set a primary or at least one fallback',
  });

// Per-agent editable settings (PATCH /_kilo/config/agents/:id).
const AgentSettingsSetSchema = z
  .object({
    model: ModelInputSchema.optional(),
    thinkingDefault: ThinkingDefaultSchema.optional(),
    verboseDefault: VerboseDefaultSchema.optional(),
    reasoningDefault: ReasoningDefaultSchema.optional(),
    fastModeDefault: z.boolean().optional(),
  })
  .strict();

const AgentSettingsUnsetSchema = z.enum([
  'model',
  'model.primary',
  'model.fallbacks',
  'thinkingDefault',
  'verboseDefault',
  'reasoningDefault',
  'fastModeDefault',
]);

export const AgentUpdateInputSchema = z
  .object({
    etag: z.string().min(1).max(128).optional(),
    set: AgentSettingsSetSchema.default({}),
    unset: z.array(AgentSettingsUnsetSchema).max(7).default([]),
  })
  .strict()
  .refine(body => Object.keys(body.set).length > 0 || body.unset.length > 0, {
    message: 'Patch must set or unset at least one field',
  });
export type AgentUpdateInput = z.infer<typeof AgentUpdateInputSchema>;

// Fleet-wide defaults (PATCH /_kilo/config/agent-defaults) — no reasoning/fastMode.
const AgentDefaultsSetSchema = z
  .object({
    model: ModelInputSchema.optional(),
    thinkingDefault: ThinkingDefaultSchema.optional(),
    verboseDefault: VerboseDefaultSchema.optional(),
  })
  .strict();

const AgentDefaultsUnsetSchema = z.enum([
  'model',
  'model.primary',
  'model.fallbacks',
  'thinkingDefault',
  'verboseDefault',
]);

export const AgentDefaultsUpdateInputSchema = z
  .object({
    etag: z.string().min(1).max(128).optional(),
    set: AgentDefaultsSetSchema.default({}),
    unset: z.array(AgentDefaultsUnsetSchema).max(5).default([]),
  })
  .strict()
  .refine(body => Object.keys(body.set).length > 0 || body.unset.length > 0, {
    message: 'Patch must set or unset at least one field',
  });
export type AgentDefaultsUpdateInput = z.infer<typeof AgentDefaultsUpdateInputSchema>;

// CLI values must be non-empty and must not be parsed as a flag.
const CliValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(value => !value.startsWith('-'), { message: 'Value must not begin with a dash' });

// Absolute (unix) path on the instance — the controller requires absolute paths.
const AbsolutePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(value => value.startsWith('/'), { message: 'Path must be absolute' });

// Create body (POST /_kilo/config/agents).
export const AgentCreateInputSchema = z
  .object({
    name: CliValueSchema,
    workspace: AbsolutePathSchema,
    agentDir: AbsolutePathSchema.optional(),
    model: CliValueSchema.optional(),
    bindings: z.array(CliValueSchema).max(50).optional(),
  })
  .strict();
export type AgentCreateInput = z.infer<typeof AgentCreateInputSchema>;
