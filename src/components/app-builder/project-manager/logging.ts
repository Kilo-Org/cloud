/**
 * Logging utilities for ProjectManager — prefixed console logging and error formatting.
 */

import { TRPCClientError } from '@trpc/client';

export type Logger = {
  log: (...args: unknown[]) => void;
  logWarn: (...args: unknown[]) => void;
  logError: (...args: unknown[]) => void;
};

export function createLogger(projectId?: string): Logger {
  const prefix = projectId ? `[ProjectManager:${projectId}]` : '[ProjectManager]';

  return {
    log: (...args: unknown[]): void => {
      console.log(prefix, ...args);
    },
    logWarn: (...args: unknown[]): void => {
      console.warn(prefix, ...args);
    },
    logError: (...args: unknown[]): void => {
      console.error(prefix, ...args);
    },
  };
}

/** Formats stream errors into user-friendly messages, handling tRPC error codes. */
export function formatStreamError(err: unknown): string {
  if (err instanceof TRPCClientError) {
    const code = err.data?.code ?? err.shape?.code;
    const httpStatus = err.data?.httpStatus ?? err.shape?.data?.httpStatus;

    if (code === 'PAYMENT_REQUIRED' || httpStatus === 402) {
      return 'Insufficient credits. Please add at least $1 to continue using App Builder.';
    }
    if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
      return 'You are not authorized to use the App Builder.';
    }
    if (code === 'NOT_FOUND') {
      return 'App Builder service is unavailable right now. Please try again.';
    }
    return 'App Builder encountered an error. Please retry in a moment.';
  }
  if (err instanceof Error) {
    if (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')) {
      return 'Lost connection to App Builder. Please retry in a moment.';
    }
    return 'App Builder connection failed. Please retry in a moment.';
  }
  return 'App Builder error. Please retry in a moment.';
}
