/**
 * Remote updates and ends for the per-session Live Activity and the Android
 * session notification (`.specs/mobile-session-live-activity.md`). The
 * aggregate refresh reads the facts of each followed session in the same
 * build, and this module turns them into one APNs push per iOS session card
 * token and one Expo data message per Android followed session. Both platforms
 * share one plan: the same content, the same unchanged-content skip, and the
 * same ends. Pure: all IO is injected.
 */

import { glanceableStatusKind } from '@kilocode/app-shared/glanceable-agents-snapshot';
import {
  buildSessionLiveActivityContentState,
  type PushData,
  SESSION_LIVE_COMMAND_LIMIT,
  sessionCardStaleAtSeconds,
  sessionLiveActivityRelevance,
  type SessionLiveActivityContentState,
  type SessionCardStatusKind,
} from '@kilocode/notifications';
import { sessionLiveSummarySchema } from '@kilocode/session-ingest-contracts';
import { z } from 'zod';

import type { LiveActivityPriority } from './apns-live-activity';
import type { ExpoPushMessage } from './expo-push';
import type { GlanceableApnsContentState } from './glanceable-delivery';

/** Matches the session card factory name in the widget extension. */
export const SESSION_LIVE_ACTIVITY_NAME = 'SessionLiveActivity';

/** A finished session card stays on the Lock Screen this long (spec "Ending" rule 1). */
export const SESSION_CARD_FINISHED_DISMISS_MS = 15 * 60_000;

/**
 * The stale window of a card that is not waiting on activity: the same window
 * the aggregate card uses, so an update iOS never confirms reads as last-known
 * after half an hour instead of staying current forever.
 */
export const SESSION_CARD_AGGREGATE_STALE_MS = 30 * 60_000;

/**
 * The facts the web snapshot route reads for one followed session. `row` is
 * null when the session is gone or no longer in the scope.
 */
export const sessionCardSourceSchema = z.object({
  sessionId: z.string().min(1),
  row: z
    .object({
      title: z.string().nullable(),
      status: z.string(),
      statusUpdatedAt: z.string().nullable(),
      scheduledAt: z.string().nullable(),
      approvalKey: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      /** The small derived summary the ingest service stored, or null. */
      summary: sessionLiveSummarySchema.nullable().optional(),
      /** The command of the request Approve answers, trimmed; null without one. */
      permissionCommand: z.string().max(SESSION_LIVE_COMMAND_LIMIT).nullable().optional(),
      /** ISO 8601; the last activity the server saw. */
      lastActivityAt: z.string().nullable().optional(),
      /** The cost so far, in microdollars. */
      costMicrodollars: z.number().int().nonnegative().nullable().optional(),
      /** ISO 8601; when the session started. */
      startedAt: z.string().nullable().optional(),
      /** True when the session has an open pull request. */
      prOpened: z.boolean().optional(),
    })
    .nullable(),
});
export type SessionCardSource = z.infer<typeof sessionCardSourceSchema>;

export type IosSessionActivityToken = { token: string; sessionId: string };

/** One followed session on one Android device: the device's Expo push token and the session. */
export type AndroidSessionOngoingToken = { token: string; sessionId: string };

/**
 * One data message to an Android session notification. The device renders it
 * from `content`; an end with `dismissAfterMs` 0 removes it at once.
 */
export type AndroidSessionSend = {
  token: string;
  sessionId: string;
  event: 'update' | 'end';
  content: SessionLiveActivityContentState;
  dismissAfterMs?: number;
};

export type SessionCardSend = {
  token: string;
  event: 'update' | 'end';
  content: GlanceableApnsContentState;
  priority: LiveActivityPriority;
  relevanceScore: number;
  /** Unix seconds; set on every end. */
  dismissalDateSeconds?: number;
  /** Unix seconds after which iOS dims the update as out of date. */
  staleAtSeconds?: number;
};

/**
 * The content a card last accepted, so an unchanged card is not pushed again.
 * An iOS card is keyed by its token. An Android device uses one token for
 * every session it follows, so its key also names the session
 * (`androidSessionMemoryKey`).
 */
export type SessionCardMemory = {
  list: () => Promise<Map<string, SessionLiveActivityContentState>>;
  put: (key: string, content: SessionLiveActivityContentState) => Promise<void>;
  delete: (keys: string[]) => Promise<void>;
};

export function androidSessionMemoryKey(token: string, sessionId: string): string {
  return `android:${sessionId}:${token}`;
}

/** Each platform's IO is optional: a caller without it delivers the other platform only. */
export type SessionCardDeliveryDeps = {
  listIosSessionActivityTokens?: (
    userId: string,
    organizationId: string | null
  ) => Promise<IosSessionActivityToken[]>;
  /** Resolves true when APNs accepted the push. */
  sendIosSessionLiveActivity?: (
    send: SessionCardSend,
    timestampSeconds: number,
    isCurrent?: () => Promise<boolean>
  ) => Promise<boolean>;
  listAndroidSessionTokens?: (
    userId: string,
    organizationId: string | null
  ) => Promise<AndroidSessionOngoingToken[]>;
  /** Resolves true when Expo accepted the data message. */
  sendAndroidSessionLiveUpdate?: (
    send: AndroidSessionSend,
    isCurrent?: () => Promise<boolean>
  ) => Promise<boolean>;
  sessionCardMemory?: SessionCardMemory;
  isCurrent?: () => Promise<boolean>;
};

