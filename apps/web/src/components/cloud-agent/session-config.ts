import type { SessionConfig, ResumeConfig, StreamResumeConfig, AgentMode } from './types';

// Re-export AgentMode for backwards compatibility
export type { AgentMode };

type ResumeConfigInput = {
  mode: string;
  model: string;
  envVars?: Record<string, string>;
  setupCommands?: string[];
};

export type DbSessionInfo = {
  last_mode: string | null;
  last_model: string | null;
};

export type BuildSessionConfigOptions = {
  /** Session ID (cloud agent or kilo session) */
  sessionId: string;

  /** Repository in owner/repo format */
  repository?: string | null;

  /** Resume config from user modal (highest priority) */
  resumeConfig?: ResumeConfigInput | null;

  /** Session info from database (second priority) */
  dbSession?: DbSessionInfo | null;

  defaultMode?: AgentMode;

  defaultModel?: string;
};

export function buildSessionConfig(options: BuildSessionConfigOptions): SessionConfig {
  const {
    sessionId,
    repository,
    resumeConfig,
    dbSession,
    defaultMode = 'code',
    defaultModel = '',
  } = options;

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
 * Check if a SessionConfig has valid mode and model for sendMessageStream.
 *
 * The sendMessageStream schema requires:
 * - mode: one of the valid agent modes
 * - model: non-empty string (min 1 character)
 */
export function isValidSessionConfig(config: SessionConfig | null): config is SessionConfig {
  if (!config) return false;

  const validModes: AgentMode[] = ['architect', 'code', 'ask', 'debug', 'orchestrator'];
  const hasValidMode = validModes.includes(config.mode as AgentMode);
  const hasValidModel = config.model.length > 0;

  return hasValidMode && hasValidModel;
}

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

  if (dbSession?.last_mode) {
    mode = dbSession.last_mode;
    modeSource = 'dbSession';
  }
  if (dbSession?.last_model) {
    model = dbSession.last_model;
    modelSource = 'dbSession';
  }

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
