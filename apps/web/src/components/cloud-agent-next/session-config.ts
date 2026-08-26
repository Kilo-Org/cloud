/**
 * Session Config Utilities
 *
 * Centralized logic for building, validating, and deriving SessionConfig.
 */

import type { SessionConfig, ResumeConfig, AgentMode } from './types';

// Re-export AgentMode for backwards compatibility
export type { AgentMode };

type ResumeConfigInput = {
  mode: string;
  model: string;
  envVars?: Record<string, string>;
  setupCommands?: string[];
};

/**
 * Partial session info from DB (last_mode/last_model)
 */
export type DbSessionInfo = {
  last_mode: string | null;
  last_model: string | null;
};

/**
 * Options for building a session config
 */
export type BuildSessionConfigOptions = {
  /** Session ID (cloud agent or kilo session) */
  sessionId: string;

  /** Repository in owner/repo format */
  repository?: string | null;

  /** Resume config from user modal (highest priority) */
  resumeConfig?: ResumeConfigInput | null;

  /** Session info from database (second priority) */
  dbSession?: DbSessionInfo | null;

  /** Default mode to use if not found elsewhere */
  defaultMode?: AgentMode;

  /** Default model to use if not found elsewhere */
  defaultModel?: string;
};

/**
 * Build a SessionConfig with clear precedence order.
 *
 * Precedence for mode/model:
 *   1. resumeConfig (from ResumeConfigModal or CLI resume flow)
 *   2. dbSession (last_mode/last_model from database)
 *   3. defaults (defaultMode/defaultModel or 'code'/'')
 *
 * @param options - Configuration sources and defaults
 * @returns Complete SessionConfig object
 *
 * @example
 * // Loading from DB (prepared session)
 * const config = buildSessionConfig({
 *   sessionId: session.cloud_agent_session_id,
 *   repository: extractRepoFromGitUrl(session.git_url),
 *   dbSession: { last_mode: session.last_mode, last_model: session.last_model },
 * });
 *
 * @example
 * // Resume modal confirmed
 * const config = buildSessionConfig({
 *   sessionId: session.session_id,
 *   repository: resumeConfig.githubRepo,
 *   resumeConfig,
 * });
 */
export function buildSessionConfig(options: BuildSessionConfigOptions): SessionConfig {
  const {
    sessionId,
    repository,
    resumeConfig,
    dbSession,
    defaultMode = 'code',
    defaultModel = '',
  } = options;

  // Precedence: resumeConfig > dbSession > defaults
  const mode = resumeConfig?.mode || dbSession?.last_mode || defaultMode;
  const model = resumeConfig?.model || dbSession?.last_model || defaultModel;

  return {
    sessionId,
    repository: repository || '',
    mode,
    model,
  };
}

/**
 * Check if a SessionConfig has valid mode and model for sendMessage.
 *
 * The sendMessage schema requires:
 * - mode: any non-empty slug after alias normalization (`build` → `code`,
 *   `architect` → `plan`)
 * - model: non-empty string (min 1 character)
 *
 * @param config - SessionConfig to validate
 * @returns true if config is valid for sendMessage
 */
export function isValidSessionConfig(config: SessionConfig | null): config is SessionConfig {
  if (!config) return false;

  const mode = normalizeAlias(config.mode);
  const hasValidMode = mode.length > 0;
  const hasValidModel = config.model.length > 0;

  return hasValidMode && hasValidModel;
}

/**
 * Map legacy mode aliases to their canonical built-in slugs.
 *
 * `build` → `code` and `architect` → `plan`. Empty, null, and undefined stay
 * empty so the mode control shows "Select mode" rather than "Code". Any other
 * non-empty slug passes through unchanged.
 */
export function normalizeAlias(mode: string | null | undefined): string {
  if (mode === 'build') return 'code';
  if (mode === 'architect') return 'plan';
  return mode ?? '';
}

/**
 * Resolve a mode for the mode control. Empty, null, and undefined become
 * `undefined` so the picker shows its "Select mode" placeholder instead of
 * defaulting to "Code".
 */
export function modeControlValue(mode: string | null | undefined): string | undefined {
  return normalizeAlias(mode) || undefined;
}

/** The five built-in agent mode slugs. */
const BUILTIN_MODE_SET: ReadonlySet<string> = new Set([
  'code',
  'plan',
  'debug',
  'orchestrator',
  'ask',
]);

/** True when `value` is one of the five built-in slugs. */
export function isBuiltinAgentMode(value: string): boolean {
  return BUILTIN_MODE_SET.has(value);
}

/** One custom-mode row in the mode picker. */
export type CustomModeOption = {
  value: string;
  label: string;
  description: string;
};

/**
 * Drop custom options that collide with a built-in slug and de-duplicate by
 * value (first occurrence wins).
 */
export function dedupeCustomModeOptions(options: CustomModeOption[]): CustomModeOption[] {
  const seen = new Set<string>();
  const result: CustomModeOption[] = [];
  for (const option of options) {
    if (option.value === '' || isBuiltinAgentMode(option.value) || seen.has(option.value)) {
      continue;
    }
    seen.add(option.value);
    result.push(option);
  }
  return result;
}

/**
 * Append the selected slug once when it is neither a built-in nor already in
 * the custom list, so a prefill or inherited custom slug stays visible.
 */
export function ensureSelectedCustomOption(
  custom: CustomModeOption[],
  selected: string
): CustomModeOption[] {
  if (!selected || isBuiltinAgentMode(selected) || custom.some(o => o.value === selected)) {
    return custom;
  }
  return [...custom, { value: selected, label: selected, description: '' }];
}

/**
 * Get mode and model from various sources with debug info.
 *
 * Useful for logging which source provided the values.
 *
 * @param options - Configuration sources
 * @returns Object with mode, model, and source info
 */
export function getModeModelWithSource(options: {
  resumeConfig?: ResumeConfigInput | null;
  dbSession?: DbSessionInfo | null;
  defaults?: { mode: string; model: string };
}): { mode: string; model: string; modeSource: string; modelSource: string } {
  const { resumeConfig, dbSession, defaults = { mode: 'code', model: '' } } = options;

  let mode: string = defaults.mode;
  let model: string = defaults.model;
  let modeSource = 'default';
  let modelSource = 'default';

  // Check dbSession first (lower priority)
  if (dbSession?.last_mode) {
    mode = dbSession.last_mode;
    modeSource = 'dbSession';
  }
  if (dbSession?.last_model) {
    model = dbSession.last_model;
    modelSource = 'dbSession';
  }

  // Then resumeConfig (higher priority - overwrites)
  if (resumeConfig?.mode) {
    mode = resumeConfig.mode;
    modeSource = 'resumeConfig';
  }
  if (resumeConfig?.model) {
    model = resumeConfig.model;
    modelSource = 'resumeConfig';
  }

  return { mode, model, modeSource, modelSource };
}

/** Check if a session needs configuration before sending messages. */
export function needsResumeConfiguration(params: {
  currentDbSessionId: string | null;
  resumeConfig: ResumeConfig | null;
  persistedResumeConfig: ResumeConfig | null;
  sessionConfig: SessionConfig | null;
}): boolean {
  const { currentDbSessionId, resumeConfig, persistedResumeConfig, sessionConfig } = params;

  if (!currentDbSessionId) return false;
  if (resumeConfig || persistedResumeConfig) return false;
  return !isValidSessionConfig(sessionConfig);
}
