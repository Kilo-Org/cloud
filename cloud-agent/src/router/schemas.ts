import * as z from 'zod';
import { sessionIdSchema, githubRepoSchema, gitUrlSchema, envVarsSchema } from '../types.js';
import {
  MCPServerConfigSchema,
  branchNameSchema,
  EncryptedSecretEnvelopeSchema,
  EncryptedSecretsSchema,
  CallbackTargetSchema,
} from '../persistence/schemas.js';
import { AgentModeSchema, Limits } from '../schema.js';

// Re-export schemas from types.ts and persistence/schemas.ts for convenience
export { sessionIdSchema, githubRepoSchema, gitUrlSchema, envVarsSchema };
export { MCPServerConfigSchema, branchNameSchema };
export { AgentModeSchema, Limits };
export { EncryptedSecretEnvelopeSchema, EncryptedSecretsSchema, CallbackTargetSchema };

// Re-export types
export type { EncryptedSecretEnvelope, EncryptedSecrets } from '../persistence/schemas.js';

/**
 * Schema for image attachments that will be downloaded from R2 to the sandbox.
 * Images are stored in R2 at path: {bucket}/{userId}/{path}/{filename}
 */
export const ImagesSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('R2 path prefix under the user ID (e.g., "app-builder/msg-uuid")'),
  files: z
    .array(z.string().min(1))
    .min(1)
    .describe('Ordered array of specific filenames to download'),
});
export type Images = z.infer<typeof ImagesSchema>;

/**
 * Base prompt payload schema used by all execution endpoints.
 * Contains the essential fields for Kilocode execution.
 */
export const PromptPayload = z.object({
  prompt: z.string().min(1, 'Prompt is required').describe('The task prompt for Kilo Code'),
  mode: z
    .enum(['architect', 'code', 'ask', 'debug', 'orchestrator'])
    .describe('Kilo Code execution mode (required)'),
  model: z.string().min(1, 'Model is required').describe('AI model to use (required)'),
});

/**
 * Shared validation: ensure exactly one of githubRepo or gitUrl is provided.
 * Used in .refine() for input schemas that support both git sources.
 */
export function validateGitSource<T extends { githubRepo?: unknown; gitUrl?: unknown }>(
  data: T
): boolean {
  const hasGithubRepo = !!data.githubRepo;
  const hasGitUrl = !!data.gitUrl;
  return (hasGithubRepo || hasGitUrl) && !(hasGithubRepo && hasGitUrl);
}

/**
 * Input schema for initiateSessionStream endpoint.
 * Supports both GitHub repos and generic git URLs.
 */
export const InitiateSessionInput = z
  .object({
    githubRepo: githubRepoSchema
      .optional()
      .describe('GitHub repository in format org/repo (mutually exclusive with gitUrl)'),
    kilocodeOrganizationId: z.uuid().optional().describe('Organization ID (UUID, optional)'),
    githubToken: z
      .string()
      .optional()
      .describe('GitHub Personal Access Token for private repositories (optional)'),
    gitUrl: gitUrlSchema
      .optional()
      .describe(
        'Generic git repository HTTPS URL (mutually exclusive with githubRepo, e.g., https://gitlab.com/org/repo.git)'
      ),
    gitToken: z
      .string()
      .optional()
      .describe(
        'Git token for authentication with generic git repos (username is always x-access-token)'
      ),
    platform: z
      .enum(['github', 'gitlab'])
      .optional()
      .describe('Git platform type for correct token/env var handling'),
    envVars: envVarsSchema
      .optional()
      .describe(
        'Optional environment variables to inject into the session (max 50 vars, keys and values max 256 chars)'
      ),
    setupCommands: z
      .array(z.string().max(Limits.MAX_SETUP_COMMAND_LENGTH))
      .max(Limits.MAX_SETUP_COMMANDS)
      .optional()
      .describe(
        `Optional setup commands to run during session initialization (max ${Limits.MAX_SETUP_COMMANDS} commands, each max ${Limits.MAX_SETUP_COMMAND_LENGTH} chars)`
      ),
    mcpServers: z
      .record(z.string().max(100), MCPServerConfigSchema)
      .refine(obj => Object.keys(obj).length <= Limits.MAX_MCP_SERVERS, {
        message: `Maximum ${Limits.MAX_MCP_SERVERS} MCP servers allowed`,
      })
      .optional()
      .describe('Optional MCP server configurations to set up during session initialization'),
    upstreamBranch: branchNameSchema
      .optional()
      .describe('Optional upstream branch to checkout during session initialization'),
    autoCommit: z
      .boolean()
      .optional()
      .default(false)
      .describe('Automatically commit and push changes after execution'),
    condenseOnComplete: z
      .boolean()
      .optional()
      .default(false)
      .describe('Automatically condense context after execution completes'),
    appendSystemPrompt: z
      .string()
      .max(10000)
      .optional()
      .describe('Custom text to append to the system prompt'),
    createdOnPlatform: z
      .string()
      .max(100)
      .optional()
      .describe(
        'Platform identifier for session creation (e.g., "slack", "cloud-agent"). Defaults to "cloud-agent" if not specified.'
      ),
    images: ImagesSchema.optional().describe(
      'Optional image attachments to download from R2 to the sandbox'
    ),
  })
  .extend(PromptPayload.shape)
  .refine(validateGitSource, {
    message: 'Must provide either githubRepo or gitUrl, but not both',
    path: ['githubRepo'],
  });

