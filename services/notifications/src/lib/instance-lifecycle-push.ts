/**
 * Pure helpers for building and orchestrating instance lifecycle push
 * dispatches. Kept in a dedicated module so tests can import them without
 * pulling in the Hyperdrive/pg client chain.
 */

import {
  translatePush,
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

export type PushTokenWithLocale = { token: string; locale: string | null };

function truncate(text: string, max = BODY_MAX_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function buildTitle(
  locale: string | null,
  event: InstanceLifecycleEvent,
  instanceName: string | null
): string {
  // KiloClaw is a product name; it is never translated.
  const name = instanceName ?? 'KiloClaw';
  if (event === 'ready') {
    return translatePush(
      locale,
      'instanceLifecycle.ready.title',
      { instanceName: name },
      '{{instanceName}} is ready'
    );
  }
  return translatePush(
    locale,
    'instanceLifecycle.startFailed.title',
    { instanceName: name },
    '{{instanceName}} failed to start'
  );
}

function buildBody(
  locale: string | null,
  event: InstanceLifecycleEvent,
  errorMessage: string | undefined
): string {
  if (event === 'ready')
    return translatePush(
      locale,
      'instanceLifecycle.ready.body',
      undefined,
      'Tap to start chatting.'
    );
  const trimmed = errorMessage?.trim();
  if (trimmed && trimmed.length > 0) return truncate(trimmed);
  return translatePush(locale, 'instanceLifecycle.startFailed.body', undefined, 'Start failed.');
}

/**
 * Pure helper that builds the Expo push messages for a lifecycle event.
 * Each token is translated with its own locale.
 */
export function buildInstanceLifecycleMessages(
  tokens: readonly PushTokenWithLocale[],
  params: SendInstanceLifecycleNotificationParams
): ExpoPushMessage[] {
  return tokens.map(({ token, locale }) => {
    const data = {
      type: 'instance-lifecycle',
      event: params.event,
      sandboxId: params.sandboxId,
    } satisfies PushData;

    return {
      to: token,
      title: buildTitle(locale, params.event, params.instanceName),
      body: buildBody(locale, params.event, params.errorMessage),
      data,
      sound: 'default',
      priority: 'high',
    } satisfies ExpoPushMessage;
  });
}

export type LifecycleDispatchDeps = {
  /**
   * Read the user's `kiloclawActivityEnabled` preference for this category
   * (KiloClaw instance lifecycle events). A throw fails closed and the
   * caller returns `suppressedByPreference: true` without sending.
   * `null` = successful read that returned no row → default-on.
   */
  readPreference: (userId: string) => Promise<boolean | null>;
  getTokens: (userId: string) => Promise<PushTokenWithLocale[]>;
  deleteStaleTokens: (tokens: string[]) => Promise<void>;
  sendPush: (messages: ExpoPushMessage[]) => Promise<SendResult>;
  enqueueReceipts: (pairs: TicketTokenPair[]) => Promise<void>;
};

/** Zero-count result used when the user has opted out of KiloClaw activity. */
function suppressedLifecycleResult(): SendInstanceLifecycleNotificationResult {
  return {
    tokenCount: 0,
    sent: 0,
    staleTokens: 0,
    receiptCount: 0,
    suppressedByPreference: true,
    ticketErrors: EMPTY_TICKET_ERRORS,
  } satisfies SendInstanceLifecycleNotificationResult;
}

/**
 * Pure orchestrator for dispatching a lifecycle push notification. All IO is
 * injected via `deps` so tests can substitute in-memory fakes without mocking.
 */
export async function dispatchInstanceLifecyclePush(
  params: SendInstanceLifecycleNotificationParams,
  deps: LifecycleDispatchDeps
): Promise<SendInstanceLifecycleNotificationResult> {
  // Per-category preference gate (kiloclaw_activity_enabled). Fail-closed:
  // a read throw suppresses the push and returns the zero-count shape with
  // `suppressedByPreference: true` so callers (and receipts) can distinguish
  // a deliberate opt-out from "no tokens". A null row is default-on.
  let enabled: boolean;
  try {
    const row = await deps.readPreference(params.userId);
    enabled = row ?? true;
  } catch {
    return suppressedLifecycleResult();
  }
  if (!enabled) {
    return suppressedLifecycleResult();
  }

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
