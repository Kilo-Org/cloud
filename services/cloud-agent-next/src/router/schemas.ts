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
  AttachmentsSchema,
  ImagesSchema,
  RuntimeSkillSchema,
  RuntimeSkillsSchema,
  RuntimeAgentSchema,
  RuntimeAgentsSchema,
  RuntimeKiloCommandsSchema,
} from '../persistence/schemas.js';
import { AgentModeSchema, BUILTIN_AGENT_MODES, Limits } from '../schema.js';
import { MESSAGE_ID_FORMAT_DESCRIPTION, MESSAGE_ID_PATTERN } from '../session/message-id.js';

// Re-export schemas from types.ts and persistence/schemas.ts for convenience
export { sessionIdSchema, githubRepoSchema, gitUrlSchema, envVarsSchema };
export { MCPServerConfigSchema, MCPSecretValueSchema, branchNameSchema, modelIdSchema };
export { AgentModeSchema, Limits };
export {
  EncryptedSecretEnvelopeSchema,
  EncryptedSecretsSchema,
  CallbackTargetSchema,
  AttachmentsSchema,
  ImagesSchema,
  RuntimeSkillSchema,
  RuntimeSkillsSchema,
  RuntimeAgentSchema,
  RuntimeAgentsSchema,
};

export const MessageIdSchema = z.string().regex(MESSAGE_ID_PATTERN, MESSAGE_ID_FORMAT_DESCRIPTION);

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

export type Attachments = z.infer<typeof AttachmentsSchema>;
export type Images = z.infer<typeof ImagesSchema>;

const AttachmentFieldsSchema = {
  attachments: AttachmentsSchema.optional().describe(
    'Optional file attachments to download from R2 to the sandbox'
  ),
  images: ImagesSchema.optional().describe(
    'Legacy optional image attachments to download from R2 to the sandbox'
  ),
};

function rejectAmbiguousAttachments(
  data: { attachments?: unknown; images?: unknown },
  ctx: z.RefinementCtx
): void {
  if (data.attachments !== undefined && data.images !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['attachments'],
      message: 'Provide attachments or legacy images, not both',
    });
  }
}

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
 * Discriminated prompt and slash-command payload variants retained by the
 * request schema. Endpoint-specific schemas below narrow accepted branches.
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

function validateModeAgainstInlineRuntimeAgents(
  data: { mode?: string | null; runtimeAgents?: Array<{ slug: string }> },
  ctx: z.RefinementCtx
): void {
  if (data.mode === null || data.mode === undefined) return;
  if (isBuiltinMode(data.mode)) return;
  if (data.runtimeAgents !== undefined) {
    const slugs = new Set(data.runtimeAgents.map(a => a.slug));
    if (!slugs.has(data.mode)) {
      ctx.addIssue({
        code: 'custom',
        path: ['mode'],
        message: `Mode "${data.mode}" is not a built-in slug and does not match any runtimeAgents[].slug in this payload`,
      });
    }
  }
}

function requiresAppendSystemPromptGrouped(data: {
  agent?: { mode?: string | null } | null;
  profile?: { overrides?: { appendSystemPrompt?: string | null } } | null;
}): boolean {
  if (data.agent?.mode !== 'custom') return true;
  return Boolean(data.profile?.overrides?.appendSystemPrompt?.trim());
}

function validateModeAgainstInlineRuntimeAgentsGrouped(
  data: {
    agent?: { mode?: string | null } | null;
    profile?: { overrides?: { runtimeAgents?: Array<{ slug: string }> } } | null;
  },
  ctx: z.RefinementCtx
): void {
  const mode = data.agent?.mode;
  if (mode === null || mode === undefined) return;
  if (isBuiltinMode(mode)) return;
  const runtimeAgents = data.profile?.overrides?.runtimeAgents;
  if (runtimeAgents !== undefined) {
    const slugs = new Set(runtimeAgents.map(a => a.slug));
    if (!slugs.has(mode)) {
      ctx.addIssue({
        code: 'custom',
        path: ['agent', 'mode'],
        message: `Mode "${mode}" is not a built-in slug and does not match any runtimeAgents[].slug in this payload`,
      });
    }
  }
}

