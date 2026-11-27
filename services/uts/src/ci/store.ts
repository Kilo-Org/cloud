import type { UtsEnvironment } from '@kilocode/uts-contracts';
import { z } from 'zod';
import { type IdentityStore, type WaitUntil, withIdentityStore } from '../db/client';

/**
 * The CI exchange's one statement, `uts.exchange_ci_token` (migration
 * `0023_ci_token_exchange.sql`). It issues or refuses and writes the audit row in the same
 * statement: `ai.kilo.uts.ci_token.issued` with the new token's id, or
 * `ai.kilo.uts.ci_token.denied` with the reason.
 */

/** The GitHub run a verified OIDC token came from: bounded strings from its claims. */
export type CiRun = {
  repositoryId: string;
  githubEnvironment: string;
  ref: string;
  sha: string;
  eventName: string;
  jobWorkflowRef: string;
  runId: string;
  runAttempt: string;
  /** The OIDC token's `jti`, a reference only. */
  subjectTokenId: string;
};

export type CiExchangeInput = {
  environment: UtsEnvironment;
  policy: string;
  accountId: string;
  scope: string;
  lifetimeSeconds: number;
  run: CiRun;
  /**
   * Null to issue. A reason refuses without issuing and writes only the denied row: a token that
   * names the policy's workflow but breaks its bindings, or a scope the policy does not grant.
   */
  refusal: 'binding_mismatch' | 'scope_not_granted' | null;
};

export type CiExchangeResult =
  | { outcome: 'issued'; tokenId: string }
  | { outcome: 'refused' }
  | { outcome: 'account_inactive' };

export type CiTokenStore = { exchange(input: CiExchangeInput): Promise<CiExchangeResult> };

/** Runs `work` with the CI token store of one identity-store connection. */
export type CiTokenAccess = <Result>(
  work: (store: CiTokenStore) => Promise<Result>
) => Promise<Result>;

const RowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('issued'), token_id: z.uuid() }),
  z.object({ outcome: z.enum(['refused', 'account_inactive']), token_id: z.null() }),
]);

export function identityStoreCiTokens(store: IdentityStore): CiTokenStore {
  return {
    async exchange(input) {
      const { run } = input;
      const row = await store.maybeOne(
        {
          text: `SELECT * FROM uts.exchange_ci_token(
                   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          values: [
            input.environment,
            input.policy,
            input.accountId,
            input.scope,
            input.lifetimeSeconds,
            input.refusal,
            run.repositoryId,
            run.githubEnvironment,
            run.ref,
            run.sha,
            run.eventName,
            run.jobWorkflowRef,
            run.runId,
            run.runAttempt,
            run.subjectTokenId,
          ],
        },
        RowSchema
      );
      if (row === null) throw new Error('uts.exchange_ci_token returned no row');
      return row.outcome === 'issued'
        ? { outcome: 'issued', tokenId: row.token_id }
        : { outcome: row.outcome };
    },
  };
}

/** Each call opens one identity-store connection for its work and closes it in the background. */
export function ciTokenAccess(connectionString: string, context: WaitUntil): CiTokenAccess {
  return work =>
    withIdentityStore(connectionString, context, store => work(identityStoreCiTokens(store)));
}
