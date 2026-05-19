import * as z from 'zod';
import { sessionIdSchema, githubRepoSchema, gitUrlSchema, envVarsSchema } from '../types.js';
import {
  MCPServerConfigSchema,
  MCPSecretValueSchema,
  branchNameSchema,
  modelIdSchema,
  EncryptedSecretEnvelopeSchema,
  EncryptedSecretsSchema,
  CallbackTargetSchema,
  ImagesSchema,
  RuntimeSkillSchema,
  RuntimeSkillsSchema,
  RuntimeAgentSchema,
  RuntimeAgentsSchema,
  RuntimeKiloCommandsSchema,
} from '../persistence/schemas.js';
import { AgentModeSchema, BUILTIN_AGENT_MODES, Limits } from '../schema.js';

// Re-export schemas from types.ts and persistence/schemas.ts for convenience
export { sessionIdSchema, githubRepoSchema, gitUrlSchema, envVarsSchema };
export { MCPServerConfigSchema, MCPSecretValueSchema, branchNameSchema, modelIdSchema };
export { AgentModeSchema, Limits };
export {
  EncryptedSecretEnvelopeSchema,
  EncryptedSecretsSchema,
  CallbackTargetSchema,
  ImagesSchema,
  RuntimeSkillSchema,
  RuntimeSkillsSchema,
  RuntimeAgentSchema,
  RuntimeAgentsSchema,
};

// Re-export types
export type {
  EncryptedSecretEnvelope,
  EncryptedSecrets,
  MCPSecretValue,
} from '../persistence/schemas.js';
export type { RuntimeSkillInput, RuntimeAgentInput } from '../persistence/schemas.js';

/**
 * Flexible mode slug — built-in agent enum value, `custom`, or any slug
 * referenced by the session's `runtimeAgents`. Cross-validation against the
 * runtime modes happens in each handler against the DO state.
 */
export const ModeSlugSchema = z
  .string()
  .min(1)
  .max(Limits.MAX_RUNTIME_AGENT_SLUG_LENGTH)
  .regex(/^[a-z][a-z0-9-]*$/, 'Mode slug must start with a letter');

/** True when the slug is a built-in agent mode (including `custom`). */
export function isBuiltinMode(slug: string): boolean {
  return BUILTIN_AGENT_MODES.has(slug);
}

export type Images = z.infer<typeof ImagesSchema>;

/**
 * Base prompt payload schema used by all execution endpoints.
 * Contains the essential fields for Kilocode execution.
 */
export const PromptPayload = z.object({
  prompt: z.string().min(1, 'Prompt is required').describe('The task prompt for Kilo Code'),
  mode: ModeSlugSchema.describe(
    'Kilo Code execution mode (built-in slug or a custom slug from runtimeAgents)'
  ),
  model: modelIdSchema.describe('AI model to use (required)'),
  variant: z
    .string()
    .max(50)
    .regex(/^[a-zA-Z]+$/)
    .optional(),
});

/**
 * Discriminated payload variants for sendMessageV2.
 *
 * The same execution pipeline (auth, queueing, optimistic message, ingest,
 * stream broadcast) handles both — only the final wrapper call differs:
 * `wrapperClient.prompt()` for prompts vs `wrapperClient.command()` for slash
 * commands. See execution/wrapper-call.ts for the branch.
 */
export const PromptSendPayload = z.object({
  type: z.literal('prompt'),
  prompt: z.string().min(1, 'Prompt is required'),
  mode: ModeSlugSchema,
  model: modelIdSchema,
  variant: z
    .string()
    .max(50)
    .regex(/^[a-zA-Z]+$/)
    .optional(),
});

export const CommandSendPayload = z.object({
  type: z.literal('command'),
  command: z.string().min(1, 'Command name is required'),
  /** Verbatim args. Kilo expands $1/$2/$ARGUMENTS server-side. */
  arguments: z.string().default(''),
});

export const SendMessageV2Payload = z.discriminatedUnion('type', [
  PromptSendPayload,
  CommandSendPayload,
]);

export type InitialExecutionPayload = z.infer<typeof SendMessageV2Payload>;

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
      .describe('Automatically commit and push changes after execution'),
    condenseOnComplete: z
      .boolean()
      .optional()
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
    messageId: z
      .string()
      .startsWith('msg_')
      .length(30)
      .optional()
      .describe('Optional message ID for correlating the request'),
    payload: SendMessageV2Payload.describe(
      'Discriminated execution payload — either a free-text prompt or a structured slash command invocation'
    ),
  })
  .refine(data => data.payload.type !== 'prompt' || data.payload.mode !== 'custom', {
    message: 'custom mode requires appendSystemPrompt (use prepareSession/updateSession)',
    path: ['payload', 'mode'],
  });

