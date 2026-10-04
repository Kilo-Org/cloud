import { IS_IN_AUTOMATED_TEST } from '@/lib/config.server';
import { captureMessage } from '@sentry/nextjs';
import type { SeverityLevel } from '@sentry/nextjs';

const isInTestMode = IS_IN_AUTOMATED_TEST;
const consoleExceptInTest = (kind: 'debug' | 'info' | 'log' | 'warn' | 'error') =>
  (isInTestMode ? () => {} : console[kind]) satisfies typeof console.log;

export const logExceptInTest = consoleExceptInTest('log');

export const warnExceptInTest = consoleExceptInTest('warn');

export const errorExceptInTest = consoleExceptInTest('error');

export function sentryLogger(source: string, severity: SeverityLevel = 'log') {
  const logger = consoleExceptInTest(
    severity === 'fatal' ? 'error' : severity === 'warning' ? 'warn' : severity
  );
  return function logAndMaybeCaptureInSentry(message: string, ...args: unknown[]) {
    logger(message, ...args);
    if (severity === 'warning' || severity === 'error' || severity === 'fatal') {
      captureMessage(message, {
        level: severity,
        tags: { source },
        extra: args.length ? { args } : undefined,
      });
    }
  };
}