/**
 * The Expo message for one Android session notification: a high-priority
 * data-only wake, like the aggregate wake, so FCM delivers it in Doze and no
 * system notification is drawn from it. The app draws the notification.
 */
export function sessionLiveUpdateExpoMessage(send: AndroidSessionSend): ExpoPushMessage {
  return {
    to: send.token,
    data: {
      type: 'session_live_update',
      schemaVersion: 1,
      event: send.event,
      content: send.content,
      ...(send.dismissAfterMs === undefined ? {} : { dismissAfterMs: send.dismissAfterMs }),
    } satisfies PushData,
    _contentAvailable: true,
    sound: null,
    priority: 'high',
  };
}

function sameContent(
  left: SessionLiveActivityContentState,
  right: SessionLiveActivityContentState
): boolean {
  // `updatedAt` changes on every build; only what the card shows counts.
  return (
    JSON.stringify({ ...left, updatedAt: null }) === JSON.stringify({ ...right, updatedAt: null })
  );
}

/** The content facts of one source row, for the shared builder. */
function rowFacts(sessionId: string, row: NonNullable<SessionCardSource['row']>) {
  return {
    id: sessionId,
    title: row.title,
    status: row.status,
    statusUpdatedAt: row.statusUpdatedAt,
    scheduledAt: row.scheduledAt,
    currentStep: row.summary?.step ?? null,
    plan: row.summary?.plan ?? null,
    changes: row.summary?.changes ?? null,
    permissionCommand: row.permissionCommand ?? null,
    lastActivityAt: row.lastActivityAt ?? null,
    costMicrodollars: row.costMicrodollars ?? null,
    failure: row.summary?.failure?.kind ?? null,
    startedAt: row.startedAt ?? null,
    prOpened: row.prOpened ?? false,
  };
}

/**
 * Plan the push for one session card token, or null when the card already
 * shows this content.
 *
 * - A session that is gone or out of scope ends at once.
 * - A finished session (`idle` or `failed`) ends with its finished content and
 *   stays on the Lock Screen for `SESSION_CARD_FINISHED_DISMISS_MS`.
 * - Every other change is an update. Entering needs input or a failed turn
 *   uses priority 10; a step-only change and every other update use 5, which
 *   does not count toward the iOS update budget. The refresh window coalesces
 *   the frequent step changes.
 */
export function planSessionCardSend(params: {
  token: string;
  sessionId: string;
  source: SessionCardSource;
  previous: SessionLiveActivityContentState | undefined;
  updatedAt: string;
  nowSeconds: number;
}): { send: SessionCardSend; content: SessionLiveActivityContentState } | null {
  const { token, sessionId, source, previous, updatedAt, nowSeconds } = params;
  const envelope = (content: SessionLiveActivityContentState): GlanceableApnsContentState => ({
    name: SESSION_LIVE_ACTIVITY_NAME,
    props: JSON.stringify(content),
  });

  if (source.row === null) {
    // The session is gone or the user lost access: end with no content (spec
    // "Ending" rule 2), never with the title the card showed before.
    const content: SessionLiveActivityContentState = {
      sessionId,
      title: null,
      statusKind: 'idle',
      statusSince: updatedAt,
      scheduledAt: null,
      awaitingPermission: false,
      approvalKey: null,
      updatedAt,
    };
    return {
      content,
      send: {
        token,
        event: 'end',
        content: envelope(content),
        priority: 10,
        relevanceScore: sessionLiveActivityRelevance('idle', content.statusSince),
        dismissalDateSeconds: nowSeconds,
      },
    };
  }

  const statusKind = glanceableStatusKind(source.row.status);
  const content = buildSessionLiveActivityContentState(rowFacts(sessionId, source.row), {
    approvalKey: source.row.approvalKey,
    updatedAt,
    // Keep the shown timer when the row carries no status time and the kind
    // did not change; a fresh time on every build would restart it.
    statusSinceFallback: previous?.statusKind === statusKind ? previous.statusSince : updatedAt,
    previous,
  });
  if (content.statusKind === 'idle' || content.statusKind === 'failed') {
    return {
      content,
      send: {
        token,
        event: 'end',
        content: envelope(content),
        priority: 10,
        relevanceScore: sessionLiveActivityRelevance(content.statusKind, content.statusSince),
        dismissalDateSeconds: nowSeconds + SESSION_CARD_FINISHED_DISMISS_MS / 1000,
      },
    };
  }
  if (previous !== undefined && sameContent(previous, content)) return null;
  return {
    content,
    send: {
      token,
      event: 'update',
      content: envelope(content),
      priority: urgentKind(content.statusKind, previous) ? 10 : 5,
      relevanceScore: sessionLiveActivityRelevance(content.statusKind, content.statusSince),
      // The quiet window for a working card, the aggregate window otherwise.
      staleAtSeconds: sessionCardStaleAtSeconds(
        content,
        nowSeconds,
        nowSeconds + SESSION_CARD_AGGREGATE_STALE_MS / 1000
      ),
    },
  };
}

