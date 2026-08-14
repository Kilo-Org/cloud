import 'server-only';

import { SLACK_ON_CALL_WEBHOOK_URL } from '@/lib/config.server';
import type { AdminSlackNotification } from '@/lib/slack/admin-notifications';

const SLACK_WEBHOOK_TIMEOUT_MS = 10_000;

export class OnCallSlackNotificationError extends Error {
  constructor(
    readonly kind: 'network' | 'upstream',
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
): Promise<void> {
  if (!SLACK_ON_CALL_WEBHOOK_URL) {
    console.warn(
      '[OnCallSlackNotifications] SLACK_ON_CALL_WEBHOOK_URL is not configured; notification skipped'
    );
    return;
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
}
