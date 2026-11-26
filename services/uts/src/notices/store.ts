import { z } from 'zod';
import { type IdentityStore, type WaitUntil, withIdentityStore } from '../db/client';
import {
  NOTICE_ATTEMPT_OUTCOMES,
  NOTICE_CHANNELS,
  NOTICE_DELIVERIES,
  NOTICE_KINDS,
} from '../db/enums';
import type { NoticeKind, OutOfBandChannel } from './kinds';
import type { ChannelOutcome } from './transports';

/**
 * The notice delivery statements (migration `0010_notices.sql`), each one SQL statement through
 * the primary config: claim a notice (`pending` to `sending`, one claim per round), and finish the
 * claim with the round's attempts. The claim is the admission guard: only the statement that moves
 * a row to `sending` gets it, so two Workers never send one round twice.
 */

/** A notice claimed for one delivery round. */
export type ClaimedNotice = {
  noticeId: string;
  claimId: string;
  accountId: string;
  kind: NoticeKind;
  details: Record<string, unknown>;
  createdAt: Date;
  round: number;
  /** The account's primary email when the notice was claimed. */
  primaryEmail: string;
  /** The address an email change replaced; set only for `primary_email_changed`. */
  oldEmail: string | null;
  /** Channels an earlier round settled (sent, no target, not configured, refused). */
  settledChannels: OutOfBandChannel[];
};

export type NoticeAttempt = {
  channel: OutOfBandChannel;
  outcome: ChannelOutcome;
  attemptedAt: Date;
};

export type FinishInput = {
  noticeId: string;
  claimId: string;
  planned: readonly OutOfBandChannel[];
  /** This round's attempts, in the order tried. */
  attempts: readonly NoticeAttempt[];
};

/** `stale_claim`: the claim was not the notice's current one; nothing changed. */
export type FinishResult =
  | { outcome: 'finished'; delivery: 'pending' | 'delivered' | 'failed' }
  | { outcome: 'stale_claim' };

export type NoticeStore = {
  claimNotice(noticeId: string): Promise<ClaimedNotice | null>;
  claimCredentialNotice(
    accountId: string,
    credential: 'pat' | 'bot_key',
    credentialId: string
  ): Promise<ClaimedNotice | null>;
  claimDueNotices(limit: number): Promise<ClaimedNotice[]>;
  finishNotice(input: FinishInput): Promise<FinishResult>;
};

/** Runs `work` with the notice store of one identity-store connection. */
export type NoticesAccess = <Result>(
  work: (store: NoticeStore) => Promise<Result>
) => Promise<Result>;

const OUT_OF_BAND = NOTICE_CHANNELS.filter(
  (channel): channel is OutOfBandChannel => channel !== 'in_app'
);

/** `pg` returns an enum array as an array literal such as `{email,push}`. */
const ChannelListSchema = z
  .string()
  .regex(/^\{((push|email)(,(push|email))*)?\}$/)
  .transform(literal => (literal === '{}' ? [] : literal.slice(1, -1).split(',')))
  .pipe(z.array(z.enum(OUT_OF_BAND)));

const ClaimedRowSchema = z
  .object({
    notice_id: z.uuid(),
    claim_id: z.uuid(),
    account_id: z.string(),
    kind: z.enum(NOTICE_KINDS),
    details: z.record(z.string(), z.unknown()),
    created_at: z.date(),
    round: z.number().int().min(1).max(3),
    primary_email: z.string(),
    old_email: z.string().nullable(),
    settled_channels: ChannelListSchema,
  })
  .transform((row): ClaimedNotice => ({
    noticeId: row.notice_id,
    claimId: row.claim_id,
    accountId: row.account_id,
    kind: row.kind,
    details: row.details,
    createdAt: row.created_at,
    round: row.round,
    primaryEmail: row.primary_email,
    oldEmail: row.old_email,
    settledChannels: row.settled_channels,
  }));

const FinishRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('finished'),
    delivery: z.enum(NOTICE_DELIVERIES).exclude(['sending']),
  }),
  z.object({ outcome: z.literal('stale_claim'), delivery: z.null() }),
]);

function attemptJson(attempt: NoticeAttempt) {
  return {
    channel: attempt.channel,
    outcome: z.enum(NOTICE_ATTEMPT_OUTCOMES).parse(attempt.outcome),
    attemptedAt: attempt.attemptedAt.toISOString(),
  };
}

export function identityStoreNotices(store: IdentityStore): NoticeStore {
  async function claimOne(text: string, values: readonly unknown[]) {
    return await store.maybeOne({ text, values }, ClaimedRowSchema);
  }

  return {
    async claimNotice(noticeId) {
      return await claimOne('SELECT * FROM uts.claim_notice($1)', [noticeId]);
    },

    async claimCredentialNotice(accountId, credential, credentialId) {
      return await claimOne('SELECT * FROM uts.claim_credential_notice($1, $2, $3)', [
        accountId,
        credential,
        credentialId,
      ]);
    },

    async claimDueNotices(limit) {
      return await store.rows(
        { text: 'SELECT * FROM uts.claim_due_notices($1)', values: [limit] },
        ClaimedRowSchema
      );
    },

    async finishNotice(input) {
      const row = await store.maybeOne(
        {
          text: 'SELECT * FROM uts.finish_notice($1, $2, $3, $4)',
          values: [
            input.noticeId,
            input.claimId,
            input.planned,
            JSON.stringify(input.attempts.map(attemptJson)),
          ],
        },
        FinishRowSchema
      );
      if (row === null) throw new Error('uts.finish_notice returned no row');
      return row.outcome === 'finished'
        ? { outcome: 'finished', delivery: row.delivery }
        : { outcome: 'stale_claim' };
    },
  };
}

/** Each call opens one identity-store connection for its work and closes it in the background. */
export function noticesAccess(connectionString: string, context: WaitUntil): NoticesAccess {
  return work =>
    withIdentityStore(connectionString, context, store => work(identityStoreNotices(store)));
}
