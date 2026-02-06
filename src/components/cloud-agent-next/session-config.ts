/**
 * Session Config Utilities
 *
 * Centralized logic for building, validating, and deriving SessionConfig.
 */

import type { SessionConfig, ResumeConfig, StreamResumeConfig, AgentMode } from './types';

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
 *   3. defaults (defaultMode/defaultModel or 'build'/'')
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
    defaultMode = 'build',
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
 * - mode: one of the valid agent modes (plan, build)
 * - model: non-empty string (min 1 character)
 *
 * @param config - SessionConfig to validate
 * @returns true if config is valid for sendMessage
 */
export function isValidSessionConfig(config: SessionConfig | null): config is SessionConfig {
  if (!config) return false;

  const validModes: AgentMode[] = ['plan', 'build'];
  const hasValidMode = validModes.includes(config.mode as AgentMode);
  const hasValidModel = config.model.length > 0;

  return hasValidMode && hasValidModel;
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
  const { resumeConfig, dbSession, defaults = { mode: 'build', model: '' } } = options;

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
  streamResumeConfig: StreamResumeConfig | null;
  sessionConfig: SessionConfig | null;
}): boolean {
  const { currentDbSessionId, resumeConfig, streamResumeConfig, sessionConfig } = params;

  if (!currentDbSessionId) return false;
  if (resumeConfig || streamResumeConfig) return false;
  return !isValidSessionConfig(sessionConfig);
}
