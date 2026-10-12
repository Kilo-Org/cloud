import { z } from 'zod';

import { captureTelemetry } from '@/lib/telemetry/error-sink';

/**
 * The code both native modules reject with when the platform index does not
 * answer a call within its bound: CoreSpotlight on iOS, AppSearch on Android.
 * The index is unreachable for a while, mostly while the app is in the
 * background, so the call fails without any app defect.
 */
const SYSTEM_SEARCH_TIMEOUT_CODE = 'ERR_SYSTEM_SEARCH_TIMEOUT';

const SystemSearchTimeoutSchema = z.looseObject({ code: z.literal(SYSTEM_SEARCH_TIMEOUT_CODE) });

type SystemSearchOperation = 'sync' | 'clear';

/**
 * One report per failed index call, tagged so the subsystem is filterable.
 *
 * A timeout is not reported: the native ledger advances only on success, so the
 * next sync re-plans the same delta and the next signed-out launch repeats the
 * clear. Every other rejection is reported as-is. Never log a document id or a
 * title.
 */
export function reportSystemSearchFailure(operation: SystemSearchOperation, error: unknown): void {
  if (SystemSearchTimeoutSchema.safeParse(error).success) {
    return;
  }
  captureTelemetry({
    error,
    level: 'warning',
    tags: { 'error.subsystem': 'system-search', 'error.operation': operation },
  });
}