/**
 * Input schema for initiateFromKilocodeSessionV2 with prepared sessions.
 * Client provides only cloudAgentSessionId - all other params come from DO metadata.
 */
export const InitiateFromPreparedSessionInput = z
  .object({
    cloudAgentSessionId: sessionIdSchema.describe('Cloud-agent session ID from prepareSession'),
  })
  .strict();

/**
 * V2 input schema for sendMessageV2 endpoint.
 * Uses cloudAgentSessionId naming for consistency with prepare/initiate V2.
 */
const SendMessageV2Options = z.object({
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
      'Deprecated compatibility field. Accepted for older clients but ignored; GitHub credentials are managed by the server.'
    ),
  gitToken: z
    .string()
    .optional()
    .describe(
      'Deprecated compatibility field. Accepted for older clients but ignored; provider credentials are managed by the server.'
    ),
  ...AttachmentFieldsSchema,
  messageId: MessageIdSchema.nullish().describe('Optional message ID for correlating the request'),
});

const SendMessageV2FlatInput = SendMessageV2Options.extend(PromptPayload.shape);
const SendMessageV2PromptPayloadInput = SendMessageV2Options.extend({
  payload: PromptSendPayload,
});
const SendMessageV2CommandPayloadInput = SendMessageV2Options.extend({
  payload: CommandSendPayload,
});

export const SendMessageV2Input = z
  .union([
    SendMessageV2FlatInput,
    SendMessageV2PromptPayloadInput,
    SendMessageV2CommandPayloadInput,
  ])
  .superRefine((input, ctx) => {
    rejectAmbiguousAttachments(input, ctx);
    if ('payload' in input && input.payload.type === 'command') {
      if (input.attachments !== undefined || input.images !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['attachments'],
          message: 'Attachments cannot be attached to slash commands',
        });
      }
    }
  })
  .transform(input => {
    if ('payload' in input && input.payload.type === 'prompt') {
      const { payload, ...options } = input;
      return {
        ...options,
        prompt: payload.prompt,
        mode: payload.mode,
        model: payload.model,
        variant: payload.variant,
      };
    }

    return input;
  })
  .refine(data => !('mode' in data) || data.mode !== 'custom', {
    message: 'custom mode requires appendSystemPrompt (use prepareSession/updateSession)',
    path: ['mode'],
  });

export type SendMessageV2InputPayload = z.infer<typeof SendMessageV2Payload>;

export const PtyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid PTY ID format');

export const TerminalSizeSchema = z.object({
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(2).max(200),
});

export const TerminalPtySchema = z.object({
  id: PtyIdSchema,
  title: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  status: z.enum(['running', 'exited']),
  pid: z.number().int(),
});

export const CreateTerminalInput = z
  .object({
    cloudAgentSessionId: sessionIdSchema.describe('Cloud-agent session ID to open a terminal for'),
  })
  .extend(TerminalSizeSchema.partial().shape)
  .refine(data => (data.cols === undefined) === (data.rows === undefined), {
    message: 'cols and rows must be provided together',
  });

export const CreateTerminalOutput = z.object({
  pty: TerminalPtySchema,
});

export const ResizeTerminalInput = z
  .object({
    cloudAgentSessionId: sessionIdSchema.describe(
      'Cloud-agent session ID to resize a terminal for'
    ),
    ptyId: PtyIdSchema,
  })
  .extend(TerminalSizeSchema.shape);

export const ResizeTerminalOutput = z.object({
  pty: TerminalPtySchema,
});

export const CloseTerminalInput = z.object({
  cloudAgentSessionId: sessionIdSchema.describe('Cloud-agent session ID to close a terminal for'),
  ptyId: PtyIdSchema,
});

