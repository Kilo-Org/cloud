import * as z from 'zod';
import { AgentModeSchema, Limits } from '../schema.js';

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
export const ImagesSchema = z.object({
  path: z.string().min(1).describe('R2 path prefix under the user ID'),
  files: z
    .array(z.string().min(1))
    .min(1)
    .describe('Ordered array of specific filenames to download'),
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

/**
 * Base configuration schema shared by all MCP server types
 */
const MCPServerBaseConfigSchema = z.object({
  disabled: z.boolean().optional(),
  timeout: z.number().min(1).max(3600).optional().default(60),
  alwaysAllow: z.array(z.string()).default([]),
  watchPaths: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).default([]),
});

export const MCPStdioServerConfigSchema = MCPServerBaseConfigSchema.extend({
  type: z.enum(['stdio']).optional(),
  command: z.string().min(1, 'Command cannot be empty'),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  // Field contamination prevention
  url: z.undefined().optional(),
  headers: z.undefined().optional(),
}).transform(data => ({
  ...data,
  type: 'stdio' as const,
}));

export const MCPSseServerConfigSchema = MCPServerBaseConfigSchema.extend({
  type: z.enum(['sse']),
  url: z.string().url('URL must be a valid URL format'),
  headers: z.record(z.string(), z.string()).optional(),
  // Field contamination prevention
  command: z.undefined().optional(),
  args: z.undefined().optional(),
  env: z.undefined().optional(),
  cwd: z.undefined().optional(),
}).transform(data => ({
  ...data,
  type: 'sse' as const,
}));

export const MCPStreamableHttpServerConfigSchema = MCPServerBaseConfigSchema.extend({
  type: z.enum(['streamable-http']),
  url: z.string().url('URL must be a valid URL format'),
  headers: z.record(z.string(), z.string()).optional(),
  // Field contamination prevention
  command: z.undefined().optional(),
  args: z.undefined().optional(),
  env: z.undefined().optional(),
  cwd: z.undefined().optional(),
}).transform(data => ({
  ...data,
  type: 'streamable-http' as const,
}));

/**
 * MCP Server configuration schema supporting three transport types:
 * - stdio: local process execution
 * - sse: Server-Sent Events
 * - streamable-http: HTTP streaming
 */
export const MCPServerConfigSchema = z.union([
  MCPStdioServerConfigSchema,
  MCPSseServerConfigSchema,
  MCPStreamableHttpServerConfigSchema,
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

  // Execution params
  prompt: z.string().max(Limits.MAX_PROMPT_LENGTH).optional(),
  mode: AgentModeSchema.optional(),
  model: z.string().optional(),
  autoCommit: z.boolean().optional(),
  condenseOnComplete: z.boolean().optional(),
  appendSystemPrompt: z.string().max(10000).optional(),

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
  sandboxId: z.string().optional(),
});
