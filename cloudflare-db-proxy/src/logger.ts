import { WorkersLogger } from 'workers-tagged-logger';

export { formatError } from '@kilocode/worker-utils';

/**
 * Tag types for structured logging across db-proxy
 */
export type DbProxyTags = {
  // Core identifier (primary search key)
  appId?: string;

  // Request context
  source?: string; // 'runtime' | 'admin'
  operation?: string; // 'query' | 'batch' | 'provision' | 'credentials' | 'schema' | 'export'
};

/**
 * Global logger instance for db-proxy
 */
export const logger = new WorkersLogger<DbProxyTags>({
  minimumLogLevel: 'debug',
  debug: false,
});

export { withLogTags, WithLogTags } from 'workers-tagged-logger';
