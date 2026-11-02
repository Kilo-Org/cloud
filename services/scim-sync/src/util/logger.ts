/**
 * Structured logging utilities using workers-tagged-logger
 */

import { WorkersLogger } from 'workers-tagged-logger';

const getLogLevel = (): 'debug' | 'info' | 'warn' | 'error' => {
  if (typeof process !== 'undefined' && process.env?.VITEST) {
    return 'error'; // Only show errors in tests
  }
  return 'info';
};

export const logger = new WorkersLogger({
  minimumLogLevel: getLogLevel(),
});
