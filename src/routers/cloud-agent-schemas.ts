import * as z from 'zod';

/**
 * Shared schemas for cloud agent routers
 */

// Agent mode enum
export const agentModeSchema = z.enum(['architect', 'code', 'ask', 'debug', 'orchestrator']);

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
export const mcpServerConfigSchema = z.union([
  mcpStdioServerConfigSchema,
  mcpSseServerConfigSchema,
  mcpStreamableHttpServerConfigSchema,
]);

// Base schema for initiating a session (used by both personal and organization contexts)
export const baseInitiateSessionSchema = z.object({
  githubRepo: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Invalid repository format'),
  prompt: z.string().min(1),
  mode: agentModeSchema,
  model: z.string().min(1),
  envVars: z.record(z.string().max(256), z.string().max(256)).optional(),
  setupCommands: z.array(z.string().max(500)).max(20).optional(),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
  upstreamBranch: z.string().optional(),
  autoCommit: z.boolean().optional().default(false),
});

// Base schema for sending a message (used by both personal and organization contexts)
// Note: V1 uses sessionId, V2 uses cloudAgentSessionId
export const baseSendMessageSchema = z.object({
  sessionId: z.string(),
  prompt: z.string().min(1),
  mode: agentModeSchema,
  model: z.string().min(1),
  autoCommit: z.boolean().optional().default(false),
});

// V2 schema for sending a message - uses cloudAgentSessionId to match worker schema
export const baseSendMessageV2Schema = z.object({
  cloudAgentSessionId: z.string(),
  prompt: z.string().min(1),
  mode: agentModeSchema,
  model: z.string().min(1),
  autoCommit: z.boolean().optional().default(false),
});

// Base schema for interrupting a session (used by both personal and organization contexts)
export const baseInterruptSessionSchema = z.object({
  sessionId: z.string(),
});

// Base schema for initiating from a Kilocode CLI session (legacy mode with full params)
export const baseInitiateFromKilocodeSessionLegacySchema = z.object({
  kiloSessionId: z.string().uuid(),
  githubRepo: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Invalid repository format'),
  prompt: z.string().min(1),
  mode: agentModeSchema,
  model: z.string().min(1),
  envVars: z.record(z.string().max(256), z.string().max(256)).optional(),
  setupCommands: z.array(z.string().max(500)).max(20).optional(),
  autoCommit: z.boolean().optional().default(false),
});

// New schema for initiating from a prepared session (cloudAgentSessionId only)
export const baseInitiateFromPreparedSessionSchema = z.object({
  cloudAgentSessionId: z.string(),
});

// Combined schema supporting both legacy and new modes
export const baseInitiateFromKilocodeSessionSchema = z.union([
  baseInitiateFromPreparedSessionSchema,
  baseInitiateFromKilocodeSessionLegacySchema,
]);

// Base schema for preparing a session (creates cliSession in backend, stores params in DO)
// Must provide either `githubRepo` OR `gitlabProject`, but not both.
export const basePrepareSessionSchema = z
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
    mode: agentModeSchema,
    model: z.string().min(1),

    // Optional environment profile name (resolved server-side)
    profileName: z.string().max(100).optional(),

    // Optional configuration
    envVars: z.record(z.string().max(256), z.string().max(256)).optional(),
    setupCommands: z.array(z.string().max(500)).max(20).optional(),
    mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
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
export const basePrepareSessionOutputSchema = z.object({
  kiloSessionId: z.string().uuid(),
  cloudAgentSessionId: z.string(),
});

// Base schema for preparing an existing session (no new CLI session)
export const basePrepareLegacySessionSchema = basePrepareSessionSchema.extend({
  cloudAgentSessionId: z.string(),
  kiloSessionId: z.string().uuid(),
});

export const basePrepareLegacySessionOutputSchema = basePrepareSessionOutputSchema;

// Base schema for getting session state (used by both personal and organization contexts)
export const baseGetSessionSchema = z.object({
  cloudAgentSessionId: z.string(),
});

const executionStateSchema = z.object({
  id: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted']),
  startedAt: z.number().optional(),
  lastHeartbeat: z.number().optional(),
  processId: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  health: z.enum(['healthy', 'stale', 'unknown']).optional(),
});

// Output schema for getSession (sanitized, no secrets)
export const baseGetSessionOutputSchema = z.object({
  // Session identifiers
  sessionId: z.string(),
  kiloSessionId: z.string().uuid().optional(),
  userId: z.string(),
  orgId: z.string().optional(),
  sandboxId: z.string().optional(),

  // Repository info (no tokens)
  githubRepo: z.string().optional(),
  gitUrl: z.string().optional(),

  // Execution params
  prompt: z.string().optional(),
  mode: agentModeSchema.optional(),
  model: z.string().optional(),
  autoCommit: z.boolean().optional(),
  condenseOnComplete: z.boolean().optional(),
  upstreamBranch: z.string().optional(),

  // Configuration metadata (counts only, no values)
  envVarCount: z.number().optional(),
  setupCommandCount: z.number().optional(),
  mcpServerCount: z.number().optional(),

  // Current execution state (null if no execution in flight)
  execution: executionStateSchema.nullable().optional(),
  queuedCount: z.number().optional(),

  // Lifecycle timestamps
  preparedAt: z.number().optional(),
  initiatedAt: z.number().optional(),

  // Versioning
  timestamp: z.number(),
  version: z.number(),
});

type PreparedSessionInput = { cloudAgentSessionId: string };

/**
 * Validates that a session input does not mix prepared and legacy mode fields.
 * Throws if both cloudAgentSessionId AND legacy fields (prompt, kiloSessionId) are present.
 *
 * Acts as a type guard to narrow the input type.
 *
 * @returns true if prepared mode (cloudAgentSessionId only), false if legacy mode
 */
export function isPreparedSessionInput(
  input: Record<string, unknown>
): input is PreparedSessionInput {
  const hasCloudAgentSessionId = 'cloudAgentSessionId' in input;
  const hasLegacyFields = 'prompt' in input && 'kiloSessionId' in input;

  if (hasCloudAgentSessionId && hasLegacyFields) {
    throw new Error(
      'Invalid request: cannot provide both cloudAgentSessionId and legacy fields (prompt, kiloSessionId)'
    );
  }

  return hasCloudAgentSessionId && !hasLegacyFields;
}

// Schema for FIM autocomplete requests (prefix/suffix based)
export const fimAutocompleteSchema = z.object({
  prefix: z.string().min(1).max(2000),
  suffix: z.string().max(2000).optional(),
  requestId: z.string().min(1).max(20),
});