export const CloseTerminalOutput = z.object({
  success: z.boolean(),
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
      .describe(
        'Deprecated compatibility field. Accepted for older clients but ignored; GitHub credentials are managed by the server.'
      ),
    gitUrl: gitUrlSchema
      .optional()
      .describe('Generic git repository HTTPS URL (mutually exclusive with githubRepo)'),
    gitToken: z
      .string()
      .optional()
      .describe(
        'Git token for generic git repositories. Ignored when platform selects a managed provider.'
      ),
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

    ...AttachmentFieldsSchema,
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
    initialMessageId: MessageIdSchema.optional().describe(
      'Initial message ID for correlation with external systems'
    ),
    /**
     * When `true`, `prepareSession` also enqueues the initial user message
     * (mirroring the unified `start` endpoint) so callers that navigate
     * straight to the session UI after prepare — apps/web NewSessionPanel,
     * mobile session manager — don't need a separate
     * `initiateFromKilocodeSessionV2` round-trip. When omitted or `false`,
     * the caller is responsible for a follow-up
     * `initiateFromKilocodeSessionV2` (legacy two-step flow preserved for
     * services/code-review-infra and e2e tests that assert on the split).
     */
    autoInitiate: z
      .boolean()
      .optional()
      .describe(
        'When true, also queues the initial user message; preparation still runs lazily at first-message flush.'
      ),
    devcontainer: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'When true, route the session to a Docker-in-Docker sandbox that supports devcontainer runtimes'
      ),
    initialPayload: SendMessageV2Payload.optional().describe(
      'Discriminated initial execution payload - command variant allows starting a session with a slash command instead of a free-text prompt'
    ),
  })
  .refine(validateGitSource, {
    message: 'Must provide either githubRepo or gitUrl, but not both',
    path: ['githubRepo'],
  })
  .superRefine(rejectAmbiguousAttachments)
  .refine(requiresAppendSystemPrompt, {
    message: 'appendSystemPrompt is required when mode is custom',
    path: ['appendSystemPrompt'],
  })
  .superRefine(validateModeAgainstInlineRuntimeAgents);

/** Output schema for prepareSession endpoint */
export const PrepareSessionOutput = z.object({
  cloudAgentSessionId: z.string().describe('The generated cloud-agent session ID'),
  kiloSessionId: z.string().describe('The Kilo CLI session ID'),
});

/**
 * Input schema for the unified `start` endpoint.
 *
 * `start` is the collapsed replacement for the legacy
 * `prepareSession + initiateFromKilocodeSessionV2` pair. After the external
 * ownership row is created, one Durable Object command registers metadata and
 * attempts durable initial-turn admission; the alarm-driven flusher delivers
 * an admitted message once preparation completes. If admission is rejected
 * after metadata registration, the endpoint fails and attempts best-effort
 * `onlyIfEmpty` deletion of the external ownership row. Retried transport errors
 * reuse the canonical message identity; unrecovered unknown outcomes retain state
 * and may require operational cleanup because the DO commit result is unknown.
 * This contract claims neither a distributed transaction nor an unimplemented
 * cross-record DO storage transaction.
 *
 * The input schema is intentionally a subset of `PrepareSessionInput`.
 * Refinements are shared so validation rules stay aligned.
 */
/**
 * Repository input for the new grouped `start` API.
 *
 * Discriminated by hosting provider:
 * - `github`: uses `repo` (org/repo); cloud-agent-next resolves tokens.
 * - `gitlab`: uses clone `url`; cloud-agent-next resolves managed GitLab tokens.
 * - `git`: generic HTTPS clone URL with optional explicit token.
 */
export const RepositoryInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('github'),
    repo: githubRepoSchema.describe('GitHub repository in org/repo format'),
    branch: branchNameSchema.optional().describe('Branch to checkout'),
  }),
  z.object({
    type: z.literal('gitlab'),
    url: gitUrlSchema.describe('GitLab repository HTTPS URL'),
    branch: branchNameSchema.optional().describe('Branch to checkout'),
  }),
  z.object({
    type: z.literal('git'),
    url: gitUrlSchema.describe('Git repository HTTPS URL'),
    token: z.string().optional().describe('Git authentication token'),
    branch: branchNameSchema.optional().describe('Branch to checkout'),
  }),
]);

export type RepositoryInput = z.infer<typeof RepositoryInputSchema>;

/**
 * Profile input for the new grouped `start` API.
 *
 * `id` resolves a server-side profile; `overrides` are applied on top.
 */
