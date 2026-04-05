import { WorkersLogger } from 'workers-tagged-logger';

export { formatError } from '@kilocode/worker-utils';

/**
 * Tag types for structured logging across app-builder
 */
export type AppBuilderTags = {
  // Core identifier (primary search key)
  appId?: string;

  // Request context
  source?: string; // Handler name: 'InitHandler', 'GitProtocol', 'PreviewHandler', etc.

  // Git context
  commitHash?: string;
  branchName?: string;
};

/**
 * Global logger instance for app-builder
 */
export const logger = new WorkersLogger<AppBuilderTags>({
  minimumLogLevel: 'debug',
  debug: false,
});

export { withLogTags, WithLogTags } from 'workers-tagged-logger';
