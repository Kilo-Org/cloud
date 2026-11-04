/**
 * Structured logging utilities using workers-tagged-logger
 */

import { WorkersLogger } from 'workers-tagged-logger';

export const logger = new WorkersLogger({
  minimumLogLevel: 'info',
});
