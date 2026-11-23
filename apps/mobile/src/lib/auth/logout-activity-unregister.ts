import * as Sentry from '@sentry/react-native';

import {
  type ActivityUnregisterResult,
  getGlanceableDelivery,
} from '@/lib/glanceable/sink-registry';
import { isKeychainInteractionRefused } from '@/lib/telemetry/secure-store-events';

/**
 * Retire the activity tokens at logout, best effort, before the device session
 * revoke ends this credential's auth.
 *
 * A throw — from the delivery lookup or from the unregister promise — counts as
 * a failed unregister with no known tokens, so the caller's gather phase still
 * retires the device session and merges its cleanup record; the record then
 * keeps the activity obligation without token values. A locked device refusing
 * the keychain is that device's state, not a defect, so it is not reported.
 */
export async function unregisterActivityTokensBestEffort(): Promise<ActivityUnregisterResult> {
  try {
    return await getGlanceableDelivery().unregisterTokens();
  } catch (error) {
    if (!isKeychainInteractionRefused(error)) {
      Sentry.captureException(error, {
        tags: { 'error.subsystem': 'auth', 'error.operation': 'logout_activity_unregister' },
      });
    }
    return { ok: false, tokens: [] };
  }
}