export type SendMessageV2InputPayload = z.infer<typeof SendMessageV2Payload>;

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
    mode: ModeSlugSchema.describe(
      'Kilo Code execution mode (built-in or custom slug from runtimeAgents)'
    ),
    model: modelIdSchema.describe('AI model to use'),
    variant: z
      .string()
      .max(50)
      .regex(/^[a-zA-Z]+$/)
      .optional(),

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
    runtimeSkills: RuntimeSkillsSchema.optional().describe(
      'Runtime skills to materialize as SKILL.md files inside the sandbox'
    ),
    runtimeAgents: RuntimeAgentsSchema.optional().describe(
      'Custom kilo agents materialized into KILO_CONFIG_CONTENT.agent.<slug>'
    ),
    kiloCommands: RuntimeKiloCommandsSchema.optional().describe(
      'Custom slash commands materialized into KILO_CONFIG_CONTENT.command.<name>'
    ),
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

    // Profile resolution — cloud-agent-next resolves the profile stack
    // (repo binding + default + explicit override) server-side and stacks
    // the inline fields above as one more layer on top. All six collections
    // (envVars / setupCommands / encryptedSecrets / mcpServers /
    // runtimeSkills / runtimeAgents) follow the same precedence: inline
    // wins on collision with the profile-derived value.
    profileId: z
      .string()
      .uuid()
      .optional()
      .describe('Profile ID to resolve (repo binding + default still apply on top)'),

    // Image attachments
    images: ImagesSchema.optional().describe(
      'Optional image attachments to download from R2 to the sandbox'
    ),
    createdOnPlatform: z
      .string()
      .max(100)
      .optional()
      .describe('Platform that created this session (e.g. slack, app-builder)'),
    shallow: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Perform a shallow clone (depth: 1) for faster checkout and reduced disk usage. Useful when full git history is not needed.'
      ),
    gateThreshold: z
      .enum(['off', 'all', 'warning', 'critical'])
      .optional()
      .describe(
        'PR gate threshold — when not "off", the agent should evaluate findings and report gateResult in its callback'
      ),
    autoInitiate: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'When true, return immediately after creating IDs and run preparation asynchronously. Progress events are streamed via WebSocket.'
      ),
    devcontainer: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'When true, route the session to a Docker-in-Docker sandbox that supports devcontainer runtimes'
      ),
    initialMessageId: z
      .string()
      .startsWith('msg_')
      .length(30)
      .optional()
      .describe('Initial message ID for correlation with external systems'),

    initialPayload: SendMessageV2Payload.optional().describe(
      'Discriminated initial execution payload — command variant allows starting a session with a slash command instead of a free-text prompt'
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
  kiloSessionId: z.string().describe('The Kilo CLI session ID'),
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
    mode: ModeSlugSchema.nullable().optional().describe('Mode to set (null to clear)'),
    model: modelIdSchema.nullable().optional().describe('Model to set (null to clear)'),
    variant: z
      .string()
      .max(50)
      .regex(/^[a-zA-Z]+$/)
      .nullable()
      .optional(),
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
    runtimeSkills: RuntimeSkillsSchema.optional().describe('Runtime skills (empty array to clear)'),
    runtimeAgents: RuntimeAgentsSchema.optional().describe(
      'Custom kilo agents (empty array to clear)'
    ),
    kiloCommands: RuntimeKiloCommandsSchema.optional().describe(
      'Custom slash commands (empty array to clear)'
    ),
    callbackTarget: CallbackTargetSchema.nullable()
      .optional()
      .describe('Callback target (null to clear, value to set, undefined to skip)'),
  })
  .refine(requiresAppendSystemPrompt, {
    message: 'appendSystemPrompt is required when mode is custom',
    path: ['appendSystemPrompt'],
  })
  .superRefine((data, ctx) => {
    // If the caller sets `mode`, it must resolve against the incoming runtimeAgents
    // (or the existing session's runtimeAgents — checked at handler level). At schema
    // time we only cross-check within this payload to catch obvious mistakes.
    if (data.mode === null || data.mode === undefined) return;
    if (isBuiltinMode(data.mode)) return;
    if (data.runtimeAgents !== undefined) {
      const slugs = new Set(data.runtimeAgents.map(a => a.slug));
      if (!slugs.has(data.mode)) {
        ctx.addIssue({
          code: 'custom',
          path: ['mode'],
          message: `Mode "${data.mode}" is not a built-in slug and does not match any runtimeAgents[].slug in this update payload`,
        });
      }
    }
    // If runtimeAgents not provided, handler validates against session state.
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

export const SandboxStatusSchema = z
  .enum(['healthy', 'destroyed', 'unreachable', 'unknown'])
  .describe('Sandbox reachability status for the session container');

export const SessionHealthExecutionSchema = z
  .enum(['healthy', 'unknown', 'stale', 'none'])
  .describe('Health status for the active execution, or none when no execution is active');

export const ActiveExecutionStatusSchema = z
  .enum(['pending', 'running', 'completed', 'failed', 'interrupted'])
  .describe('Current status of the active execution');

export const GetSessionHealthInput = z.object({
  cloudAgentSessionId: sessionIdSchema.describe('Cloud-agent session ID to inspect'),
});

export const GetSessionHealthOutput = z.object({
  cloudAgentSessionId: z.string().describe('Cloud-agent session ID'),
  sandboxId: z.string().optional().describe('Sandbox ID for the session'),
  sandboxStatus: SandboxStatusSchema,
  executionHealth: SessionHealthExecutionSchema,
  activeExecutionStatus: ActiveExecutionStatusSchema.optional(),
  activeExecutionId: z.string().optional(),
});

export type GetSessionHealthResponse = z.infer<typeof GetSessionHealthOutput>;

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
  platform: z.enum(['github', 'gitlab']).optional().describe('Git platform type'),

  // Execution params
  prompt: z.string().optional().describe('Task prompt'),
  mode: z.string().optional().describe('Execution mode (built-in or custom slug)'),
  model: z.string().optional().describe('AI model'),
  variant: z.string().optional().describe('Thinking effort variant'),
  autoCommit: z.boolean().optional().describe('Auto-commit setting'),
  upstreamBranch: z.string().optional().describe('Upstream branch name'),

  runtimeAgents: z
    .array(
      z.object({
        slug: z.string(),
        name: z.string(),
        /** Optional model override so the chat UI can lock its model picker. */
        model: z.string().optional(),
        /** Optional thinking-effort variant override so the chat UI can lock its variant picker. */
        variant: z.string().optional(),
      })
    )
    .optional()
    .describe(
      'Custom agents available on this session (slug + name, plus optional model and thinking-effort overrides)'
    ),

  // Execution status (grouped for cleaner API)
  execution: ExecutionStatusSchema,

  // Lifecycle timestamps (critical for idempotency)
  preparedAt: z.number().optional().describe('Timestamp when session was prepared'),
  initiatedAt: z.number().optional().describe('Timestamp when session was initiated'),

  // Callback configuration (debug-friendly, URL + headers)
  callbackTarget: CallbackTargetSchema.optional().describe(
    'Callback target configuration for execution completion notifications'
  ),

  // Initial message ID for correlation
  initialMessageId: z.string().startsWith('msg_').length(30).optional(),

  // Versioning
  timestamp: z.number().describe('Last update timestamp'),
  version: z.number().describe('Metadata version for cache invalidation'),
});

