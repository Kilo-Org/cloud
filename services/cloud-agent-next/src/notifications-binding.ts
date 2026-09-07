/**
 * RPC method types for the NOTIFICATIONS service binding.
 *
 * `wrangler types` only sees `Fetcher` for service bindings; the actual RPC
 * shape comes from the notifications worker's WorkerEntrypoint and is declared
 * here from shared package types so the generated file can be freely regenerated.
 */

import type {
  RefreshGlanceableSessionsParams,
  SendCloudAgentSessionNotificationParams,
  SendCloudAgentSessionNotificationResult,
} from '@kilocode/notifications';

export type {
  CloudAgentSessionPushStatus,
  SendCloudAgentSessionNotificationParams,
  SendCloudAgentSessionNotificationResult,
} from '@kilocode/notifications';

export type NotificationsBinding = Fetcher & {
  refreshGlanceableSessions(params: RefreshGlanceableSessionsParams): Promise<void>;
  sendCloudAgentSessionNotification(
    params: SendCloudAgentSessionNotificationParams
  ): Promise<SendCloudAgentSessionNotificationResult>;
};
