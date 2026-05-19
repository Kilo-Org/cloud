import * as z from 'zod';
import {
  CLOUD_AGENT_IMAGE_ALLOWED_TYPES,
  CLOUD_AGENT_IMAGE_MAX_COUNT,
  CLOUD_AGENT_IMAGE_MAX_SIZE_BYTES,
} from '@/lib/cloud-agent/constants';

/**
 * Shared schemas for cloud-agent-next routers
 *
 * Uses V2 WebSocket-based API only.
 */

const cloudAgentImageFilenameSchema = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(?:png|jpg|webp|gif)$/
  );

export const cloudAgentImagesSchema = z
  .object({
    path: z.uuid(),
    files: z.array(cloudAgentImageFilenameSchema).min(1).max(CLOUD_AGENT_IMAGE_MAX_COUNT),
  })
  .optional();

export const cloudAgentGetImageUploadUrlSchema = z.object({
  messageUuid: z.uuid(),
  imageId: z.uuid(),
  contentType: z.enum(CLOUD_AGENT_IMAGE_ALLOWED_TYPES),
  contentLength: z.number().int().positive().max(CLOUD_AGENT_IMAGE_MAX_SIZE_BYTES),
});

/**
 * Agent mode enum - all supported modes.
 * - code, plan, debug, orchestrator, ask: CLI agent modes
 * - build, architect: Backward-compatible aliases (build → code, architect → plan)
 * - custom: Custom mode (requires appendSystemPrompt)
 */
export const agentModeNextSchema = z.enum([
  'code',
  'plan',
  'debug',
  'orchestrator',
  'ask',
  'build',
  'architect',
  'custom',
]);

// Encrypted envelope shape (re-defined here to avoid importing server-only code).
const encryptedEnvelopeInputSchema = z.object({
  encryptedData: z.string(),
  encryptedDEK: z.string(),
  algorithm: z.literal('rsa-aes-256-gcm'),
  version: z.literal(1),
});

// MCP env / remote-header value: plain string or encrypted envelope. Plain
// strings pass straight through to the sandbox; envelopes are decrypted
// per key by the worker before materializing KILO_CONFIG_CONTENT.mcp.
const mcpSecretValueSchema = z.union([z.string().max(4096), encryptedEnvelopeInputSchema]);

// Local MCP server configuration (runs a command).
const mcpLocalServerConfigSchema = z
  .object({
    type: z.literal('local'),
    command: z.string().array().min(1, 'Command array must have at least one element'),
    environment: z.record(z.string(), mcpSecretValueSchema).optional(),
    enabled: z.boolean().optional(),
    timeout: z.number().min(1).max(3_600_000).optional(),
  })
  .strict();

// Remote MCP server configuration (connects to a URL).
const mcpRemoteServerConfigSchema = z
  .object({
    type: z.literal('remote'),
    url: z.string().url('URL must be a valid URL format'),
    headers: z.record(z.string(), mcpSecretValueSchema).optional(),
    enabled: z.boolean().optional(),
    timeout: z.number().min(1).max(3_600_000).optional(),
  })
  .strict();

// Runtime skill input (materialized to SKILL.md + companion files in the sandbox)
const runtimeSkillSchemaMax = 100_000;
export const runtimeSkillInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Skill name must be a slug'),
  rawMarkdown: z.string().min(1).max(runtimeSkillSchemaMax),
  /** Companion files keyed by relative path, excluding SKILL.md. */
  files: z.record(z.string().max(200), z.string().max(runtimeSkillSchemaMax)).optional(),
});

/** Permission schema — mirrors the CLI's AgentConfig.permission shape. */
const permissionActionSchema = z.enum(['allow', 'ask', 'deny']);
const permissionActionOrNullSchema = z.union([permissionActionSchema, z.null()]);
const permissionRuleSchema = z.union([
  permissionActionOrNullSchema,
  z.record(z.string(), permissionActionOrNullSchema),
]);
const permissionConfigSchema = z.union([
  permissionActionSchema,
  z.record(z.string(), permissionRuleSchema),
]);

/** Runtime agent input (materialized to KILO_CONFIG_CONTENT.agent.<slug>) */
export const runtimeAgentInputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z][a-z0-9-]*$/, 'Agent slug must start with a letter'),
  name: z.string().min(1).max(100),
  config: z
    .object({
      prompt: z.string().max(50_000).optional(),
      description: z.string().max(2_000).optional(),
      mode: z.enum(['subagent', 'primary', 'all']).optional(),
      model: z.string().max(200).nullable().optional(),
      variant: z.string().max(50).optional(),
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      steps: z.number().int().positive().optional(),
      hidden: z.boolean().optional(),
      disable: z.boolean().optional(),
      color: z.string().max(50).optional(),
      permission: permissionConfigSchema.optional(),
      options: z.record(z.string(), z.unknown()).optional(),
    })
    // Variant keys are model-specific, so a variant without a model has no
    // anchor — mirror the AgentConfigSchema invariant from @kilocode/db.
    .refine(c => !c.variant || (typeof c.model === 'string' && c.model.length > 0), {
      message: 'variant requires a model — variants are model-specific',
      path: ['variant'],
    }),
});

