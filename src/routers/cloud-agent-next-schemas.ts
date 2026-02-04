import * as z from 'zod';

/**
 * Shared schemas for cloud-agent-next routers
 *
 * Uses new modes (plan, build) and V2 WebSocket-based API only.
 */

/**
 * Agent mode enum - all supported modes.
 * - plan, architect, ask: Planning/analysis mode
 * - code, build, orchestrator: Code generation mode
 * - custom: Custom mode (requires appendSystemPrompt)
 */
export const agentModeNextSchema = z.enum([
  'plan',
  'code',
  'build',
  'orchestrator',
  'architect',
  'ask',
  'custom',
]);

// Base configuration shared by all MCP server types
const mcpServerBaseConfigSchema = z.object({
  disabled: z.boolean().optional(),
  timeout: z.number().min(1).max(3600).optional(),
  alwaysAllow: z.array(z.string()).optional(),
  watchPaths: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
});

// Stdio MCP server configuration (local process execution)
const mcpStdioServerConfigSchema = mcpServerBaseConfigSchema.extend({
  type: z.literal('stdio').optional(),
  command: z.string().min(1, 'Command cannot be empty'),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

// SSE MCP server configuration (Server-Sent Events)
const mcpSseServerConfigSchema = mcpServerBaseConfigSchema.extend({
  type: z.literal('sse'),
  url: z.string().url('URL must be a valid URL format'),
  headers: z.record(z.string(), z.string()).optional(),
});

// Streamable HTTP MCP server configuration
const mcpStreamableHttpServerConfigSchema = mcpServerBaseConfigSchema.extend({
  type: z.literal('streamable-http'),
  url: z.string().url('URL must be a valid URL format'),
  headers: z.record(z.string(), z.string()).optional(),
});

// Combined MCP server configuration schema supporting all transport types
export const mcpServerConfigNextSchema = z.union([
  mcpStdioServerConfigSchema,
  mcpSseServerConfigSchema,
  mcpStreamableHttpServerConfigSchema,
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
    mode: agentModeNextSchema,
    model: z.string().min(1),

    // Optional environment profile name (resolved server-side)
    profileName: z.string().max(100).optional(),

    // Optional configuration
    envVars: z.record(z.string().max(256), z.string().max(256)).optional(),
    setupCommands: z.array(z.string().max(500)).max(20).optional(),
    mcpServers: z.record(z.string(), mcpServerConfigNextSchema).optional(),
    upstreamBranch: z.string().optional(),
    autoCommit: z.boolean().optional().default(false),
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

// Agent mode for sendMessage (excludes custom - use prepareSession/updateSession for custom mode)
export const agentModeSendMessageSchema = z.enum(['plan', 'build']);

// Schema for sending a message (V2 - uses cloudAgentSessionId)
// Note: custom mode is not allowed for sendMessage - use prepareSession/updateSession instead
export const baseSendMessageNextSchema = z.object({
  cloudAgentSessionId: z.string(),
  prompt: z.string().min(1),
  mode: agentModeSendMessageSchema,
  model: z.string().min(1),
  autoCommit: z.boolean().optional().default(false),
});

// Schema for interrupting a session
export const baseInterruptSessionNextSchema = z.object({
  sessionId: z.string(),
});

// Schema for getting session state
export const baseGetSessionNextSchema = z.object({
  cloudAgentSessionId: z.string(),
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

  // Execution params
  prompt: z.string().optional(),
  mode: agentModeNextSchema.optional(),
  model: z.string().optional(),
  autoCommit: z.boolean().optional(),
  upstreamBranch: z.string().optional(),

  // Configuration metadata (counts only, no values)
  envVarCount: z.number().optional(),
  setupCommandCount: z.number().optional(),
  mcpServerCount: z.number().optional(),

  // Execution status (grouped for cleaner API)
  execution: executionStatusNextSchema,

  // Lifecycle timestamps
  preparedAt: z.number().optional(),
  initiatedAt: z.number().optional(),

  // Callback configuration
  callbackTarget: callbackTargetNextSchema.optional(),

  // Versioning
  timestamp: z.number(),
  version: z.number(),
});

// Output schema for V2 initiation/message procedures
export const baseInitiateSessionNextOutputSchema = z.object({
  cloudAgentSessionId: z.string(),
  executionId: z.string(),
  status: z.literal('started'),
  streamUrl: z.string().min(1), // Can be relative path or full URL
});
