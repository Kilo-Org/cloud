/**
 * Mode conversion utilities for cloud-agent-next
 *
 * The new cloud-agent-next uses 'plan' | 'build' modes, while the current
 * tRPC endpoints use the legacy 'architect' | 'code' | 'ask' | 'debug' | 'orchestrator' modes.
 *
 * This module provides conversion functions to bridge the gap until the new
 * worker endpoints are ready.
 */

export type NewAgentMode = 'plan' | 'build';
export type LegacyAgentMode = 'architect' | 'code' | 'ask' | 'debug' | 'orchestrator';

/**
 * Convert new mode to legacy mode for current tRPC endpoints
 */
export function newModeToLegacy(mode: NewAgentMode): LegacyAgentMode {
  switch (mode) {
    case 'plan':
      return 'architect';
    case 'build':
      return 'code';
  }
}

/**
 * Convert legacy mode to new mode
 */
export function legacyModeToNew(mode: LegacyAgentMode): NewAgentMode {
  switch (mode) {
    case 'architect':
    case 'ask':
      return 'plan';
    case 'code':
    case 'debug':
    case 'orchestrator':
      return 'build';
  }
}

/**
 * Check if a mode is a new-style mode
 */
export function isNewMode(mode: string): mode is NewAgentMode {
  return mode === 'plan' || mode === 'build';
}

/**
 * Check if a mode is a legacy-style mode
 */
export function isLegacyMode(mode: string): mode is LegacyAgentMode {
  return ['architect', 'code', 'ask', 'debug', 'orchestrator'].includes(mode);
}
