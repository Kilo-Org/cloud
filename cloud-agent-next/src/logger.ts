import { WorkersLogger } from 'workers-tagged-logger';

/**
 * Tag types for structured logging across cloud-agent
 */
export type CloudAgentTags = {
  // Core identifiers
  sessionId?: string;
  userId?: string;
  sandboxId?: string;
  orgId?: string;
  executionId?: string;
  botId?: string;

  // Execution context
  mode?: 'plan' | 'code' | 'build' | 'orchestrator' | 'architect' | 'ask' | 'custom';
  model?: string;
  isResume?: boolean;

  // Repository context
  githubRepo?: string;
  branchName?: string;
  workspacePath?: string;

  // Source tracking (auto-added by decorators)
  source?: string;
};

/**
 * Global logger instance for cloud-agent
 *
 * Use debug mode in development to catch missing context issues.
 * In production, keep debug: false to reduce noise.
 */
export const logger = new WorkersLogger<CloudAgentTags>({
  // In production, only log warnings and errors by default
  // Individual contexts can override with setLogLevel()
  minimumLogLevel: 'debug',

  // Enable in development to catch missing withLogTags() contexts
  debug: false,
});

export { withLogTags, WithLogTags } from 'workers-tagged-logger';
