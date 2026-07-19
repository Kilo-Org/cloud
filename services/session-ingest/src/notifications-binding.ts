/**
 * RPC method types for the NOTIFICATIONS service binding.
 *
 * `wrangler types` only sees `Fetcher` for service bindings; the actual RPC
 * shape comes from the notifications worker's WorkerEntrypoint and is declared
 * here from shared package types so the generated file can be freely regenerated.
 */

import type {
  SendAgentSessionNotificationParams,
  SendAgentSessionNotificationResult,
  SendCloudAgentSessionNotificationParams,
  SendCloudAgentSessionNotificationResult,
  SendSessionReadyNotificationParams,
  SendSessionReadyNotificationResult,
} from '@kilocode/notifications';

export type NotificationsBinding = Fetcher & {
  sendCloudAgentSessionNotification(
    params: SendCloudAgentSessionNotificationParams
  ): Promise<SendCloudAgentSessionNotificationResult>;
  sendAgentSessionNotification(
    params: SendAgentSessionNotificationParams
  ): Promise<SendAgentSessionNotificationResult>;
  sendSessionReadyNotification(
    params: SendSessionReadyNotificationParams
  ): Promise<SendSessionReadyNotificationResult>;
};
