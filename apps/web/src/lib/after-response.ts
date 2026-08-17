/**
 * Single implementation of the post-response scheduling helper used by
 * provider-webhook and store-notification paths.
 */
import 'server-only';

import { captureException } from '@sentry/nextjs';
import { after } from 'next/server';

import { IS_IN_AUTOMATED_TEST } from '@/lib/config.server';

/**
 * Runs `work` after the response has been sent so serverless functions stay
 * alive for it. In automated tests the work runs inline so jest can assert on
 * it. Best-effort: a synchronous `after()` failure (called outside a request
 * scope) or a rejection from the scheduled work promise is Sentry-reported
 * here and never propagates to the caller or becomes an unhandled rejection.
 */
export async function runAfterResponse(work: () => Promise<void>): Promise<void> {
  if (IS_IN_AUTOMATED_TEST) {
    await work();
    return;
  }
  try {
    // Return the rejection-handled promise so the runtime awaits the work.
    after(() => work().catch(reportAfterResponseError));
  } catch (error) {
    reportAfterResponseError(error);
  }
}

function reportAfterResponseError(error: unknown): void {
  captureException(error, {
    tags: { source: 'run_after_response' },
  });
}
