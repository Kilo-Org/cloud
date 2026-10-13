import { z } from 'zod';

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

/** Built-in mode slugs recognized by the CLI. */
export const BUILTIN_AGENT_MODES = new Set<string>(AgentModes);
