/**
 * Structured logging utilities using workers-tagged-logger
 */

import { WorkersLogger } from 'workers-tagged-logger';

// Create a global logger instance
export const logger = new WorkersLogger({
  minimumLogLevel: 'debug',
});
