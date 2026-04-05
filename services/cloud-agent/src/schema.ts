import { z } from 'zod';
import type { MCPServerConfig } from './persistence/types.js';

// === Enums ===
export const AgentModes = ['architect', 'code', 'ask', 'debug', 'orchestrator'] as const;
export type AgentMode = (typeof AgentModes)[number];
export const AgentModeSchema = z.enum(AgentModes);

// === Limits ===
export const Limits = {
  MAX_PROMPT_LENGTH: 100_000, // 100KB
  MAX_ENV_VARS: 50,
  MAX_ENV_VAR_KEY_LENGTH: 128, // Env var keys are typically short identifiers
  MAX_ENV_VAR_VALUE_LENGTH: 4096, // Env var values can be longer (connection strings, etc.)
  MAX_SETUP_COMMANDS: 20,
  MAX_SETUP_COMMAND_LENGTH: 500,
  MAX_MCP_SERVERS: 20,
  SESSION_TTL_DAYS: 90,
  SESSION_TTL_MS: 90 * 24 * 60 * 60 * 1000, // 90 days in milliseconds
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
