import { z } from 'zod';
import type { MCPServerConfig } from './persistence/types.js';

// === Agent Modes ===
/**
 * Internal agent modes used by the kilo CLI.
 * These are the actual modes passed to `kilo run --agent <mode>`.
 */
export const InternalAgentModes = [
  'code',
  'plan',
  'debug',
  'orchestrator',
  'ask',
  'custom',
] as const;
export type InternalAgentMode = (typeof InternalAgentModes)[number];

/**
 * Input agent modes accepted by the API.
 * These include backward-compatible aliases:
 * - build: maps to 'code'
 * - architect: maps to 'plan'
 * All other modes pass through 1:1 to the CLI.
 */
export const AgentModes = [
  'code',
  'plan',
  'debug',
  'orchestrator',
  'ask',
  'build',
  'architect',
  'custom',
] as const;
/**
 * AgentMode accepts any string — built-in slugs from `AgentModes` or any
 * custom slug from a session's `runtimeAgents`. Use `AgentModeSchema` to
 * validate that a value is one of the built-ins specifically.
 */
export type AgentMode = string;
export type BuiltinAgentMode = (typeof AgentModes)[number];
export const AgentModeSchema = z.enum(AgentModes);

/**
 * Maps input agent modes to internal modes used by kilo CLI. Built-ins are
 * aliased (build → code, architect → plan); any non-built-in slug (from a
 * runtimeMode) is passed through unchanged.
 */
export function normalizeAgentMode(mode: string): string {
  switch (mode) {
    case 'build':
      return 'code';
    case 'architect':
      return 'plan';
    default:
      return mode;
  }
}

// === Limits ===
export const Limits = {
  MAX_PROMPT_LENGTH: 100_000, // 100KB
  MAX_ENV_VARS: 50,
  MAX_ENV_VAR_KEY_LENGTH: 128, // Env var keys are typically short identifiers
  MAX_ENV_VAR_VALUE_LENGTH: 4096, // Env var values can be longer (connection strings, etc.)
  MAX_SETUP_COMMANDS: 20,
  MAX_SETUP_COMMAND_LENGTH: 500,
  MAX_MCP_SERVERS: 20,
  MAX_RUNTIME_SKILLS: 50,
  MAX_RUNTIME_SKILL_MARKDOWN: 100_000, // ~100KB
  MAX_RUNTIME_SKILL_NAME_LENGTH: 100,
  MAX_RUNTIME_SKILL_COMPANION_FILES: 20,
  MAX_RUNTIME_SKILL_COMPANION_FILE_SIZE: 100_000,
  MAX_RUNTIME_SKILL_COMPANION_FILES_TOTAL: 500_000,
  MAX_RUNTIME_SKILL_COMPANION_PATH_LENGTH: 200,
  MAX_RUNTIME_AGENTS: 20,
  MAX_RUNTIME_AGENT_SLUG_LENGTH: 50,
  MAX_RUNTIME_AGENT_NAME_LENGTH: 100,
  MAX_RUNTIME_AGENT_PROMPT: 50_000,
  MAX_RUNTIME_AGENT_DESCRIPTION: 2000,
  MAX_RUNTIME_AGENT_MODEL_LENGTH: 200,
  MAX_RUNTIME_KILO_COMMANDS: 50,
  MAX_RUNTIME_KILO_COMMAND_NAME_LENGTH: 100,
  MAX_RUNTIME_KILO_COMMAND_TEMPLATE: 100_000,
  MAX_RUNTIME_KILO_COMMAND_DESCRIPTION: 2000,
  SESSION_TTL_DAYS: 90,
  SESSION_TTL_MS: 90 * 24 * 60 * 60 * 1000, // 90 days in milliseconds
} as const;

/** Built-in mode slugs recognized by the CLI. */
export const BUILTIN_AGENT_MODES = new Set<string>(AgentModes);

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
