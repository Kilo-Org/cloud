import { AsyncLocalStorage } from 'node:async_hooks';
import { WorkersLogger, withLogTags as runWithLogTags } from 'workers-tagged-logger';
import type { CloudAgentSentryIdentity } from './shared/sentry.js';

/**
 * Tag types for structured logging across cloud-agent
 */
export type CloudAgentTags = {
  // Core identifiers
  sessionId?: string;
  cloudAgentSessionId?: string;
  userId?: string;
  sandboxId?: string;
  sandboxKind?: 'bot' | 'user';
  orgId?: string;
  executionId?: string;
  botId?: string;
  inflightId?: string;

  // Execution context — built-in slug or a profile-defined custom slug
  mode?: string;
  model?: string;
  isResume?: boolean;

  // Repository context
  githubRepo?: string;
  branchName?: string;
  workspacePath?: string;

  // Source tracking (auto-added by decorators)
  source?: string;

  // Stable searchable log tag for cross-cutting events
  logTag?: string;
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

const sentryLogTags = new AsyncLocalStorage<WeakMap<Error, CloudAgentSentryIdentity>>();

export function withSentryLogTagCapture<T>(fn: () => T): T {
  return sentryLogTags.run(new WeakMap(), fn);
}

function logIdentity(): CloudAgentSentryIdentity {
  const { userId, orgId, sessionId, sandboxId, cloudAgentSessionId } = logger.getTags();
  return {
    userId,
    orgId,
    sessionId:
      sessionId ?? (typeof cloudAgentSessionId === 'string' ? cloudAgentSessionId : undefined),
    sandboxId,
  };
}

export function sentryLogIdentity(error: unknown): CloudAgentSentryIdentity {
  const captured = sentryLogTags.getStore();
  if (captured && error instanceof Error) {
    const identity =
      captured.get(error) ?? (error.cause instanceof Error ? captured.get(error.cause) : undefined);
    if (identity) return identity;
  }
  return logIdentity();
}

type LogTagOptions = Parameters<typeof runWithLogTags>[0];

export function withLogTags<T>(options: LogTagOptions, fn: () => T): T;
export function withLogTags(options: LogTagOptions, fn: () => unknown): unknown {
  const captured = sentryLogTags.getStore();
  if (!captured) return runWithLogTags(options, fn);
  return runWithLogTags(options, () => {
    const recordAndRethrow = (error: unknown): never => {
      // tRPC reports outside the procedure's log scope, after the tags are gone.
      if (error instanceof Error && !captured.has(error)) captured.set(error, logIdentity());
      throw error;
    };
    try {
      const result = fn();
      return result instanceof Promise ? result.catch(recordAndRethrow) : result;
    } catch (error) {
      return recordAndRethrow(error);
    }
  });
}

export { WithLogTags } from 'workers-tagged-logger';