export type GetSessionResponse = z.infer<typeof GetSessionOutput>;

export const GetLatestAssistantMessageInput = z.object({
  cloudAgentSessionId: sessionIdSchema.describe('Cloud-agent session ID to inspect'),
});

export const AssistantMessageInfoSchema = z
  .object({
    id: z.string().describe('Assistant message ID'),
    role: z.literal('assistant'),
  })
  .passthrough();

export const AssistantMessagePartSchema = z
  .object({
    id: z.string().describe('Message part ID'),
    messageID: z.string().describe('Parent message ID'),
  })
  .passthrough();

export const LatestAssistantMessageSchema = z.object({
  eventId: z.number().describe('Stored event ID for the message.updated event'),
  timestamp: z.number().describe('Stored event timestamp in milliseconds'),
  info: AssistantMessageInfoSchema,
  parts: z.array(AssistantMessagePartSchema),
});

export const GetLatestAssistantMessageOutput = z.object({
  cloudAgentSessionId: sessionIdSchema,
  message: LatestAssistantMessageSchema.nullable(),
});

export type GetLatestAssistantMessageResponse = z.infer<typeof GetLatestAssistantMessageOutput>;

/**
 * Response schema for V2 execution endpoints.
 * Returns acknowledgment when execution has started.
 * Returns 409 Conflict if an execution is already in progress.
 */
export const ExecutionResponse = z.object({
  cloudAgentSessionId: z.string().describe('Cloud agent session ID'),
  executionId: z.string().describe('Execution ID for streaming and ingest'),
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
