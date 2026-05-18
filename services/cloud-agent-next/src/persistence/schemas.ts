import * as z from 'zod';
import { BUILTIN_AGENT_MODES, Limits } from '../schema.js';
import type { SandboxId } from '../types.js';

/**
 * Schema for callback target configuration.
 * Defined here to avoid circular dependency with router/schemas.ts.
 */
export const CallbackTargetSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

/**
 * Schema for image attachments that will be downloaded from R2 to the sandbox.
 * Defined here to avoid circular dependency with router/schemas.ts.
 * Images are stored in R2 at path: {bucket}/{userId}/{path}/{filename}
 */
const imageMessageUuidSchema = z
  .string()
  .uuid()
  .describe('Bare message upload UUID; service prefix is derived by the worker');

const imageFilenameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(png|jpg|jpeg|webp|gif)$/,
    'Image filename must be a UUID with extension png, jpg, jpeg, webp, or gif'
  );

export const ImagesSchema = z.object({
  path: imageMessageUuidSchema,
  files: z
    .array(imageFilenameSchema)
    .min(1)
    .max(5)
    .describe('Ordered array of specific UUID image filenames to download'),
});
export type Images = z.infer<typeof ImagesSchema>;

/**
 * Schema for encrypted secret envelope (RSA + AES envelope encryption).
 * Matches the EncryptedEnvelope type from kilocode-backend.
 * Defined here to avoid circular dependency with router/schemas.ts.
 */
export const EncryptedSecretEnvelopeSchema = z.object({
  encryptedData: z.string().describe('AES-encrypted value (base64)'),
  encryptedDEK: z.string().describe('RSA-encrypted DEK (base64)'),
  algorithm: z.literal('rsa-aes-256-gcm'),
  version: z.literal(1),
});

export type EncryptedSecretEnvelope = z.infer<typeof EncryptedSecretEnvelopeSchema>;

/**
 * A single MCP env value or remote header value. Plain strings are passed
 * through verbatim; encrypted envelopes are decrypted by the worker just
 * before materializing `KILO_CONFIG_CONTENT.mcp`. Callers mix the two per
 * key: secrets travel as envelopes, non-sensitive config (locale, paths,
 * public IDs, …) travels as plain strings.
 */
export const MCPSecretValueSchema = z.union([
  z.string().max(Limits.MAX_ENV_VAR_VALUE_LENGTH),
  EncryptedSecretEnvelopeSchema,
]);

export type MCPSecretValue = z.infer<typeof MCPSecretValueSchema>;

/**
 * Schema for encrypted secrets - a record of key names to encrypted envelopes.
 * Used to pass profile secrets securely from backend to cloud-agent worker.
 */
export const EncryptedSecretsSchema = z
  .record(z.string().max(Limits.MAX_ENV_VAR_KEY_LENGTH), EncryptedSecretEnvelopeSchema)
  .refine(obj => Object.keys(obj).length <= Limits.MAX_ENV_VARS, {
    message: `Maximum ${Limits.MAX_ENV_VARS} encrypted secrets allowed`,
  });

export type EncryptedSecrets = z.infer<typeof EncryptedSecretsSchema>;

export const branchNameSchema = z
  .string()
  .min(1, 'Branch name cannot be empty')
  .max(255, 'Branch name too long')
  .regex(
    /^[a-zA-Z0-9._\-/]+$/,
    'Branch name can only contain alphanumeric characters, dots, dashes, underscores, and slashes'
  );

export const modelIdSchema = z
  .string()
  .min(1, 'Model ID cannot be empty')
  .max(255, 'Model ID too long')
  .regex(
    /^[a-zA-Z0-9._\-/:]+$/,
    'Model ID can only contain alphanumeric characters, dots, dashes, underscores, slashes, and colons'
  );

/**
 * Local MCP server configuration schema (runs a command).
 * Each env value is either a plain string or an encrypted envelope; the
 * worker decrypts envelope-shaped values per key when materializing the
 * `KILO_CONFIG_CONTENT.mcp` block for the sandbox session.
 */
const MCPLocalServerConfigSchema = z
  .object({
    type: z.literal('local'),
    command: z.string().array().min(1, 'Command array must have at least one element'),
    environment: z.record(z.string(), MCPSecretValueSchema).optional(),
    enabled: z.boolean().optional(),
    timeout: z.number().min(1).max(3_600_000).optional(),
  })
  .strict();

