import 'server-only';

import { SLACK_ON_CALL_WEBHOOK_URL } from '@/lib/config.server';
import type { AdminSlackNotification } from '@/lib/slack/admin-notifications';

const SLACK_WEBHOOK_TIMEOUT_MS = 10_000;

export class OnCallSlackNotificationError extends Error {
  constructor(
    readonly kind: 'configuration' | 'network' | 'upstream',
    readonly status?: number
  ) {
    super('On-call Slack notification request failed');
    this.name = 'OnCallSlackNotificationError';
  }
}

/**
 * Sends a notification to the Slack incoming webhook bound to #kilo-on-call.
 *
 * This function is server-only. Never send the webhook URL to a browser.
 */
export async function sendOnCallSlackNotification(
  notification: AdminSlackNotification
): Promise<'posted' | 'simulated'> {
  if (process.env.VERCEL_ENV !== 'production') {
    console.info(
      '[OnCallSlackNotifications] Simulated notification; Slack delivery is enabled only on production Vercel',
      notification
    );
    return 'simulated';
  }

  if (!SLACK_ON_CALL_WEBHOOK_URL) {
    throw new OnCallSlackNotificationError('configuration');
  }

  let response: Response;

  try {
    response = await fetch(SLACK_ON_CALL_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(SLACK_WEBHOOK_TIMEOUT_MS),
    });
  } catch {
    throw new OnCallSlackNotificationError('network');
  }

  try {
    await response.text();
  } catch {
    throw new OnCallSlackNotificationError('network');
  }

  if (!response.ok) {
    throw new OnCallSlackNotificationError('upstream', response.status);
  }

  return 'posted';
}