/**
 * Input schema for initiateFromKilocodeSession endpoint (LEGACY mode).
 * Used when resuming an existing Kilo CLI session with all params provided.
 * Note: No upstreamBranch parameter - kilo session manages its own branch state.
 */
export const InitiateFromKiloSessionInput = z
  .object({
    kiloSessionId: z.string().uuid().describe('Existing Kilo CLI session ID to resume'),
    githubRepo: githubRepoSchema.describe('GitHub repository in format org/repo (required)'),
    kilocodeOrganizationId: z
      .string()
      .uuid()
      .optional()
      .describe('Organization ID (UUID, optional)'),
    githubToken: z
      .string()
      .optional()
      .describe('GitHub Personal Access Token for private repositories (optional)'),
    envVars: envVarsSchema
      .optional()
      .describe('Optional environment variables to inject into the session'),
    setupCommands: z
      .array(z.string().max(Limits.MAX_SETUP_COMMAND_LENGTH))
      .max(Limits.MAX_SETUP_COMMANDS)
      .optional()
      .describe(
        `Optional setup commands to run during session initialization (max ${Limits.MAX_SETUP_COMMANDS} commands, each max ${Limits.MAX_SETUP_COMMAND_LENGTH} chars)`
      ),
    mcpServers: z
      .record(z.string().max(100), MCPServerConfigSchema)
      .refine(obj => Object.keys(obj).length <= Limits.MAX_MCP_SERVERS, {
        message: `Maximum ${Limits.MAX_MCP_SERVERS} MCP servers allowed`,
      })
      .optional()
      .describe('Optional MCP server configurations'),
    autoCommit: z
      .boolean()
      .optional()
      .default(false)
      .describe('Automatically commit and push changes after execution'),
    condenseOnComplete: z
      .boolean()
      .optional()
      .default(false)
      .describe('Automatically condense context after execution completes'),
    appendSystemPrompt: z
      .string()
      .max(10000)
      .optional()
      .describe('Custom text to append to the system prompt'),
  })
  .extend(PromptPayload.shape);

/**
 * NEW: Input schema for initiateFromKilocodeSession with prepared sessions.
 * Client provides only cloudAgentSessionId - all other params come from DO metadata.
 */
export const InitiateFromPreparedSessionInput = z.object({
  cloudAgentSessionId: sessionIdSchema.describe('Cloud-agent session ID from prepareSession'),
});

/**
 * Combined schema supporting both legacy and prepared session flows.
 * Uses discriminated union based on presence of 'prompt' field:
 * - With 'prompt': Legacy mode (full params)
 * - Without 'prompt': Prepared session mode (cloudAgentSessionId only)
 */
export const InitiateFromKiloSessionInputCombined = z.union([
  InitiateFromPreparedSessionInput,
  InitiateFromKiloSessionInput,
]);

