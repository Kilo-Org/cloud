import 'server-only';
import { captureException } from '@sentry/nextjs';

/**
 * Report a step-up infrastructure failure without the original error. Drizzle
 * errors embed statement parameters, which can include session hashes and
 * challenges; only the error shape is safe to send.
 */
export function reportStepUpFailure(source: string, error: unknown): void {
  captureException(new Error('step_up_failure'), {
    tags: { source },
    extra: { errorName: error instanceof Error ? error.name : typeof error },
  });
}
