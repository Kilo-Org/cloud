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
  mode: AgentModeSchema.describe('Kilo Code execution mode (required)'),
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

const rejectCustomMode = (data: { mode?: string | null }) => data.mode !== 'custom';

const requiresAppendSystemPrompt = (data: {
  mode?: string | null;
  appendSystemPrompt?: string | null;
}) => data.mode !== 'custom' || Boolean(data.appendSystemPrompt?.trim());

/**
 * Input schema for initiateFromKilocodeSessionV2 with prepared sessions.
 * Client provides only cloudAgentSessionId - all other params come from DO metadata.
 */
export const InitiateFromPreparedSessionInput = z.object({
  cloudAgentSessionId: sessionIdSchema.describe('Cloud-agent session ID from prepareSession'),
});

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
  .extend(PromptPayload.shape)
  .refine(rejectCustomMode, {
    message: 'custom mode requires appendSystemPrompt (use prepareSession/updateSession)',
    path: ['mode'],
  });

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
  })
  .refine(requiresAppendSystemPrompt, {
    message: 'appendSystemPrompt is required when mode is custom',
    path: ['appendSystemPrompt'],
  });

/** Output schema for prepareSession endpoint */
export const PrepareSessionOutput = z.object({
  cloudAgentSessionId: z.string().describe('The generated cloud-agent session ID'),
  kiloSessionId: z.string().describe('The generated Kilo CLI session ID'),
});

/**
 * Input schema for updateSession endpoint.
 * Updates a prepared (but not yet initiated) session.
 * - undefined: skip field (no change)
 * - null: clear field
 * - value: set field to value
 * - For collections, empty array/object clears them
 */
export const UpdateSessionInput = z
  .object({
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
  })
  .refine(requiresAppendSystemPrompt, {
    message: 'appendSystemPrompt is required when mode is custom',
    path: ['appendSystemPrompt'],
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
  kiloSessionId: z.string().optional().describe('Kilo CLI session ID'),
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
 * Response schema for V2 execution endpoints.
 * Returns acknowledgment when execution has started.
 * Returns 409 Conflict if an execution is already in progress.
 */
export const ExecutionResponse = z.object({
  cloudAgentSessionId: z.string().describe('Cloud agent session ID'),
  executionId: z.string().describe('Execution ID (same as messageId sent to wrapper)'),
  status: z.literal('started').describe('Execution has started'),
  streamUrl: z.string().describe('WebSocket URL for streaming output'),
});
export type ExecutionResponse = z.infer<typeof ExecutionResponse>;

/**
 * @deprecated Use ExecutionResponse instead
 */
export const QueueAckResponse = ExecutionResponse;
export type QueueAckResponse = ExecutionResponse;

/**
 * Error response for 409 Conflict when execution is already in progress.
 */
export const ConflictErrorResponse = z.object({
  error: z.literal('EXECUTION_IN_PROGRESS').describe('Error code'),
  message: z.string().describe('Human-readable error message'),
  activeExecutionId: z.string().describe('The currently active execution ID'),
});
export type ConflictErrorResponse = z.infer<typeof ConflictErrorResponse>;

/**
 * Error response for 503 Service Unavailable when transient failures occur.
 * These are retryable errors - client should retry with backoff.
 */
export const TransientErrorResponse = z.object({
  error: z
    .enum([
      'SANDBOX_CONNECT_FAILED',
      'WORKSPACE_SETUP_FAILED',
      'KILO_SERVER_FAILED',
      'WRAPPER_START_FAILED',
    ])
    .describe('Error code indicating the type of transient failure'),
  message: z.string().describe('Human-readable error message'),
  retryable: z.literal(true).describe('Indicates this error is retryable'),
});
export type TransientErrorResponse = z.infer<typeof TransientErrorResponse>;
