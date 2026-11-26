import { IdentityStoreError } from '../db/client';
import {
  NOTICE_CHANNEL_PLAN,
  type OutOfBandChannel,
  type RenderedNotice,
  noticeEmail,
  noticePush,
  renderNotice,
} from './kinds';
import type { ClaimedNotice, FinishResult, NoticeAttempt, NoticesAccess } from './store';
import type { ChannelOutcome, NoticeTransports } from './transports';

/**
 * Delivers claimed notices: push, then email, for the channels the kind uses and an earlier round
 * did not settle, then one finish statement with the round's attempts. The identity-store
 * connection is not held while a provider answers: the claim and the finish each open their own.
 *
 * A provider that throws counts as a retryable failure of its channel; the next channel is still
 * tried, and the notice comes back in a later round (design 5.13: a notice failure never blocks
 * the action that caused it, and the in-app row stays whatever happens).
 */

export type NoticeDeps = {
  notices: NoticesAccess;
  transports: NoticeTransports;
  now: () => Date;
};

export type DeliveryResult = {
  noticeId: string;
  attempts: NoticeAttempt[];
  finish: FinishResult;
};

/** Delivery rounds a background pass claims at most; each round makes at most 2 provider calls. */
export const NOTICE_SWEEP_LIMIT = 20;

async function sendOn(
  channel: OutOfBandChannel,
  claimed: ClaimedNotice,
  rendered: RenderedNotice,
  transports: NoticeTransports
): Promise<ChannelOutcome> {
  try {
    if (channel === 'push') {
      if (transports.push === null) return 'not_configured';
      return await transports.push({
        accountId: claimed.accountId,
        idempotencyKey: `uts-notice:${claimed.noticeId}`,
        ...noticePush(rendered),
      });
    }
    if (transports.email === null) return 'not_configured';
    const to = [claimed.primaryEmail];
    if (claimed.oldEmail !== null && claimed.oldEmail !== claimed.primaryEmail) {
      to.push(claimed.oldEmail);
    }
    return await transports.email({ to, ...noticeEmail(rendered) });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'uts.notice.provider_failed',
        channel,
        kind: claimed.kind,
        error: error instanceof Error ? error.name : 'unknown',
      })
    );
    return 'retryable_failure';
  }
}

/**
 * One delivery round of a claimed notice. A text that cannot be rendered without a link (which
 * `renderNotice` refuses) settles every channel as a permanent failure: no retry renders it
 * differently, and the in-app row still shows the event.
 */
export async function deliverClaimed(
  deps: NoticeDeps,
  claimed: ClaimedNotice
): Promise<DeliveryResult> {
  const planned = NOTICE_CHANNEL_PLAN[claimed.kind];
  let rendered: RenderedNotice | null = null;
  try {
    rendered = renderNotice(claimed.kind, claimed.details, claimed.createdAt);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'uts.notice.render_refused',
        kind: claimed.kind,
        error: error instanceof Error ? error.name : 'unknown',
      })
    );
  }
  const attempts: NoticeAttempt[] = [];
  for (const channel of planned) {
    if (claimed.settledChannels.includes(channel)) continue;
    const outcome =
      rendered === null
        ? 'permanent_failure'
        : await sendOn(channel, claimed, rendered, deps.transports);
    attempts.push({ channel, outcome, attemptedAt: deps.now() });
  }
  const finish = await deps.notices(store =>
    store.finishNotice({
      noticeId: claimed.noticeId,
      claimId: claimed.claimId,
      planned,
      attempts,
    })
  );
  if (finish.outcome === 'stale_claim') {
    // The claim outlived its 5 minutes and another round took the notice; this result is dropped.
    console.error(
      JSON.stringify({ event: 'uts.notice.stale_claim', kind: claimed.kind, round: claimed.round })
    );
  }
  return { noticeId: claimed.noticeId, attempts, finish };
}

/** Claims one notice and delivers it; null when it is not due (delivered, or claimed elsewhere). */
export async function dispatchNotice(
  deps: NoticeDeps,
  noticeId: string
): Promise<DeliveryResult | null> {
  const claimed = await deps.notices(store => store.claimNotice(noticeId));
  return claimed === null ? null : await deliverClaimed(deps, claimed);
}

export type SweepResult = {
  claimed: number;
  delivered: number;
  pending: number;
  failed: number;
  /** Rounds whose finish statement failed; their notices come back after 5 minutes. */
  unfinished: number;
};

/**
 * The background pass: claims up to `NOTICE_SWEEP_LIMIT` due notices (new ones whose immediate
 * delivery never ran, retries, and claims left by a stopped Worker) and delivers them in parallel.
 */
export async function sweepNotices(deps: NoticeDeps): Promise<SweepResult> {
  const claimed = await deps.notices(store => store.claimDueNotices(NOTICE_SWEEP_LIMIT));
  const results = await Promise.allSettled(claimed.map(notice => deliverClaimed(deps, notice)));
  const result: SweepResult = {
    claimed: claimed.length,
    delivered: 0,
    pending: 0,
    failed: 0,
    unfinished: 0,
  };
  for (const settled of results) {
    if (settled.status === 'rejected') {
      result.unfinished += 1;
      const error: unknown = settled.reason;
      console.error(
        JSON.stringify({
          event: 'uts.notice.finish_failed',
          ...(error instanceof IdentityStoreError
            ? { failure: error.failure, sqlState: error.sqlState }
            : { error: error instanceof Error ? error.name : 'unknown' }),
        })
      );
      continue;
    }
    const { finish } = settled.value;
    if (finish.outcome === 'finished') result[finish.delivery] += 1;
  }
  return result;
}