/**
 * Remote MCP server configuration schema (connects to a URL).
 * Each header value is either a plain string or an encrypted envelope; the
 * worker decrypts envelope-shaped values per key when materializing the
 * `KILO_CONFIG_CONTENT.mcp` block for the sandbox session.
 */
const MCPRemoteServerConfigSchema = z
  .object({
    type: z.literal('remote'),
    url: z.string().url('URL must be a valid URL format'),
    headers: z.record(z.string(), MCPSecretValueSchema).optional(),
    enabled: z.boolean().optional(),
    timeout: z.number().min(1).max(3_600_000).optional(),
  })
  .strict();

/**
 * MCP Server configuration schema — CLI-native local/remote discriminated union.
 */
export const MCPServerConfigSchema = z.discriminatedUnion('type', [
  MCPLocalServerConfigSchema,
  MCPRemoteServerConfigSchema,
]);

const SKILL_FILE_PATH_PATTERN = /^[a-zA-Z0-9._\-/]+$/;

/** Validate a map of companion files bundled with a skill. */
const RuntimeSkillFilesSchema = z
  .record(
    z.string().min(1).max(Limits.MAX_RUNTIME_SKILL_COMPANION_PATH_LENGTH),
    z.string().max(Limits.MAX_RUNTIME_SKILL_COMPANION_FILE_SIZE)
  )
  .refine(
    files => Object.keys(files).length <= Limits.MAX_RUNTIME_SKILL_COMPANION_FILES,
    `A skill may have at most ${Limits.MAX_RUNTIME_SKILL_COMPANION_FILES} companion files`
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
    if (total > Limits.MAX_RUNTIME_SKILL_COMPANION_FILES_TOTAL) {
      ctx.addIssue({
        code: 'custom',
        message: `Skill companion files total ${total} bytes, exceeds ${Limits.MAX_RUNTIME_SKILL_COMPANION_FILES_TOTAL}`,
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
    .max(Limits.MAX_RUNTIME_SKILL_NAME_LENGTH)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Skill name must be a slug'),
  rawMarkdown: z.string().min(1).max(Limits.MAX_RUNTIME_SKILL_MARKDOWN),
  files: RuntimeSkillFilesSchema.optional(),
});

export const RuntimeSkillsSchema = z
  .array(RuntimeSkillSchema)
  .max(Limits.MAX_RUNTIME_SKILLS, `Maximum ${Limits.MAX_RUNTIME_SKILLS} runtime skills allowed`);

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
    .max(Limits.MAX_RUNTIME_AGENT_SLUG_LENGTH)
    .regex(/^[a-z][a-z0-9-]*$/, 'Agent slug must start with a letter')
    .refine(slug => !BUILTIN_AGENT_MODES.has(slug), {
      message: 'Slug conflicts with a built-in agent; choose a different slug',
    }),
  name: z.string().min(1).max(Limits.MAX_RUNTIME_AGENT_NAME_LENGTH),
  config: z
    .object({
      prompt: z.string().max(Limits.MAX_RUNTIME_AGENT_PROMPT).optional(),
      description: z.string().max(Limits.MAX_RUNTIME_AGENT_DESCRIPTION).optional(),
      mode: z.enum(['subagent', 'primary', 'all']).optional(),
      model: z.string().max(Limits.MAX_RUNTIME_AGENT_MODEL_LENGTH).nullable().optional(),
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
  .max(Limits.MAX_RUNTIME_AGENTS, `Maximum ${Limits.MAX_RUNTIME_AGENTS} runtime agents allowed`);

export type RuntimeAgentInput = z.infer<typeof RuntimeAgentSchema>;

// --- Runtime kilo commands ---

export const RuntimeKiloCommandSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(Limits.MAX_RUNTIME_KILO_COMMAND_NAME_LENGTH)
    .regex(/^[a-z][a-z0-9-]*$/, 'Command name must start with a letter and be a slug'),
  template: z.string().min(1).max(Limits.MAX_RUNTIME_KILO_COMMAND_TEMPLATE),
  description: z.string().max(Limits.MAX_RUNTIME_KILO_COMMAND_DESCRIPTION).nullable().optional(),
  agent: z.string().max(Limits.MAX_RUNTIME_AGENT_SLUG_LENGTH).nullable().optional(),
  model: z.string().max(Limits.MAX_RUNTIME_AGENT_MODEL_LENGTH).nullable().optional(),
  subtask: z.boolean().optional(),
});

export const RuntimeKiloCommandsSchema = z
  .array(RuntimeKiloCommandSchema)
  .max(
    Limits.MAX_RUNTIME_KILO_COMMANDS,
    `Maximum ${Limits.MAX_RUNTIME_KILO_COMMANDS} runtime kilo commands allowed`
  );

export type RuntimeKiloCommandInput = z.infer<typeof RuntimeKiloCommandSchema>;

/** Discriminated payload for the initial execution on a newly-prepared session. */
export const InitialExecutionPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('prompt'),
    prompt: z.string().min(1),
    mode: z.string().min(1),
    model: z.string().min(1),
    variant: z
      .string()
      .max(50)
      .regex(/^[a-zA-Z]+$/)
      .optional(),
  }),
  z.object({
    type: z.literal('command'),
    command: z.string().min(1),
    arguments: z.string().default(''),
  }),
]);