/**
 * Input schema for initiateSessionAsync endpoint.
 * Identical to InitiateSessionInput but with required callback fields
 * for fire-and-forget scenarios.
 */
export const InitiateSessionAsyncInput = z
  .object({
    // Base session fields
    githubRepo: githubRepoSchema
      .optional()
      .describe('GitHub repository in format org/repo (mutually exclusive with gitUrl)'),
    kilocodeOrganizationId: z.uuid().optional().describe('Organization ID (UUID, optional)'),
    githubToken: z
      .string()
      .optional()
      .describe('GitHub Personal Access Token for private repositories (optional)'),
    gitUrl: gitUrlSchema
      .optional()
      .describe(
        'Generic git repository HTTPS URL (mutually exclusive with githubRepo, e.g., https://gitlab.com/org/repo.git)'
      ),
    gitToken: z
      .string()
      .optional()
      .describe(
        'Git token for authentication with generic git repos (username is always x-access-token)'
      ),
    platform: z
      .enum(['github', 'gitlab'])
      .optional()
      .describe('Git platform type for correct token/env var handling'),
    envVars: envVarsSchema
      .optional()
      .describe(
        'Optional environment variables to inject into the session (max 50 vars, keys and values max 256 chars)'
      ),
    setupCommands: z
      .array(z.string().max(Limits.MAX_SETUP_COMMAND_LENGTH))
      .max(Limits.MAX_SETUP_COMMANDS)
      .optional()
      .describe(
        `Optional setup commands to run during session initialization (max ${Limits.MAX_SETUP_COMMANDS} commands, each max ${Limits.MAX_SETUP_COMMAND_LENGTH} chars)`
      ),
    mcpServers: z
      .record(z.string().max(100), MCPServerConfigSchema)
      .refine(obj => Object.keys(obj).length <= Limits.MAX_MCP_SERVERS, {
        message: `Maximum ${Limits.MAX_MCP_SERVERS} MCP servers allowed`,
      })
      .optional()
      .describe('Optional MCP server configurations to set up during session initialization'),
    upstreamBranch: branchNameSchema
      .optional()
      .describe('Optional upstream branch to checkout during session initialization'),
    autoCommit: z
      .union([z.boolean(), z.string().transform(s => s === 'true')])
      .optional()
      .default(false)
      .describe('Automatically commit and push changes after execution'),
    condenseOnComplete: z
      .union([z.boolean(), z.string().transform(s => s === 'true')])
      .optional()
      .default(false)
      .describe('Automatically condense context after execution completes'),
    appendSystemPrompt: z
      .string()
      .max(10000)
      .optional()
      .describe('Custom text to append to the system prompt'),
    createdOnPlatform: z
      .string()
      .max(100)
      .optional()
      .describe(
        'Platform identifier for session creation (e.g., "slack", "cloud-agent"). Defaults to "cloud-agent" if not specified.'
      ),
    images: ImagesSchema.optional().describe(
      'Optional image attachments to download from R2 to the sandbox'
    ),
    // Prompt fields
    prompt: z.string().min(1, 'Prompt is required').describe('The task prompt for Kilo Code'),
    mode: z
      .enum(['architect', 'code', 'ask', 'debug', 'orchestrator'])
      .describe('Kilo Code execution mode (required)'),
    model: z.string().min(1, 'Model is required').describe('AI model to use (required)'),
    // Callback fields (required for async)
    callbackUrl: z.string().url().describe('URL to POST completion/error notification to'),
    callbackHeaders: z
      .record(z.string(), z.string())
      .optional()
      .describe('Optional headers for callback request (auth tokens, etc.)'),
  })
  .refine(validateGitSource, {
    message: 'Must provide either githubRepo or gitUrl, but not both',
    path: ['githubRepo'],
  });

/**
 * Input schema for sendMessageStream endpoint.
 * Used to send a message/prompt to an existing established session.
 */
