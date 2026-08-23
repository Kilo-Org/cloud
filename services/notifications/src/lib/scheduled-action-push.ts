/**
 * Pure helpers for building and dispatching scheduled-action push
 * notifications. Mirrors `instance-lifecycle-push.ts` shape so the
 * notifications service entrypoint can wire the same {getTokens,
 * deleteStaleTokens, sendPush, enqueueReceipts} dependency object.
 */

import {
  sendScheduledActionNoticeInputSchema,
  translatePush,
  type PushData,
  type ScheduledActionEvent,
  type SendScheduledActionNoticeParams,
  type SendScheduledActionNoticeResult,
} from '@kilocode/notifications';

import type { ExpoPushMessage, SendResult, TicketTokenPair } from './expo-push';

export type {
  ScheduledActionEvent,
  SendScheduledActionNoticeParams,
  SendScheduledActionNoticeResult,
} from '@kilocode/notifications';

export const ParamsSchema = sendScheduledActionNoticeInputSchema;

const BODY_MAX_LENGTH = 100;

export type PushTokenWithLocale = { token: string; locale: string | null };

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

function buildTitle(
  locale: string | null,
  event: ScheduledActionEvent,
  instanceName: string | null
): string {
  // KiloClaw is a product name; it is never translated.
  const name = instanceName ?? 'KiloClaw';
  switch (event) {
    case 'scheduled_restart_notice':
      return translatePush(
        locale,
        'scheduledAction.restartNotice.title',
        { instanceName: name },
        '{{instanceName}} will restart soon'
      );
    case 'scheduled_restart_cancelled':
      return translatePush(
        locale,
        'scheduledAction.restartCancelled.title',
        { instanceName: name },
        '{{instanceName}} restart cancelled'
      );
    case 'scheduled_version_change_notice':
      return translatePush(
        locale,
        'scheduledAction.versionChangeNotice.title',
        { instanceName: name },
        '{{instanceName}} will upgrade soon'
      );
    case 'scheduled_version_change_cancelled':
      return translatePush(
        locale,
        'scheduledAction.versionChangeCancelled.title',
        { instanceName: name },
        '{{instanceName}} upgrade cancelled'
      );
  }
}

function buildBody(locale: string | null, params: SendScheduledActionNoticeParams): string {
  const when = formatScheduledAt(params.scheduledAt);
  switch (params.event) {
    case 'scheduled_restart_notice':
      return truncate(
        translatePush(
          locale,
          'scheduledAction.restartNotice.body',
          { when },
          'Scheduled to restart at {{when}}.'
        )
      );
    case 'scheduled_restart_cancelled':
      return truncate(
        translatePush(
          locale,
          'scheduledAction.restartCancelled.body',
          undefined,
          'The previously scheduled restart has been cancelled.'
        )
      );
    case 'scheduled_version_change_notice':
      return truncate(
        params.targetImageTag
          ? translatePush(
              locale,
              'scheduledAction.versionChangeNotice.bodyWithTag',
              { targetImageTag: params.targetImageTag, when },
              'Upgrade to {{targetImageTag}} at {{when}}.'
            )
          : translatePush(
              locale,
              'scheduledAction.versionChangeNotice.bodyWithoutTag',
              { when },
              'Scheduled upgrade at {{when}}.'
            )
      );
    case 'scheduled_version_change_cancelled':
      return truncate(
        translatePush(
          locale,
          'scheduledAction.versionChangeCancelled.body',
          undefined,
          'The previously scheduled upgrade has been cancelled.'
        )
      );
  }
}

/** Pure helper that builds the Expo push messages for a scheduled-action event. */
export function buildScheduledActionMessages(
  tokens: readonly PushTokenWithLocale[],
  params: SendScheduledActionNoticeParams
): ExpoPushMessage[] {
  return tokens.map(({ token, locale }) => {
    const data = {
      type: 'scheduled-action',
      event: params.event,
      sandboxId: params.sandboxId,
    } satisfies PushData;

    return {
      to: token,
      title: buildTitle(locale, params.event, params.instanceName),
      body: buildBody(locale, params),
      data,
      sound: 'default',
      priority: 'high',
    } satisfies ExpoPushMessage;
  });
}

export type ScheduledActionDispatchDeps = {
  /**
   * Read the user's `kiloclawActivityEnabled` preference for this category
   * (KiloClaw scheduled-action notices). A throw fails closed and the
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
function suppressedScheduledResult(): SendScheduledActionNoticeResult {
  return {
    tokenCount: 0,
    sent: 0,
    staleTokens: 0,
    receiptCount: 0,
    suppressedByPreference: true,
  } satisfies SendScheduledActionNoticeResult;
}

export async function dispatchScheduledActionPush(
  params: SendScheduledActionNoticeParams,
  deps: ScheduledActionDispatchDeps
): Promise<SendScheduledActionNoticeResult> {
  const parsed = ParamsSchema.parse(params);

  // Per-category preference gate (kiloclaw_activity_enabled). Fail-closed:
  // a read throw suppresses the push and returns the zero-count shape with
  // `suppressedByPreference: true` so callers can distinguish a deliberate
  // opt-out from "no tokens". A null row is default-on.
  let enabled: boolean;
  try {
    const row = await deps.readPreference(parsed.userId);
    enabled = row ?? true;
  } catch {
    return suppressedScheduledResult();
  }
  if (!enabled) {
    return suppressedScheduledResult();
  }

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
