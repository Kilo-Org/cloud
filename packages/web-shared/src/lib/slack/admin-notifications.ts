import 'server-only';

import { SLACK_ADMIN_NOTIFICATIONS_WEBHOOK_URL } from '@kilocode/web-shared/lib/config.server';
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

class AdminSlackNotificationErrorImpl extends Error {
  readonly kind: 'configuration' | 'network' | 'upstream';
  readonly status?: number;

  constructor(kind: 'configuration' | 'network' | 'upstream', status?: number) {
    super('Admin Slack notification request failed');
    this.name = 'AdminSlackNotificationError';
    this.kind = kind;
    this.status = status;
  }
}

/** Only the `upstream` variant carries the HTTP status its request returned. */
export type AdminSlackNotificationError =
  | (Error & { readonly kind: 'configuration' | 'network'; readonly status?: undefined })
  | (Error & { readonly kind: 'upstream'; readonly status: number });

interface AdminSlackNotificationErrorConstructor {
  new (kind: 'configuration' | 'network'): AdminSlackNotificationError;
  new (kind: 'upstream', status: number): AdminSlackNotificationError;
}

// A class cannot declare overloaded constructors that return a union instance
// type, so the runtime class is exported through a constructor interface and
// the instance type is that union.
export const AdminSlackNotificationError =
  AdminSlackNotificationErrorImpl as unknown as AdminSlackNotificationErrorConstructor;

/**
 * Sends a notification to the Slack channel configured by
 * `SLACK_ADMIN_NOTIFICATIONS_WEBHOOK_URL`.
 *
 * This function is server-only. Call it from an admin tRPC procedure, route
 * handler, or server action; never send the webhook URL to a browser.
 *
 * `options.requireConfigured` defaults to `false` (`{}`), so an unset webhook
 * URL only logs a warning and sends nothing. Pass `{ requireConfigured: true }`
 * when a dropped Admin notification must fail loudly: the function then throws
 * an `AdminSlackNotificationError` with kind `'configuration'`. Failures are
 * `'configuration'` (unset URL, only with `requireConfigured`), `'network'`
 * (the fetch failed), and `'upstream'` (Slack answered non-ok; carries the
 * response `status`).
 */
export async function sendAdminSlackNotification(
  notification: AdminSlackNotification,
  options: { requireConfigured?: boolean } = {}
): Promise<void> {
  if (!SLACK_ADMIN_NOTIFICATIONS_WEBHOOK_URL) {
    if (options.requireConfigured) {
      throw new AdminSlackNotificationError('configuration');
    }
    console.warn(
      '[AdminSlackNotifications] SLACK_ADMIN_NOTIFICATIONS_WEBHOOK_URL is not configured; notification skipped'
    );
    return;
  }

  let response: Response;

  try {
    response = await fetch(SLACK_ADMIN_NOTIFICATIONS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(SLACK_WEBHOOK_TIMEOUT_MS),
    });
    // Slack normally responds with a short plain-text "ok" body. Consuming it
    // allows the underlying connection to be reused.
    await response.text();
  } catch {
    // Do not retain the original error: fetch errors can contain the secret URL.
    throw new AdminSlackNotificationError('network');
  }

  if (!response.ok) {
    throw new AdminSlackNotificationError('upstream', response.status);
  }
}