export const SendMessageInput = z
  .object({
    sessionId: sessionIdSchema.describe('Session ID from initiateSession'),
    autoCommit: z
      .boolean()
      .optional()
      .default(false)
      .describe('Automatically commit and push changes after execution'),
    githubToken: z
      .string()
      .optional()
      .describe(
        'GitHub Personal Access Token - if provided and applicable, updates the session token and git remote. Ignored for generic git repos.'
      ),
    gitToken: z
      .string()
      .optional()
      .describe(
        'Git token for authentication - if provided and session uses gitUrl, updates the session token and git remote. Ignored for GitHub repos.'
      ),
    images: ImagesSchema.optional().describe(
      'Optional image attachments to download from R2 to the sandbox'
    ),
  })
  .extend(PromptPayload.shape);

/**
 * V2 input schema for sendMessageV2 endpoint.
 * Uses cloudAgentSessionId naming for consistency with prepare/initiate V2.
 */
export const SendMessageV2Input = z
  .object({
    cloudAgentSessionId: sessionIdSchema.describe(
      'Cloud agent session ID (required for V2 endpoints)'
    ),
    autoCommit: z
      .boolean()
      .optional()
      .default(false)
      .describe('Automatically commit and push changes after execution'),
    condenseOnComplete: z
      .boolean()
      .optional()
      .default(false)
      .describe('Automatically condense context after execution completes'),
    appendSystemPrompt: z
      .string()
      .max(10000)
      .optional()
      .describe('Custom text to append to the system prompt'),
    githubToken: z
      .string()
      .optional()
      .describe(
        'GitHub Personal Access Token - if provided and applicable, updates the session token and git remote. Ignored for generic git repos.'
      ),
    gitToken: z
      .string()
      .optional()
      .describe(
        'Git token for authentication - if provided and session uses gitUrl, updates the session token and git remote. Ignored for GitHub repos.'
      ),
    images: ImagesSchema.optional().describe(
      'Optional image attachments to download from R2 to the sandbox'
    ),
  })
  .extend(PromptPayload.shape);

/**
 * Input schema for prepareSession endpoint.
 * Creates a session in "prepared" state for later initiation.
 * Used by backend-to-backend flows.
 */
export const PrepareSessionInput = z
  .object({
    prompt: z
      .string()
      .min(1)
      .max(Limits.MAX_PROMPT_LENGTH)
      .describe('The task prompt for Kilo Code'),
    mode: AgentModeSchema.describe('Kilo Code execution mode'),
    model: z.string().min(1).describe('AI model to use'),

    // Repository - one of these pairs required
    githubRepo: githubRepoSchema
      .optional()
      .describe('GitHub repository in format org/repo (mutually exclusive with gitUrl)'),
    githubToken: z
      .string()
      .optional()
      .describe('GitHub Personal Access Token for private repositories'),
    gitUrl: gitUrlSchema
      .optional()
      .describe('Generic git repository HTTPS URL (mutually exclusive with githubRepo)'),
    gitToken: z.string().optional().describe('Git token for authentication with generic git repos'),
    platform: z
      .enum(['github', 'gitlab'])
      .optional()
      .describe('Git platform type for correct token/env var handling'),

    // Optional configuration
    envVars: envVarsSchema.optional().describe('Environment variables to inject into the session'),
    encryptedSecrets: EncryptedSecretsSchema.optional().describe(
      'Encrypted secret env vars (from agent environment profiles). These are stored encrypted in the DO and decrypted only at execution time.'
    ),
    setupCommands: z
      .array(z.string().max(Limits.MAX_SETUP_COMMAND_LENGTH))
      .max(Limits.MAX_SETUP_COMMANDS)
      .optional()
      .describe('Setup commands to run during session initialization'),
    mcpServers: z
      .record(z.string().max(100), MCPServerConfigSchema)
      .refine(obj => Object.keys(obj).length <= Limits.MAX_MCP_SERVERS, {
        message: `Maximum ${Limits.MAX_MCP_SERVERS} MCP servers allowed`,
      })
      .optional()
      .describe('MCP server configurations'),
    upstreamBranch: branchNameSchema
      .optional()
      .describe('Optional upstream branch to checkout during session initialization'),
    autoCommit: z
      .boolean()
      .optional()
      .describe('Automatically commit and push changes after execution'),
    condenseOnComplete: z
      .boolean()
      .optional()
      .describe('Automatically condense context after execution completes'),
    appendSystemPrompt: z
      .string()
      .max(10000)
      .optional()
      .describe('Custom text to append to the system prompt'),

    // Callback configuration
    callbackTarget: CallbackTargetSchema.optional().describe(
      'Optional callback target configuration for execution completion notifications'
    ),

    // Organization context
    kilocodeOrganizationId: z
      .string()
      .uuid()
      .optional()
      .describe('Organization ID (UUID, optional)'),

    // Image attachments
    images: ImagesSchema.optional().describe(
      'Optional image attachments to download from R2 to the sandbox'
    ),
  })
  .refine(validateGitSource, {
    message: 'Must provide either githubRepo or gitUrl, but not both',
    path: ['githubRepo'],
  });