/** True when an update moves the card into a state that wakes the user. */
function urgentKind(
  kind: SessionCardStatusKind,
  previous: SessionLiveActivityContentState | undefined
): boolean {
  if (kind === previous?.statusKind) return false;
  return kind === 'needsInput' || kind === 'failed';
}

type SessionCardTarget = {
  platform: 'ios' | 'android';
  token: string;
  sessionId: string;
  /** The memory key: the token on iOS, the token and session on Android. */
  key: string;
};

async function listTargets(
  params: { userId: string; organizationId: string | null },
  deps: SessionCardDeliveryDeps
): Promise<SessionCardTarget[]> {
  const [ios, android] = await Promise.all([
    deps.sendIosSessionLiveActivity
      ? (deps.listIosSessionActivityTokens?.(params.userId, params.organizationId) ?? [])
      : [],
    deps.sendAndroidSessionLiveUpdate
      ? (deps.listAndroidSessionTokens?.(params.userId, params.organizationId) ?? [])
      : [],
  ]);
  return [
    ...ios.map(({ token, sessionId }) => ({
      platform: 'ios' as const,
      token,
      sessionId,
      key: token,
    })),
    ...android.map(({ token, sessionId }) => ({
      platform: 'android' as const,
      token,
      sessionId,
      key: androidSessionMemoryKey(token, sessionId),
    })),
  ];
}

/** Send one planned card; resolves true when the transport accepted it. */
async function sendPlanned(
  target: SessionCardTarget,
  plan: { send: SessionCardSend; content: SessionLiveActivityContentState },
  params: { timestampSeconds: number; nowSeconds: number },
  deps: SessionCardDeliveryDeps
): Promise<boolean> {
  const { send, content } = plan;
  if (target.platform === 'ios') {
    return (
      (await deps.sendIosSessionLiveActivity?.(send, params.timestampSeconds, deps.isCurrent)) ??
      false
    );
  }
  const dismissAfterMs =
    send.event === 'end'
      ? Math.max(0, ((send.dismissalDateSeconds ?? params.nowSeconds) - params.nowSeconds) * 1000)
      : undefined;
  return (
    (await deps.sendAndroidSessionLiveUpdate?.(
      {
        token: target.token,
        sessionId: target.sessionId,
        event: send.event,
        content,
        ...(dismissAfterMs === undefined ? {} : { dismissAfterMs }),
      },
      deps.isCurrent
    )) ?? false
  );
}

/**
 * Push every followed session card in one scope, on both platforms. A card
 * whose session the build did not read (a card followed while the build ran)
 * waits for the refresh its registration requested. `'end_all'` ends every
 * card in the scope at once: the user lost access to it.
 */
export async function deliverSessionCards(
  params: {
    userId: string;
    organizationId: string | null;
    sources: readonly SessionCardSource[] | 'end_all';
    updatedAt: string;
    timestampSeconds: number;
    nowSeconds: number;
  },
  deps: SessionCardDeliveryDeps
): Promise<void> {
  const targets = await listTargets(params, deps);
  const memory =
    (await deps.sessionCardMemory?.list()) ?? new Map<string, SessionLiveActivityContentState>();
  const live = new Set(targets.map(({ key }) => key));
  const forgotten = [...memory.keys()].filter(key => !live.has(key));
  if (forgotten.length > 0) await deps.sessionCardMemory?.delete(forgotten);

  const sources =
    params.sources === 'end_all'
      ? null
      : new Map(params.sources.map(source => [source.sessionId, source]));
  const sends = targets.flatMap(target => {
    const { token, sessionId, key } = target;
    const source = sources === null ? { sessionId, row: null } : sources.get(sessionId);
    if (source === undefined) return [];
    const plan = planSessionCardSend({
      token,
      sessionId,
      source,
      previous: memory.get(key),
      updatedAt: params.updatedAt,
      nowSeconds: params.nowSeconds,
    });
    return plan === null ? [] : [{ target, plan }];
  });
  if (sends.length === 0) return;
  if (deps.isCurrent && !(await deps.isCurrent())) return;

  const results = await Promise.allSettled(
    sends.map(async ({ target, plan }) => {
      if (!(await sendPlanned(target, plan, params, deps))) return;
      // An accepted end retires the card's row, so its memory goes with it.
      if (plan.send.event === 'end') await deps.sessionCardMemory?.delete([target.key]);
      else await deps.sessionCardMemory?.put(target.key, plan.content);
    })
  );
  const failed = results.filter(result => result.status === 'rejected').length;
  if (failed > 0) {
    console.warn('Some session card sends failed', { attempted: sends.length, failed });
  }
}
