/**
 * Structured logging utilities using workers-tagged-logger
 */

import { WorkersLogger } from 'workers-tagged-logger';

// Determine log level from environment
// In tests, we want to suppress most logs; in production, use 'info'
const getLogLevel = (): 'debug' | 'info' | 'warn' | 'error' => {
  // Check if we're in a test environment
  if (typeof process !== 'undefined' && process.env?.VITEST) {
    return 'error'; // Only show errors in tests
  }
  return 'info'; // Default to info in production
};

// Create a global logger instance
export const logger = new WorkersLogger({
  minimumLogLevel: getLogLevel(),
});