/** Output schema for prepareSession endpoint */
export const PrepareSessionOutput = z.object({
  cloudAgentSessionId: z.string().describe('The generated cloud-agent session ID'),
  kiloSessionId: z.uuid().describe('The generated Kilo CLI session ID'),
});

/**
 * Input schema for prepareLegacySession endpoint.
 * Prepares a legacy session using an existing cloudAgentSessionId/kiloSessionId pair.
 */
export const PrepareLegacySessionInput = PrepareSessionInput.safeExtend({
  cloudAgentSessionId: sessionIdSchema.describe('Existing cloud-agent session ID to prepare'),
  kiloSessionId: z.uuid().describe('Existing Kilo CLI session ID'),
});

/** Output schema for prepareLegacySession endpoint */
export const PrepareLegacySessionOutput = PrepareSessionOutput;

/**
 * Input schema for updateSession endpoint.
 * Updates a prepared (but not yet initiated) session.
 * - undefined: skip field (no change)
 * - null: clear field
 * - value: set field to value
 * - For collections, empty array/object clears them
 */
export const UpdateSessionInput = z.object({
  cloudAgentSessionId: sessionIdSchema.describe('Cloud-agent session ID to update'),

  // Scalar fields - null to clear, value to set, undefined to skip
  mode: AgentModeSchema.nullable().optional().describe('Mode to set (null to clear)'),
  model: z.string().min(1).nullable().optional().describe('Model to set (null to clear)'),
  githubToken: z.string().nullable().optional().describe('GitHub token to set (null to clear)'),
  gitToken: z.string().nullable().optional().describe('Git token to set (null to clear)'),
  upstreamBranch: branchNameSchema
    .nullable()
    .optional()
    .describe('Upstream branch to set (null to clear)'),
  autoCommit: z.boolean().nullable().optional().describe('Auto-commit setting (null to clear)'),
  condenseOnComplete: z
    .boolean()
    .nullable()
    .optional()
    .describe('Condense context setting (null to clear)'),
  appendSystemPrompt: z
    .string()
    .max(10000)
    .nullable()
    .optional()
    .describe('Custom text to append to the system prompt (null to clear)'),

  // Collection fields - empty to clear, value to set, undefined to skip
  envVars: envVarsSchema.optional().describe('Environment variables (empty object to clear)'),
  encryptedSecrets: EncryptedSecretsSchema.optional().describe(
    'Encrypted secret env vars (empty object to clear)'
  ),
  setupCommands: z
    .array(z.string().max(Limits.MAX_SETUP_COMMAND_LENGTH))
    .max(Limits.MAX_SETUP_COMMANDS)
    .optional()
    .describe('Setup commands (empty array to clear)'),
  mcpServers: z
    .record(z.string().max(100), MCPServerConfigSchema)
    .refine(obj => Object.keys(obj).length <= Limits.MAX_MCP_SERVERS, {
      message: `Maximum ${Limits.MAX_MCP_SERVERS} MCP servers allowed`,
    })
    .optional()
    .describe('MCP servers (empty object to clear)'),
  callbackTarget: CallbackTargetSchema.nullable()
    .optional()
    .describe('Callback target (null to clear, value to set, undefined to skip)'),
});

/** Output schema for updateSession endpoint */
export const UpdateSessionOutput = z.object({
  success: z.boolean().describe('Whether the update was successful'),
});

