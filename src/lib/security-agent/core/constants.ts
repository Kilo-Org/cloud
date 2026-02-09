/**
 * Security Agent - Constants
 *
 * Default configuration values and constants for the security agent.
 */

import type { SecurityAgentConfig } from './types';

/**
 * Available models for security agent analysis
 * Order matters - first one is the default
 */
export const SECURITY_AGENT_MODELS = [
  { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', free: false },
  { id: 'anthropic/claude-opus-4.5', name: 'Claude Opus 4.5', free: false },
  { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', free: false },
  { id: 'x-ai/grok-code-fast-1', name: 'Grok Code Fast 1 (free)', free: true },
] as const;

/**
 * Default model for security agent analysis
 */
export const DEFAULT_SECURITY_AGENT_MODEL = SECURITY_AGENT_MODELS[0].id;

/**
 * Default configuration for the security agent
 */
export const DEFAULT_SECURITY_AGENT_CONFIG: SecurityAgentConfig = {
  sla_critical_days: 15,
  sla_high_days: 30,
  sla_medium_days: 45,
  sla_low_days: 90,
  auto_sync_enabled: true,
  repository_selection_mode: 'all',
  model_slug: DEFAULT_SECURITY_AGENT_MODEL,
  // Auto-dismiss is off by default - users manually review and dismiss findings
  auto_dismiss_enabled: false,
  auto_dismiss_confidence_threshold: 'high',
};
