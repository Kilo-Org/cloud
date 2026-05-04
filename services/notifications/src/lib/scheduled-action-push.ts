/**
 * Pure helpers for building and dispatching scheduled-action push
 * notifications. Mirrors `instance-lifecycle-push.ts` shape so the
 * notifications service entrypoint can wire the same {getTokens,
 * deleteStaleTokens, sendPush, enqueueReceipts} dependency object.
 */

import { z } from 'zod';

import type { ExpoPushMessage, SendResult, TicketTokenPair } from './expo-push';

export type ScheduledActionEvent =
  | 'scheduled_restart_notice'
  | 'scheduled_restart_cancelled'
  | 'scheduled_version_change_notice'
  | 'scheduled_version_change_cancelled';

export type SendScheduledActionNoticeParams = {
  userId: string;
  /** Chat route id surfaced on the device. Currently this is the instance sandboxId. */
  instanceId: string;
  /** Included for worker-side logs only. */
  sandboxId: string;
  event: ScheduledActionEvent;
  instanceName: string | null;
  /** When the action is scheduled to run. ISO 8601. */
  scheduledAt: string;
  /** Target image_tag for version_change events; null for restart events. */
  targetImageTag?: string | null;
};

export type SendScheduledActionNoticeResult = {
  tokenCount: number;
  sent: number;
  staleTokens: number;
  receiptCount: number;
};

export const ParamsSchema = z.object({
  userId: z.string().min(1),
  instanceId: z.string().min(1),
  sandboxId: z.string(),
  event: z.enum([
    'scheduled_restart_notice',
    'scheduled_restart_cancelled',
    'scheduled_version_change_notice',
    'scheduled_version_change_cancelled',
  ]),
  instanceName: z.string().nullable(),
  scheduledAt: z.string(),
  targetImageTag: z.string().nullable().optional(),
});

const BODY_MAX_LENGTH = 100;

function truncate(text: string, max = BODY_MAX_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function formatScheduledAt(iso: string): string {
  // Expo push body is small; pick a compact server-rendered string.
  // Pin to UTC so the output is deterministic across runtimes (CF
  // Workers happen to be UTC, but Vitest/Jest runners on dev laptops
  // are not — without this, body assertions in unit tests would be
  // flaky depending on the host timezone, and the email and push
  // bodies would disagree about the rendered time).
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return (
      d.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }) + ' UTC'
    );
  } catch {
    return iso;
  }
}

function buildTitle(event: ScheduledActionEvent, instanceName: string | null): string {
  const name = instanceName ?? 'KiloClaw';
  switch (event) {
    case 'scheduled_restart_notice':
      return `${name} will restart soon`;
    case 'scheduled_restart_cancelled':
      return `${name} restart cancelled`;
    case 'scheduled_version_change_notice':
      return `${name} will upgrade soon`;
    case 'scheduled_version_change_cancelled':
      return `${name} upgrade cancelled`;
  }
}

function buildBody(params: SendScheduledActionNoticeParams): string {
  const when = formatScheduledAt(params.scheduledAt);
  switch (params.event) {
    case 'scheduled_restart_notice':
      return truncate(`Scheduled to restart at ${when}.`);
    case 'scheduled_restart_cancelled':
      return truncate(`The previously scheduled restart has been cancelled.`);
    case 'scheduled_version_change_notice':
      return truncate(
        params.targetImageTag
          ? `Upgrade to ${params.targetImageTag} at ${when}.`
          : `Scheduled upgrade at ${when}.`
      );
    case 'scheduled_version_change_cancelled':
      return truncate(`The previously scheduled upgrade has been cancelled.`);
  }
}

/** Pure helper that builds the Expo push messages for a scheduled-action event. */
export function buildScheduledActionMessages(
  tokens: readonly string[],
  params: SendScheduledActionNoticeParams
): ExpoPushMessage[] {
  const title = buildTitle(params.event, params.instanceName);
  const body = buildBody(params);

  return tokens.map(token => ({
    to: token,
    title,
    body,
    // Keep in sync with NotificationData in apps/mobile/src/lib/notifications.ts
    data: {
      type: 'scheduled-action',
      event: params.event,
      instanceId: params.instanceId,
    },
    sound: 'default' as const,
    priority: 'high' as const,
  }));
}

export type ScheduledActionDispatchDeps = {
  getTokens: (userId: string) => Promise<string[]>;
  deleteStaleTokens: (tokens: string[]) => Promise<void>;
  sendPush: (messages: ExpoPushMessage[]) => Promise<SendResult>;
  enqueueReceipts: (pairs: TicketTokenPair[]) => Promise<void>;
};

export async function dispatchScheduledActionPush(
  params: SendScheduledActionNoticeParams,
  deps: ScheduledActionDispatchDeps
): Promise<SendScheduledActionNoticeResult> {
  const parsed = ParamsSchema.parse(params);

  const tokens = await deps.getTokens(parsed.userId);
  if (tokens.length === 0) {
    return { tokenCount: 0, sent: 0, staleTokens: 0, receiptCount: 0 };
  }

  const messages = buildScheduledActionMessages(tokens, parsed);
  const { ticketTokenPairs, staleTokens } = await deps.sendPush(messages);

  if (staleTokens.length > 0) {
    await deps.deleteStaleTokens(staleTokens);
  }

  if (ticketTokenPairs.length > 0) {
    await deps.enqueueReceipts(ticketTokenPairs);
  }

  return {
    tokenCount: tokens.length,
    sent: ticketTokenPairs.length,
    staleTokens: staleTokens.length,
    receiptCount: ticketTokenPairs.length,
  };
}
