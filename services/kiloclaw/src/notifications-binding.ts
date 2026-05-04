/**
 * RPC method types for the NOTIFICATIONS service binding.
 *
 * `wrangler types` only sees `Fetcher` for service bindings; the actual RPC
 * shape comes from the notifications worker's WorkerEntrypoint and is declared
 * here so the generated file can be freely regenerated.
 *
 * Keep in sync with: services/notifications/src/lib/notifications-service.ts (NotificationsService).
 */

export type InstanceLifecycleEvent = 'ready' | 'start_failed';

export type SendInstanceLifecycleNotificationParams = {
  userId: string;
  instanceId: string;
  sandboxId: string;
  event: InstanceLifecycleEvent;
  instanceName: string | null;
  errorMessage?: string;
};

export type SendInstanceLifecycleNotificationResult = {
  tokenCount: number;
  sent: number;
  staleTokens: number;
  receiptCount: number;
};

export type ScheduledActionEvent =
  | 'scheduled_restart_notice'
  | 'scheduled_restart_cancelled'
  | 'scheduled_version_change_notice'
  | 'scheduled_version_change_cancelled';

export type SendScheduledActionNoticeParams = {
  userId: string;
  instanceId: string;
  sandboxId: string;
  event: ScheduledActionEvent;
  instanceName: string | null;
  scheduledAt: string;
  targetImageTag?: string | null;
};

export type SendScheduledActionNoticeResult = {
  tokenCount: number;
  sent: number;
  staleTokens: number;
  receiptCount: number;
};

export type NotificationsBinding = Fetcher & {
  sendInstanceLifecycleNotification(
    params: SendInstanceLifecycleNotificationParams
  ): Promise<SendInstanceLifecycleNotificationResult>;
  sendScheduledActionNotice(
    params: SendScheduledActionNoticeParams
  ): Promise<SendScheduledActionNoticeResult>;
};
