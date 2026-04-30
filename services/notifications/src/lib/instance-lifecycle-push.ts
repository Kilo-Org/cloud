/**
 * Pure helpers for building and orchestrating instance lifecycle push
 * dispatches. Kept in a dedicated module so tests can import them without
 * pulling in the Hyperdrive/pg client chain.
 */

import { z } from 'zod';

import type { ExpoPushMessage, SendResult, TicketTokenPair } from './expo-push';

export type InstanceLifecycleEvent = 'ready' | 'start_failed';

export type SendInstanceLifecycleNotificationParams = {
  userId: string;
  /** Chat route id surfaced on the device. Currently this is the instance sandboxId. */
  instanceId: string;
  /** Included for worker-side logs only. */
  sandboxId: string;
  event: InstanceLifecycleEvent;
  instanceName: string | null;
  /** Failure body only. Caller is expected to keep this short (~100 chars). */
  errorMessage?: string;
};

export type SendInstanceLifecycleNotificationResult = {
  tokenCount: number;
  sent: number;
  staleTokens: number;
  receiptCount: number;
};

export const ParamsSchema = z.object({
  userId: z.string().min(1),
  instanceId: z.string().min(1),
  sandboxId: z.string(),
  event: z.enum(['ready', 'start_failed']),
  instanceName: z.string().nullable(),
  errorMessage: z.string().optional(),
});

const BODY_MAX_LENGTH = 100;

function truncate(text: string, max = BODY_MAX_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function buildTitle(event: InstanceLifecycleEvent, instanceName: string | null): string {
  const name = instanceName ?? 'KiloClaw';
  if (event === 'ready') return `${name} is ready`;
  return `${name} failed to start`;
}

function buildBody(event: InstanceLifecycleEvent, errorMessage: string | undefined): string {
  if (event === 'ready') return 'Tap to start chatting.';
  const fallback = 'Start failed.';
  return truncate(errorMessage && errorMessage.trim().length > 0 ? errorMessage : fallback);
}

/**
 * Pure helper that builds the Expo push messages for a lifecycle event.
 */
export function buildInstanceLifecycleMessages(
  tokens: readonly string[],
  params: SendInstanceLifecycleNotificationParams
): ExpoPushMessage[] {
  const title = buildTitle(params.event, params.instanceName);
  const body = buildBody(params.event, params.errorMessage);

  return tokens.map(token => ({
    to: token,
    title,
    body,
    // Keep in sync with NotificationData in apps/mobile/src/lib/notifications.ts
    data: {
      type: 'instance-lifecycle',
      event: params.event,
      instanceId: params.instanceId,
    },
    sound: 'default' as const,
    priority: 'high' as const,
  }));
}

export type LifecycleDispatchDeps = {
  getTokens: (userId: string) => Promise<string[]>;
  deleteStaleTokens: (tokens: string[]) => Promise<void>;
  sendPush: (messages: ExpoPushMessage[]) => Promise<SendResult>;
  enqueueReceipts: (pairs: TicketTokenPair[]) => Promise<void>;
};

/**
 * Pure orchestrator for dispatching a lifecycle push notification. All IO is
 * injected via `deps` so tests can substitute in-memory fakes without mocking.
 */
export async function dispatchInstanceLifecyclePush(
  params: SendInstanceLifecycleNotificationParams,
  deps: LifecycleDispatchDeps
): Promise<SendInstanceLifecycleNotificationResult> {
  const parsed = ParamsSchema.parse(params);

  const tokens = await deps.getTokens(parsed.userId);
  if (tokens.length === 0) {
    return { tokenCount: 0, sent: 0, staleTokens: 0, receiptCount: 0 };
  }

  const messages = buildInstanceLifecycleMessages(tokens, parsed);
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
