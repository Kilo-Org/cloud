import 'server-only';

import {
  SLACK_ADMIN_NOTIFICATIONS_WEBHOOK_URL,
  SLACK_GATEWAY_NOTIFICATIONS_WEBHOOK_URL,
} from '@kilocode/web-shared/lib/config.server';
import type { AnyBlock, MessageAttachment } from '@slack/types';

const SLACK_WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Payload accepted by the Admin Slack incoming webhook. `text` is required as
 * the notification fallback for clients and assistive technology that do not
 * render Block Kit content.
 */
export type AdminSlackNotification = {
  text: string;
  blocks?: AnyBlock[];
  attachments?: MessageAttachment[];
  unfurl_links?: boolean;
  unfurl_media?: boolean;
};

export class AdminSlackNotificationError extends Error {
  constructor(
    readonly kind: 'configuration' | 'network' | 'upstream',
    readonly status?: number
  ) {
    super('Admin Slack notification request failed');
    this.name = 'AdminSlackNotificationError';
  }
}

/**
 * Sends a notification to the configured admin or gateway Slack channel.
 *
 * This function is server-only. Call it from an admin tRPC procedure, route
 * handler, or server action; never send the webhook URL to a browser.
 */
export async function sendAdminSlackNotification(
  notification: AdminSlackNotification,
  options: { requireConfigured?: boolean; destination?: 'admin' | 'gateway' } = {}
): Promise<void> {
  const webhooks = {
    admin: {
      variable: 'SLACK_ADMIN_NOTIFICATIONS_WEBHOOK_URL',
      url: SLACK_ADMIN_NOTIFICATIONS_WEBHOOK_URL,
    },
    gateway: {
      variable: 'SLACK_GATEWAY_NOTIFICATIONS_WEBHOOK_URL',
      url: SLACK_GATEWAY_NOTIFICATIONS_WEBHOOK_URL,
    },
  };
  const { variable: webhookVariable, url: webhookUrl } = webhooks[options.destination ?? 'admin'];
  if (!webhookUrl) {
    if (options.requireConfigured) {
      throw new AdminSlackNotificationError('configuration');
    }
    console.warn(
      `[AdminSlackNotifications] ${webhookVariable} is not configured; notification skipped`
    );
    return;
  }

  let response: Response;

  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(SLACK_WEBHOOK_TIMEOUT_MS),
    });
  } catch {
    // Do not retain the original error: fetch errors can contain the secret URL.
    throw new AdminSlackNotificationError('network');
  }

  try {
    // Slack normally responds with a short plain-text "ok" body. Consuming it
    // allows the underlying connection to be reused.
    await response.text();
  } catch {
    throw new AdminSlackNotificationError('network');
  }

  if (!response.ok) {
    throw new AdminSlackNotificationError('upstream', response.status);
  }
}
