import {
  RuntimeSkillsSchema,
  RuntimeAgentsSchema,
  RuntimeKiloCommandsSchema,
} from '../shared/runtime-profile.js';
export * from '../shared/runtime-profile.js';
import * as z from 'zod';
import { MESSAGE_ID_FORMAT_DESCRIPTION, MESSAGE_ID_PATTERN } from '../session/message-id.js';
import { Limits } from '../schema.js';
import { isValidSandboxId } from '../sandbox-id.js';
import type { SandboxId } from '../types.js';

/**
 * Attachment filename extension deny-list shared by every worker-layer
 * validator (persistence schema, runtime download helper). Centralized here
 * so the worker never ships a path that the storage layer would later
 * reject.
 */
export const CLOUD_AGENT_ATTACHMENT_DENIED_EXTENSIONS = [
  'exe',
  'dll',
  'msi',
  'com',
  'scr',
  'apk',
  'ipa',
  'dmg',
  'pkg',
] as const;

const CLOUD_AGENT_DENIED_EXTENSION_SET = new Set<string>(CLOUD_AGENT_ATTACHMENT_DENIED_EXTENSIONS);

/**
 * Schema for callback target configuration.
 * Defined here to avoid circular dependency with router/schemas.ts.
 */
export const CallbackTargetSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

/**
 * R2 attachment descriptors carry only server-issued names. The worker derives
 * service/user prefixes and never accepts caller-provided object key prefixes.
 */
const attachmentMessageUuidSchema = z
  .string()
  .uuid()
  .describe('Bare message upload UUID; service prefix is derived by the worker');

/**
 * Filename regex shape for stored attachments. The relaxed post-S2 surface
 * accepts any `^[a-z0-9]{1,16}$` suffix after the UUID prefix. The deny-list
 * is enforced as a refinement.
 */
const ATTACHMENT_RELAXED_FILENAME_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.[a-z0-9]{1,16}$/;

const attachmentFilenameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    ATTACHMENT_RELAXED_FILENAME_REGEX,
    'Attachment filename must be a UUID with a 1-16 character lowercase alphanumeric extension'
  )
  .superRefine((filename, ctx) => {
    const suffix = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
    if (CLOUD_AGENT_DENIED_EXTENSION_SET.has(suffix)) {
      ctx.addIssue({
        code: 'custom',
        message: `Attachment extension "${suffix}" is not allowed`,
      });
    }
  });

export const AttachmentsSchema = z.object({
  path: attachmentMessageUuidSchema,
  files: z
    .array(attachmentFilenameSchema)
    .min(1)
    .max(5)
    .describe('Ordered array of specific UUID attachment filenames to download'),
});
export type Attachments = z.infer<typeof AttachmentsSchema>;

const imageFilenameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(png|jpg|jpeg|webp|gif)$/,
    'Image filename must be a UUID with extension png, jpg, jpeg, webp, or gif'
  );

/** Legacy public image decoder retained only for API request compatibility. */
export const ImagesSchema = z.object({
  path: attachmentMessageUuidSchema,
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

const forbiddenGitBranchCharacters = new Set(['~', '^', ':', '?', '*', '[', '\\', "'"]);

function containsForbiddenGitBranchCharacter(value: string): boolean {
  for (const character of value) {
    const charCode = character.charCodeAt(0);
    if (charCode <= 32 || charCode === 127 || forbiddenGitBranchCharacters.has(character)) {
      return true;
    }
  }

  return false;
}

function isShellSafeGitBranchName(value: string): boolean {
  if (value === '@') return false;
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) return false;
  if (value.endsWith('.') || value.includes('..') || value.includes('//')) return false;
  if (value.includes('@{') || containsForbiddenGitBranchCharacter(value)) return false;

  return value
    .split('/')
    .every(segment => segment.length > 0 && !segment.startsWith('.') && !segment.endsWith('.lock'));
}

export const branchNameSchema = z
  .string()
  .min(1, 'Branch name cannot be empty')
  .max(255, 'Branch name too long')
  .refine(
    isShellSafeGitBranchName,
    'Branch name must be a valid shell-safe Git branch or review ref'
  );

export const modelIdSchema = z
  .string()
  .min(1, 'Model ID cannot be empty')
  .max(255, 'Model ID too long')
  .regex(
    /^[a-zA-Z0-9._\-/:~]+$/,
    'Model ID can only contain alphanumeric characters, dots, dashes, underscores, slashes, colons, and tildes'
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
 * session. Current metadata stores this under the nested `profile` key.
 * Legacy flat profile fields are normalized by `parseSessionMetadata`.
 */
const SharedSessionProfileFields = {
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
};

export const SessionProfileBundleSchema = z.object({
  ...SharedSessionProfileFields,
  kiloCommands: RuntimeKiloCommandsSchema.optional(),
});

export type SessionProfileBundle = z.infer<typeof SessionProfileBundleSchema>;

/**
 * Legacy flat CloudAgentSession metadata schema.
 * Current storage reads and writes go through `session-metadata.ts`, which
 * converts this shape to the grouped SessionMetadata boundary type.
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
   * older grouped profile form. Current metadata uses the schema in
   * `session-metadata.ts`; the flat fields below are retained only for
   * legacy record parsing.
   */
  profile: SessionProfileBundleSchema.optional(),
  // --- Legacy flat profile fields (read-only fallback, no longer written) ---
  ...SharedSessionProfileFields,
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
  shallow: z.boolean().optional(),
  gateThreshold: z.enum(['off', 'all', 'warning', 'critical']).optional(),

  // Lifecycle
  preparedAt: z.number().optional(),
  initiatedAt: z.number().optional(),

  // Callback configuration
  callbackTarget: CallbackTargetSchema.optional(),

  // Kilo server lifecycle tracking
  kiloServerLastActivity: z.number().optional(),

  // Workspace metadata (set during prepareSession)
  workspacePath: z.string().optional(),
  sessionHome: z.string().optional(),
  branchName: z.string().optional(),
  sandboxId: z
    .string()
    .refine(isValidSandboxId, 'Invalid sandboxId format')
    .transform(s => s as SandboxId)
    .optional(),
  devcontainer: z
    .object({
      workspacePath: z.string(),
      innerWorkspaceFolder: z.string(),
      wrapperPort: z.number().int().min(1).max(65535),
      configPath: z.string(),
    })
    .optional(),

  // Initial message ID for correlation
  initialMessageId: z.string().regex(MESSAGE_ID_PATTERN, MESSAGE_ID_FORMAT_DESCRIPTION).optional(),

  // Discriminated payload for the first execution (prompt or command)
  initialPayload: InitialExecutionPayloadSchema.optional(),
});