/**
 * Mode field accepted by prepare/update-session calls. Allows built-in
 * enum values plus any custom slug — cloud-agent-next cross-validates the
 * slug against the session's `runtimeAgents` list.
 */
export const preparedSessionModeSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z][a-z0-9-]*$/, 'Mode must be a slug');

// Combined MCP server configuration schema — CLI-native local/remote format
export const mcpServerConfigNextSchema = z.discriminatedUnion('type', [
  mcpLocalServerConfigSchema,
  mcpRemoteServerConfigSchema,
]);

// Schema for preparing a session
export const basePrepareSessionNextSchema = z
  .object({
    // Repository source (mutually exclusive - must provide exactly one)
    githubRepo: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Invalid repository format')
      .optional(),
    gitlabProject: z
      .string()
      .regex(
        /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/,
        'Invalid project path format. Expected: group/project or group/subgroup/project'
      )
      .optional()
      .describe('GitLab project path (e.g., group/project or group/subgroup/project)'),

    // Execution params (required)
    prompt: z.string().min(1).max(100_000),
    mode: preparedSessionModeSchema,
    model: z.string().min(1),
    variant: z
      .string()
      .max(50)
      .regex(/^[a-zA-Z]+$/)
      .optional(),

    /**
     * Optional environment profile id. When omitted, the effective default
     * profile (personal default wins over org default) is used.
     */
    profileId: z.uuid().optional(),

    // Optional configuration
    envVars: z.record(z.string().max(256), z.string().max(256)).optional(),
    setupCommands: z.array(z.string().max(500)).max(20).optional(),
    mcpServers: z.record(z.string(), mcpServerConfigNextSchema).optional(),
    runtimeSkills: z.array(runtimeSkillInputSchema).max(50).optional(),
    runtimeAgents: z.array(runtimeAgentInputSchema).max(20).optional(),
    upstreamBranch: z.string().optional(),
    autoCommit: z.boolean().optional(),
    autoInitiate: z.boolean().optional(),
    initialMessageId: z.string().startsWith('msg_').length(30).optional(),
    images: cloudAgentImagesSchema,
    devcontainer: z.boolean().optional(),
  })
  .refine(
    data => (data.githubRepo || data.gitlabProject) && !(data.githubRepo && data.gitlabProject),
    {
      message: 'Must provide either githubRepo or gitlabProject, but not both',
      path: ['githubRepo'],
    }
  );

// Output schema for prepareSession
export const basePrepareSessionNextOutputSchema = z.object({
  kiloSessionId: z.string().startsWith('ses_').length(30),
  cloudAgentSessionId: z.string(),
});

// Schema for initiating from a prepared session
export const baseInitiateFromPreparedSessionNextSchema = z.object({
  cloudAgentSessionId: z.string(),
});

/**
 * Mode field for sendMessage. Built-in enum slugs plus any custom slug —
 * cloud-agent-next cross-validates against the session's stored runtimeAgents.
 * The reserved slug `custom` is still rejected here (requires prepare).
 */
export const agentModeSendMessageSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z][a-z0-9-]*$/, 'Mode must be a slug')
  .refine(mode => mode !== 'custom', {
    message: 'Custom mode requires prepareSession/updateSession, not sendMessage',
  });

/**
 * Discriminated payload for sendMessage — free-text prompt or structured slash
 * command. Mirrors the worker's SendMessageV2Payload schema; both variants
 * ride the same execution pipeline on the cloud-agent-next side.
 */
export const sendMessageNextPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('prompt'),
    prompt: z.string().min(1),
    mode: agentModeSendMessageSchema,
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

// Schema for sending a message (V2 - uses cloudAgentSessionId)
export const baseSendMessageNextSchema = z.object({
  cloudAgentSessionId: z.string(),
  payload: sendMessageNextPayloadSchema,
  autoCommit: z.boolean().optional(),
  messageId: z.string().startsWith('msg_').length(30).optional(),
  images: cloudAgentImagesSchema,
});

// Schema for interrupting a session
export const baseInterruptSessionNextSchema = z.object({
  sessionId: z.string(),
});

// Schema for getting session state
export const baseGetSessionNextSchema = z.object({
  cloudAgentSessionId: z.string(),
});

