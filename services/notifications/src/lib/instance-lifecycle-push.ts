/**
 * Pure helpers for building and orchestrating instance lifecycle push
 * dispatches. Kept in a dedicated module so tests can import them without
 * pulling in the Hyperdrive/pg client chain.
 */

import {
  type InstanceLifecycleEvent,
  type PushData,
  type SendInstanceLifecycleNotificationParams,
  type SendInstanceLifecycleNotificationResult,
} from '@kilocode/notifications';

import type { ExpoPushMessage, SendResult, TicketTokenPair } from './expo-push';

export type {
  InstanceLifecycleEvent,
  SendInstanceLifecycleNotificationParams,
  SendInstanceLifecycleNotificationResult,
} from '@kilocode/notifications';

const BODY_MAX_LENGTH = 100;
const EMPTY_TICKET_ERRORS = { total: 0, retryable: 0, terminal: 0 } as const;

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

  return tokens.map(token => {
    const data = {
      type: 'instance-lifecycle',
      event: params.event,
      sandboxId: params.sandboxId,
    } satisfies PushData;

    return {
      to: token,
      title,
      body,
      data,
      sound: 'default',
      priority: 'high',
    } satisfies ExpoPushMessage;
  });
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
  const tokens = await deps.getTokens(params.userId);
  if (tokens.length === 0) {
    return {
      tokenCount: 0,
      sent: 0,
      staleTokens: 0,
      receiptCount: 0,
      ticketErrors: EMPTY_TICKET_ERRORS,
    } satisfies SendInstanceLifecycleNotificationResult;
  }

  const messages = buildInstanceLifecycleMessages(tokens, params);
  const { ticketTokenPairs, staleTokens, ticketErrors } = await deps.sendPush(messages);

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
    ticketErrors: {
      total: ticketErrors.length,
      retryable: ticketErrors.filter(ticketError => ticketError.retryable).length,
      terminal: ticketErrors.filter(ticketError => !ticketError.retryable).length,
    },
  } satisfies SendInstanceLifecycleNotificationResult;
}
