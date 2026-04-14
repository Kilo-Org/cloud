import * as z from 'zod';
import { AgentModeSchema, Limits } from '../schema.js';
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
 */
const MCPLocalServerConfigSchema = z
  .object({
    type: z.literal('local'),
    command: z.string().array().min(1, 'Command array must have at least one element'),
    environment: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    timeout: z.number().min(1).max(3_600_000).optional(),
  })
  .strict();

/**
 * Remote MCP server configuration schema (connects to a URL).
 */
const MCPRemoteServerConfigSchema = z
  .object({
    type: z.literal('remote'),
    url: z.string().url('URL must be a valid URL format'),
    headers: z.record(z.string(), z.string()).optional(),
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
  envVars: z
    .record(z.string().max(256), z.string().max(256))
    .refine(obj => Object.keys(obj).length <= 50, {
      message: 'Maximum 50 environment variables allowed',
    })
    .optional(),
  // Encrypted secrets from agent environment profiles.
  // Keys are env var names, values are encrypted envelopes.
  // Stored encrypted, decrypted only at execution time.
  encryptedSecrets: EncryptedSecretsSchema.optional(),
  setupCommands: z.array(z.string().max(500)).max(Limits.MAX_SETUP_COMMANDS).optional(),
  mcpServers: z
    .record(z.string().max(100), MCPServerConfigSchema)
    .refine(obj => Object.keys(obj).length <= Limits.MAX_MCP_SERVERS, {
      message: `Maximum ${Limits.MAX_MCP_SERVERS} MCP servers allowed`,
    })
    .optional(),
  upstreamBranch: branchNameSchema.optional(),
  kiloSessionId: z.string().optional(),
  createdOnPlatform: z.string().max(100).optional(),

  // Execution params
  prompt: z.string().max(Limits.MAX_PROMPT_LENGTH).optional(),
  mode: AgentModeSchema.optional(),
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
  // Execution params
  prompt: z.string(),
  mode: z.string(),
  model: z.string(),
  variant: z.string().optional(),
  // Configuration
  envVars: z.record(z.string(), z.string()).optional(),
  encryptedSecrets: EncryptedSecretsSchema.optional(),
  setupCommands: z.array(z.string()).optional(),
  mcpServers: z.record(z.string(), MCPServerConfigSchema).optional(),
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
});

export type PreparationInput = z.infer<typeof PreparationInputSchema>;