export const ProfileInputSchema = z
  .object({
    id: z.string().uuid().optional().describe('Profile ID to resolve'),
    overrides: z
      .object({
        envVars: envVarsSchema.optional(),
        encryptedSecrets: EncryptedSecretsSchema.optional(),
        setupCommands: z
          .array(z.string().max(Limits.MAX_SETUP_COMMAND_LENGTH))
          .max(Limits.MAX_SETUP_COMMANDS)
          .optional(),
        mcpServers: z
          .record(z.string().max(100), MCPServerConfigSchema)
          .refine(obj => Object.keys(obj).length <= Limits.MAX_MCP_SERVERS, {
            message: `Maximum ${Limits.MAX_MCP_SERVERS} MCP servers allowed`,
          })
          .optional(),
        runtimeSkills: RuntimeSkillsSchema.optional(),
        runtimeAgents: RuntimeAgentsSchema.optional(),
        appendSystemPrompt: z.string().max(10000).optional(),
      })
      .optional(),
  })
  .optional();

export type ProfileInput = z.infer<typeof ProfileInputSchema>;

/**
 * Input schema for the unified `start` endpoint.
 *
 * `start` is the collapsed replacement for the legacy
 * `prepareSession + initiateFromKilocodeSessionV2` pair. Its Durable Object
 * receives registration plus canonical initial admission through one grouped
 * command after the external ownership prerequisite succeeds.
 */