/**
 * Input schema for getSession endpoint.
 * Retrieves sanitized session metadata (no secrets).
 */
export const GetSessionInput = z.object({
  cloudAgentSessionId: sessionIdSchema.describe('Cloud-agent session ID to retrieve'),
});

/**
 * Output schema for getSession endpoint.
 * Returns sanitized session metadata with lifecycle timestamps for idempotency.
 * Explicitly excludes secrets (tokens, env var values, setup commands, MCP configs).
 */
/**
 * Execution status object for getSession response.
 * Groups all execution-related fields for cleaner API response.
 */
export const ExecutionStatusSchema = z
  .object({
    id: z.string().describe('Execution ID currently running'),
    status: z
      .enum(['pending', 'running', 'completed', 'failed', 'interrupted'])
      .describe('Current status of the execution'),
    startedAt: z.number().describe('Timestamp when execution started'),
    lastHeartbeat: z
      .number()
      .nullable()
      .describe('Last heartbeat timestamp from runner (null if never received)'),
    processId: z.string().nullable().describe('Sandbox process ID (null if not yet started)'),
    error: z.string().nullable().describe('Error message if execution failed (null if no error)'),
    health: z
      .enum(['healthy', 'stale', 'unknown'])
      .describe('Health status: healthy (<1min heartbeat), unknown (1-10min), stale (>10min)'),
  })
  .nullable()
  .describe('Current execution status (null if no active execution)');

export const GetSessionOutput = z.object({
  // Session identifiers
  sessionId: z.string().describe('Cloud-agent session ID'),
  kiloSessionId: z.string().uuid().optional().describe('Kilo CLI session UUID'),
  userId: z.string().describe('Owner user ID'),
  orgId: z.string().optional().describe('Organization ID if applicable'),
  sandboxId: z
    .string()
    .optional()
    .describe('Sandbox ID (hashed format like usr-abc123...) for correlating with Cloudflare logs'),

  // Repository info (no tokens)
  githubRepo: z.string().optional().describe('GitHub repository in org/repo format'),
  gitUrl: z.string().optional().describe('Generic git URL'),

  // Execution params
  prompt: z.string().optional().describe('Task prompt'),
  mode: AgentModeSchema.optional().describe('Execution mode'),
  model: z.string().optional().describe('AI model'),
  autoCommit: z.boolean().optional().describe('Auto-commit setting'),
  upstreamBranch: z.string().optional().describe('Upstream branch name'),

  // Configuration metadata (counts only, no values)
  envVarCount: z.number().optional().describe('Number of environment variables configured'),
  setupCommandCount: z.number().optional().describe('Number of setup commands configured'),
  mcpServerCount: z.number().optional().describe('Number of MCP servers configured'),

  // Execution status (grouped for cleaner API)
  execution: ExecutionStatusSchema,
  queuedCount: z.number().describe('Number of pending items in command queue'),

  // Lifecycle timestamps (critical for idempotency)
  preparedAt: z.number().optional().describe('Timestamp when session was prepared'),
  initiatedAt: z.number().optional().describe('Timestamp when session was initiated'),

  // Callback configuration (debug-friendly, URL + headers)
  callbackTarget: CallbackTargetSchema.optional().describe(
    'Callback target configuration for execution completion notifications'
  ),

  // Versioning
  timestamp: z.number().describe('Last update timestamp'),
  version: z.number().describe('Metadata version for cache invalidation'),
});

export type GetSessionResponse = z.infer<typeof GetSessionOutput>;

/**
 * Response schema for V2 queue-based endpoints.
 * Returns acknowledgment with status indicating if execution started or was queued.
 */
export const QueueAckResponse = z.object({
  cloudAgentSessionId: z.string().describe('Cloud agent session ID'),
  executionId: z.string().describe('Execution ID for this request'),
  status: z
    .enum(['queued', 'started'])
    .describe('Whether execution started immediately or was queued'),
  streamUrl: z.string().describe('WebSocket URL for streaming output'),
});
export type QueueAckResponse = z.infer<typeof QueueAckResponse>;
