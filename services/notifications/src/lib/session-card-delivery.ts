/**
 * Remote updates and ends for the per-session Live Activity
 * (`.specs/mobile-session-live-activity.md`). The aggregate refresh reads the
 * facts of each followed session in the same build, and this module turns them
 * into one APNs push per session card token. Pure: all IO is injected.
 */

import { glanceableStatusKind } from '@kilocode/app-shared/glanceable-agents-snapshot';
import {
  buildSessionLiveActivityContentState,
  sessionLiveActivityRelevance,
  type SessionLiveActivityContentState,
} from '@kilocode/notifications';
import { z } from 'zod';

import type { LiveActivityPriority } from './apns-live-activity';
import type { GlanceableApnsContentState } from './glanceable-delivery';

/** Matches the session card factory name in the widget extension. */
export const SESSION_LIVE_ACTIVITY_NAME = 'SessionLiveActivity';

/** A finished session card stays on the Lock Screen this long (spec "Ending" rule 1). */
export const SESSION_CARD_FINISHED_DISMISS_MS = 15 * 60_000;

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
    })
    .nullable(),
});
export type SessionCardSource = z.infer<typeof sessionCardSourceSchema>;

export type IosSessionActivityToken = { token: string; sessionId: string };

export type SessionCardSend = {
  token: string;
  event: 'update' | 'end';
  contentState: GlanceableApnsContentState;
  priority: LiveActivityPriority;
  relevanceScore: number;
  /** Unix seconds; set on every end. */
  dismissalDateSeconds?: number;
};

/** The content a token last accepted, so an unchanged card is not pushed again. */
export type SessionCardMemory = {
  list: () => Promise<Map<string, SessionLiveActivityContentState>>;
  put: (token: string, content: SessionLiveActivityContentState) => Promise<void>;
  delete: (tokens: string[]) => Promise<void>;
};

export type SessionCardDeliveryDeps = {
  listIosSessionActivityTokens: (
    userId: string,
    organizationId: string | null
  ) => Promise<IosSessionActivityToken[]>;
  /** Resolves true when APNs accepted the push. */
  sendIosSessionLiveActivity: (
    send: SessionCardSend,
    timestampSeconds: number,
    isCurrent?: () => Promise<boolean>
  ) => Promise<boolean>;
  sessionCardMemory?: SessionCardMemory;
  isCurrent?: () => Promise<boolean>;
};

function sameContent(
  left: SessionLiveActivityContentState,
  right: SessionLiveActivityContentState
): boolean {
  // `updatedAt` changes on every build; only what the card shows counts.
  return (
    JSON.stringify({ ...left, updatedAt: null }) === JSON.stringify({ ...right, updatedAt: null })
  );
}

/**
 * Plan the push for one session card token, or null when the card already
 * shows this content.
 *
 * - A session that is gone or out of scope ends at once.
 * - A finished (`idle`) session ends with the Finished content and stays on
 *   the Lock Screen for `SESSION_CARD_FINISHED_DISMISS_MS`.
 * - Every other change is an update. Entering needs input uses priority 10;
 *   all other updates use 5, which does not count toward the iOS budget.
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
    const content: SessionLiveActivityContentState = previous ?? {
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
        contentState: envelope(content),
        priority: 10,
        relevanceScore: sessionLiveActivityRelevance('idle'),
        dismissalDateSeconds: nowSeconds,
      },
    };
  }

  const statusKind = glanceableStatusKind(source.row.status);
  const content = buildSessionLiveActivityContentState(
    { id: sessionId, ...source.row },
    {
      approvalKey: source.row.approvalKey,
      updatedAt,
      // Keep the shown timer when the row carries no status time and the kind
      // did not change; a fresh time on every build would restart it.
      statusSinceFallback:
        previous?.statusKind === statusKind ? previous.statusSince : updatedAt,
    }
  );
  if (statusKind === 'idle') {
    return {
      content,
      send: {
        token,
        event: 'end',
        contentState: envelope(content),
        priority: 10,
        relevanceScore: sessionLiveActivityRelevance('idle'),
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
      contentState: envelope(content),
      priority: statusKind === 'needsInput' && previous?.statusKind !== 'needsInput' ? 10 : 5,
      relevanceScore: sessionLiveActivityRelevance(statusKind),
    },
  };
}

/**
 * Push every followed session card in one scope. A token whose session the
 * build did not read (a card followed while the build ran) waits for the
 * refresh its registration requested. `'end_all'` ends every card in the
 * scope at once: the user lost access to it.
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
  const tokens = await deps.listIosSessionActivityTokens(params.userId, params.organizationId);
  const memory = (await deps.sessionCardMemory?.list()) ?? new Map();
  const live = new Set(tokens.map(({ token }) => token));
  const forgotten = [...memory.keys()].filter(token => !live.has(token));
  if (forgotten.length > 0) await deps.sessionCardMemory?.delete(forgotten);

  const sources =
    params.sources === 'end_all'
      ? null
      : new Map(params.sources.map(source => [source.sessionId, source]));
  const sends = tokens.flatMap(({ token, sessionId }) => {
    const source = sources === null ? { sessionId, row: null } : sources.get(sessionId);
    if (source === undefined) return [];
    const plan = planSessionCardSend({
      token,
      sessionId,
      source,
      previous: memory.get(token),
      updatedAt: params.updatedAt,
      nowSeconds: params.nowSeconds,
    });
    return plan === null ? [] : [plan];
  });
  if (sends.length === 0) return;
  if (deps.isCurrent && !(await deps.isCurrent())) return;

  const results = await Promise.allSettled(
    sends.map(async ({ send, content }) => {
      const accepted = await deps.sendIosSessionLiveActivity(
        send,
        params.timestampSeconds,
        deps.isCurrent
      );
      if (!accepted) return;
      // An accepted end retires the token row, so its memory goes with it.
      if (send.event === 'end') await deps.sessionCardMemory?.delete([send.token]);
      else await deps.sessionCardMemory?.put(send.token, content);
    })
  );
  const failed = results.filter(result => result.status === 'rejected').length;
  if (failed > 0) {
    console.warn('Some session Live Activity sends failed', { attempted: sends.length, failed });
  }
}