export type InitialExecutionPayload = z.infer<typeof InitialExecutionPayloadSchema>;

// --- Profile bundle ---

/**
 * Schema for the profile-derived configuration bundle persisted with a
 * session. Writers always emit this nested shape; readers prefer it but
 * fall back to the legacy flat fields (`envVars`, `encryptedSecrets`, …)
 * co-located on the same record for backwards compatibility with sessions
 * stored before the nesting landed.
 *
 * The flat read-fallback can be deleted once all live sessions have been
 * rewritten with the nested `profile` key (typically a few weeks of
 * session TTL after deploy).
 */
export const SessionProfileBundleSchema = z.object({
  envVars: z
    .record(z.string().max(256), z.string().max(256))
    .refine(obj => Object.keys(obj).length <= 50, {
      message: 'Maximum 50 environment variables allowed',
    })
    .optional(),
  encryptedSecrets: EncryptedSecretsSchema.optional(),
  setupCommands: z.array(z.string().max(500)).max(Limits.MAX_SETUP_COMMANDS).optional(),
  mcpServers: z
    .record(z.string().max(100), MCPServerConfigSchema)
    .refine(obj => Object.keys(obj).length <= Limits.MAX_MCP_SERVERS, {
      message: `Maximum ${Limits.MAX_MCP_SERVERS} MCP servers allowed`,
    })
    .optional(),
  runtimeSkills: RuntimeSkillsSchema.optional(),
  runtimeAgents: RuntimeAgentsSchema.optional(),
  kiloCommands: RuntimeKiloCommandsSchema.optional(),
});

export type SessionProfileBundle = z.infer<typeof SessionProfileBundleSchema>;

/**
 * Zod schema for CloudAgentSession metadata validation.
 * Used for both DO storage and restoration validation.
 */
export const MetadataSchema = z.object({
  version: z.number(),
  sessionId: z.string(),
  orgId: z.string().optional(),
  userId: z.string(),
  botId: z.string().optional(),
  kilocodeToken: z.string().optional(),
  timestamp: z.number(),
  githubRepo: z.string().optional(),
  githubToken: z.string().optional(),
  githubInstallationId: z.string().optional(),
  githubAppType: z.enum(['standard', 'lite']).optional(),
  gitUrl: z.string().optional(),
  gitToken: z.string().optional(),
  platform: z.enum(['github', 'gitlab']).optional(),
  gitlabTokenManaged: z.boolean().optional(),
  /**
   * Profile-derived configuration (envVars, encryptedSecrets, MCP servers,
   * setup commands, runtime skills/agents). This nested form is what
   * writers emit; the flat fields below are kept optional so that records
   * written before this key existed still parse. Readers must go through
   * `readProfileBundle` so the fallback stays in one place.
   */
  profile: SessionProfileBundleSchema.optional(),
  // --- Legacy flat profile fields (read-only fallback, no longer written) ---
  envVars: z
    .record(z.string().max(256), z.string().max(256))
    .refine(obj => Object.keys(obj).length <= 50, {
      message: 'Maximum 50 environment variables allowed',
    })
    .optional(),
  encryptedSecrets: EncryptedSecretsSchema.optional(),
  setupCommands: z.array(z.string().max(500)).max(Limits.MAX_SETUP_COMMANDS).optional(),
  mcpServers: z
    .record(z.string().max(100), MCPServerConfigSchema)
    .refine(obj => Object.keys(obj).length <= Limits.MAX_MCP_SERVERS, {
      message: `Maximum ${Limits.MAX_MCP_SERVERS} MCP servers allowed`,
    })
    .optional(),
  runtimeSkills: RuntimeSkillsSchema.optional(),
  runtimeAgents: RuntimeAgentsSchema.optional(),
  upstreamBranch: branchNameSchema.optional(),
  kiloSessionId: z.string().optional(),
  createdOnPlatform: z.string().max(100).optional(),

  // Execution params
  prompt: z.string().max(Limits.MAX_PROMPT_LENGTH).optional(),
  // Mode accepts built-in slugs plus any custom slug from runtimeAgents.
  mode: z.string().max(Limits.MAX_RUNTIME_AGENT_SLUG_LENGTH).optional(),
  model: z.string().optional(),
  variant: z
    .string()
    .max(50)
    .regex(/^[a-zA-Z]+$/)
    .optional(),
  autoCommit: z.boolean().optional(),
  condenseOnComplete: z.boolean().optional(),
  appendSystemPrompt: z.string().max(10000).optional(),
  gateThreshold: z.enum(['off', 'all', 'warning', 'critical']).optional(),

  // Lifecycle
  preparedAt: z.number().optional(),
  initiatedAt: z.number().optional(),

  // Callback configuration
  callbackTarget: CallbackTargetSchema.optional(),

  // Image attachments
  images: ImagesSchema.optional(),

  // Kilo server lifecycle tracking
  kiloServerLastActivity: z.number().optional(),

  // Workspace metadata (set during prepareSession)
  workspacePath: z.string().optional(),
  sessionHome: z.string().optional(),
  branchName: z.string().optional(),
  sandboxId: z
    .string()
    .refine(
      s => /^(ses|org|usr|bot|ubt)-[0-9a-f]+$/.test(s) || s.includes('__'),
      'Invalid sandboxId format'
    )
    .transform(s => s as SandboxId)
    .optional(),

  // Initial message ID for correlation
  initialMessageId: z.string().startsWith('msg_').length(30).optional(),

  // Discriminated payload for the first execution (prompt or command)
  initialPayload: InitialExecutionPayloadSchema.optional(),
});

