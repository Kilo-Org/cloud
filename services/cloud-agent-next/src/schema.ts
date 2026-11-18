import { z } from 'zod';
import type { MCPServerConfig } from './persistence/types.js';

export * from './shared/agent-modes.js';
import { type AgentMode } from './shared/agent-modes.js';
import { RuntimeProfileLimits } from './shared/runtime-profile.js';

/**
 * Thinking-effort variant for a model. Variants are model- and agent-specific
 * keys — the catalog's `opencode.variants`, or a stored profile agent's
 * `config.variant` — so the stored length bound is the only rule here: the
 * catalog, not this schema, decides which keys exist.
 */
export const AgentVariantSchema = z.string().min(1).max(50);

// === Limits ===
export const Limits = {
  MAX_PROMPT_LENGTH: 100_000, // 100KB
  MAX_ENV_VARS: 50,
  MAX_ENV_VAR_KEY_LENGTH: 128, // Env var keys are typically short identifiers
  MAX_ENV_VAR_VALUE_LENGTH: 4096, // Env var values can be longer (connection strings, etc.)
  MAX_MCP_SERVERS: 20,
  ...RuntimeProfileLimits,
  SESSION_TTL_DAYS: 90,
  SESSION_TTL_MS: 90 * 24 * 60 * 60 * 1000, // 90 days in milliseconds
  /** Maximum source sessions in one local-worktree-to-cloud continuation. */
  MAX_CONTINUE_SESSIONS: 10,
} as const;

// === ExecutionParams (for session-service) ===
export type ExecutionParams = {
  sessionId: string; // cloudAgentSessionId
  kiloSessionId: string;
  userId: string;
  orgId?: string;

  prompt: string;
  mode: AgentMode;
  model: string;

  githubRepo?: string;
  githubToken?: string;
  gitUrl?: string;
  gitToken?: string;

  envVars?: Record<string, string>;
  setupCommands?: string[];
  mcpServers?: Record<string, MCPServerConfig>;
  autoCommit?: boolean;
};
