/**
 * RPC method types for the NOTIFICATIONS service binding.
 *
 * `wrangler types` only sees `Fetcher` for service bindings; the actual RPC
 * shape comes from the notifications worker's WorkerEntrypoint and is declared
 * here from shared package types so the generated file can be freely regenerated.
 */

import type {
  SendScheduledActionNoticeParams,
  SendScheduledActionNoticeResult,
  SendInstanceLifecycleNotificationParams,
  SendInstanceLifecycleNotificationResult,
} from '@kilocode/notifications';

export type {
  InstanceLifecycleEvent,
  ScheduledActionEvent,
  SendScheduledActionNoticeParams,
  SendScheduledActionNoticeResult,
  SendInstanceLifecycleNotificationParams,
  SendInstanceLifecycleNotificationResult,
} from '@kilocode/notifications';

export type NotificationsBinding = Fetcher & {
  sendInstanceLifecycleNotification(
    params: SendInstanceLifecycleNotificationParams
  ): Promise<SendInstanceLifecycleNotificationResult>;
  sendScheduledActionNotice(
    params: SendScheduledActionNoticeParams
  ): Promise<SendScheduledActionNoticeResult>;
};