export const StartSessionInput = z
  .object({
    message: z
      .object({
        prompt: z.string().min(1).max(Limits.MAX_PROMPT_LENGTH),
        ...AttachmentFieldsSchema,
        id: MessageIdSchema.optional(),
      })
      .superRefine(rejectAmbiguousAttachments),
    agent: z.object({
      mode: ModeSlugSchema,
      model: modelIdSchema,
      variant: z
        .string()
        .max(50)
        .regex(/^[a-zA-Z]+$/)
        .optional(),
    }),
    finalization: z
      .object({
        autoCommit: z.boolean().optional(),
        condenseOnComplete: z.boolean().optional(),
        gateThreshold: z.enum(['off', 'all', 'warning', 'critical']).optional(),
      })
      .optional(),
    repository: RepositoryInputSchema,
    profile: ProfileInputSchema,
    options: z
      .object({
        kilocodeOrganizationId: z.string().uuid().optional(),
        createdOnPlatform: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .refine(requiresAppendSystemPromptGrouped, {
    message: 'appendSystemPrompt is required when mode is custom',
    path: ['agent', 'mode'],
  })
  .superRefine(validateModeAgainstInlineRuntimeAgentsGrouped);

/** Output schema for the `start` endpoint. */
export const StartSessionOutput = z.object({
  cloudAgentSessionId: z.string(),
  kiloSessionId: z.string(),
  messageId: MessageIdSchema,
  delivery: z.enum(['sent', 'queued']),
  wrapperRunId: z.string().optional(),
});

/**
 * Input schema for the unified `send` endpoint.
 *
 * Sends a message to a session that was already created via `start`.
 * Repository auth is not accepted; existing session metadata and provider
 * integrations determine auth.
 */
export const SendMessageInput = z
  .object({
    cloudAgentSessionId: sessionIdSchema,
    message: z
      .object({
        prompt: z.string().min(1, 'Prompt is required'),
        ...AttachmentFieldsSchema,
        id: MessageIdSchema.nullish(),
      })
      .superRefine(rejectAmbiguousAttachments),
    agent: z
      .object({
        mode: ModeSlugSchema,
        model: modelIdSchema,
        variant: z
          .string()
          .max(50)
          .regex(/^[a-zA-Z]+$/)
          .optional(),
      })
      .optional(),
    finalization: z
      .object({
        autoCommit: z.boolean().optional(),
        condenseOnComplete: z.boolean().optional(),
      })
      .optional(),
  })
  .refine(data => data.agent?.mode !== 'custom', {
    message: 'custom mode requires appendSystemPrompt on the original session',
    path: ['agent', 'mode'],
  });

/**
 * Input schema for updateSession endpoint.
 * Retained only for rewriting callbackTarget on session continuations.
 */
export const UpdateSessionInput = z
  .object({
    cloudAgentSessionId: sessionIdSchema.describe('Cloud-agent session ID to update'),

    callbackTarget: CallbackTargetSchema.nullable()
      .optional()
      .describe('Callback target (null to clear, value to set, undefined to skip)'),
  })
  .strict();

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
  .describe('Health status for active execution-compatible work, or none when no work is active');

export const ActiveExecutionStatusSchema = z
  .enum(['pending', 'running', 'completed', 'failed', 'interrupted'])
  .describe('Current status of active legacy execution or message-native work');

export const GetSessionHealthInput = z.object({
  cloudAgentSessionId: sessionIdSchema.describe('Cloud-agent session ID to inspect'),
});

export const GetSessionHealthOutput = z.object({
  cloudAgentSessionId: z.string().describe('Cloud-agent session ID'),
  sandboxId: z.string().optional().describe('Sandbox ID for the session'),
  sandboxStatus: SandboxStatusSchema,
  executionHealth: SessionHealthExecutionSchema,
  activeExecutionStatus: ActiveExecutionStatusSchema.optional(),
  activeExecutionId: z
    .string()
    .optional()
    .describe('Compatibility identity for active work: legacy executionId or current messageId'),
});

export type GetSessionHealthResponse = z.infer<typeof GetSessionHealthOutput>;

/**
 * Compatibility activity object for getSession response.
 * Preserves its execution-shaped surface while projecting current message-native work.
 */
export const ExecutionStatusSchema = z
  .object({
    id: z.string().describe('Compatibility identity for current message-native work'),
    status: z
      .enum(['pending', 'running', 'completed', 'failed', 'interrupted'])
      .describe('Current message-native activity status'),
    startedAt: z.number().describe('Compatibility activity timestamp'),
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
  .describe('Current message-native activity projection (null if none)');

/**
 * Output schema for getSession endpoint.
 * Returns sanitized session metadata with lifecycle timestamps for idempotency.
 * Explicitly excludes secrets (tokens, env var values, setup commands, MCP configs).
 */
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

  // Callback configuration is intentionally NOT exposed here. The stored
  // `callbackTarget` may carry service-to-service auth headers (e.g. an
  // X-Internal-Secret used by downstream Worker callback ingresses), and
  // `getSession` is reachable by the session's owning user via the web tRPC
  // surface. Returning headers — even for "debug" — would leak that secret
  // to any user who can run a flow that creates a session on their behalf.
  // Use service-internal logs/storage if you need to inspect the target.

  // Initial message ID for correlation
  initialMessageId: MessageIdSchema.optional(),

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
 * Compatibility response schema for public send/V2 endpoints.
 * `status: started` remains an external adapter projection; a queued response
 * acknowledges durable admission and does not claim wrapper execution started.
 */
export const ExecutionResponse = z.object({
  cloudAgentSessionId: z.string().describe('Cloud agent session ID'),
  status: z.literal('started').describe('Compatibility acknowledgment value'),
  streamUrl: z.string().describe('WebSocket URL for streaming output'),
  messageId: MessageIdSchema.describe('Durably admitted message ID'),
  delivery: z.enum(['sent', 'queued']).describe('Compatibility delivery state'),
  wrapperRunId: z
    .string()
    .optional()
    .describe('Wrapper run ID for correlating wrapper process lifetime'),
});
export type ExecutionResponse = z.infer<typeof ExecutionResponse>;

/**
 * Legacy V2 execution response.
 *
 * `executionId` is retained only as a backwards-compatible alias for
 * `messageId`; new callers should use `messageId`.
 */
export const LegacyExecutionResponse = ExecutionResponse.extend({
  executionId: z.string().describe('Deprecated compatibility alias for messageId'),
});
export type LegacyExecutionResponse = z.infer<typeof LegacyExecutionResponse>;

/**
 * @deprecated Use ExecutionResponse instead
 */
export const QueueAckResponse = ExecutionResponse;
export type QueueAckResponse = ExecutionResponse;

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