/**
 * Schema for async preparation input stored in DO storage.
 * Single source of truth for the shape of data passed between
 * startPreparationAsync (write) and runPreparationAsync (read via alarm).
 */
export const PreparationInputSchema = z.object({
  // Session identity
  sessionId: z.string(),
  kiloSessionId: z.string().optional(),
  userId: z.string(),
  orgId: z.string().optional(),
  botId: z.string().optional(),
  // Auth
  authToken: z.string(),
  // Git source
  githubRepo: z.string().optional(),
  githubToken: z.string().optional(),
  gitUrl: z.string().optional(),
  gitToken: z.string().optional(),
  platform: z.enum(['github', 'gitlab']).optional(),
  // Set to true when gitToken was resolved by the caller via the managed
  // GitLab integration (git-token-service). Signals that async prep should
  // NOT re-resolve the token, avoiding a refresh-token rotation race
  // between the caller and the alarm.
  gitlabTokenManaged: z.boolean().optional(),
  // Execution params
  prompt: z.string(),
  mode: z.string(),
  model: z.string(),
  variant: z.string().optional(),
  // Profile-derived configuration (nested form — what writers emit).
  profile: SessionProfileBundleSchema.optional(),
  // Legacy flat profile fields (read-only fallback, no longer written).
  envVars: z.record(z.string(), z.string()).optional(),
  encryptedSecrets: EncryptedSecretsSchema.optional(),
  setupCommands: z.array(z.string()).optional(),
  mcpServers: z.record(z.string(), MCPServerConfigSchema).optional(),
  runtimeSkills: RuntimeSkillsSchema.optional(),
  runtimeAgents: RuntimeAgentsSchema.optional(),
  kiloCommands: RuntimeKiloCommandsSchema.optional(),
  upstreamBranch: z.string().optional(),
  autoCommit: z.boolean().optional(),
  condenseOnComplete: z.boolean().optional(),
  appendSystemPrompt: z.string().optional(),
  callbackTarget: CallbackTargetSchema.optional(),
  images: ImagesSchema.optional(),
  createdOnPlatform: z.string().optional(),
  shallow: z.boolean().optional(),
  gateThreshold: z.enum(['off', 'all', 'warning', 'critical']).optional(),
  kilocodeOrganizationId: z.string().optional(),
  // Auto-initiate after preparation
  autoInitiate: z.boolean(),

  initialMessageId: z.string().optional(),

  // Discriminated payload for the first execution (prompt or command)
  initialPayload: InitialExecutionPayloadSchema.optional(),
});

export type PreparationInput = z.infer<typeof PreparationInputSchema>;