export const cloudAgentTerminalSizeSchema = z.object({
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(2).max(200),
});

export const cloudAgentTerminalPtyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const cloudAgentTerminalPtySchema = z.object({
  id: cloudAgentTerminalPtyIdSchema,
  title: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  status: z.enum(['running', 'exited']),
  pid: z.number().int(),
});

export const baseCreateTerminalNextSchema = z
  .object({
    cloudAgentSessionId: z.string(),
  })
  .extend(cloudAgentTerminalSizeSchema.partial().shape)
  .refine(data => (data.cols === undefined) === (data.rows === undefined), {
    message: 'cols and rows must be provided together',
  });

export const baseResizeTerminalNextSchema = z
  .object({
    cloudAgentSessionId: z.string(),
    ptyId: cloudAgentTerminalPtyIdSchema,
  })
  .extend(cloudAgentTerminalSizeSchema.shape);

export const baseCloseTerminalNextSchema = z.object({
  cloudAgentSessionId: z.string(),
  ptyId: cloudAgentTerminalPtyIdSchema,
});

export const baseCreateTerminalNextOutputSchema = z.object({
  pty: cloudAgentTerminalPtySchema,
  ptyId: cloudAgentTerminalPtyIdSchema,
  wsUrl: z.string().min(1),
  ticket: z.string().min(1),
  expiresAt: z.number().int().positive(),
});

export const baseRefreshTerminalTicketNextSchema = z.object({
  cloudAgentSessionId: z.string(),
  ptyId: cloudAgentTerminalPtyIdSchema,
});

export const baseRefreshTerminalTicketNextOutputSchema = z.object({
  wsUrl: z.string().min(1),
  ticket: z.string().min(1),
  expiresAt: z.number().int().positive(),
});

export const baseResizeTerminalNextOutputSchema = z.object({
  pty: cloudAgentTerminalPtySchema,
});

export const baseCloseTerminalNextOutputSchema = z.object({
  success: z.boolean(),
});

// Execution status schema for getSession response
export const executionStatusNextSchema = z
  .object({
    id: z.string(),
    status: z.enum(['pending', 'running', 'completed', 'failed', 'interrupted']),
    startedAt: z.number(),
    lastHeartbeat: z.number().nullable(),
    processId: z.string().nullable(),
    error: z.string().nullable(),
    health: z.enum(['healthy', 'stale', 'unknown']),
  })
  .nullable();

// Callback target configuration
export const callbackTargetNextSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

// Output schema for getSession (sanitized, no secrets)
export const baseGetSessionNextOutputSchema = z.object({
  // Session identifiers
  sessionId: z.string(),
  kiloSessionId: z.string().startsWith('ses_').length(30).optional(),
  userId: z.string(),
  orgId: z.string().optional(),
  sandboxId: z.string().optional(),

  // Repository info (no tokens)
  githubRepo: z.string().optional(),
  gitUrl: z.string().optional(),
  platform: z.enum(['github', 'gitlab']).optional(),

  // Execution params
  prompt: z.string().optional(),
  mode: z.string().optional(),
  model: z.string().optional(),
  variant: z.string().optional(),
  autoCommit: z.boolean().optional(),
  upstreamBranch: z.string().optional(),

  /** Custom agents stored on this session (shown in the chat picker). */
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
    .optional(),

  // Execution status (grouped for cleaner API)
  execution: executionStatusNextSchema,

  // Lifecycle timestamps
  preparedAt: z.number().optional(),
  initiatedAt: z.number().optional(),

  // Callback configuration
  callbackTarget: callbackTargetNextSchema.optional(),

  // Initial message ID for correlation
  initialMessageId: z.string().startsWith('msg_').length(30).optional(),

  // Versioning
  timestamp: z.number(),
  version: z.number(),
});

// Schema for answering a question
export const baseAnswerQuestionNextSchema = z.object({
  sessionId: z.string(),
  questionId: z.string().min(1),
  answers: z.array(z.array(z.string())),
});

// Schema for rejecting a question
export const baseRejectQuestionNextSchema = z.object({
  sessionId: z.string(),
  questionId: z.string().min(1),
});

// Schema for answering a permission request
export const baseAnswerPermissionNextSchema = z.object({
  sessionId: z.string(),
  permissionId: z.string().min(1),
  response: z.enum(['once', 'always', 'reject']),
});

// Output schema for V2 initiation/message procedures
export const baseInitiateSessionNextOutputSchema = z.object({
  cloudAgentSessionId: z.string(),
  executionId: z.string(),
  status: z.literal('started'),
  streamUrl: z.string().min(1), // Can be relative path or full URL
});
