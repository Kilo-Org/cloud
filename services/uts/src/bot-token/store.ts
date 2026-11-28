import type { UtsEnvironment } from '@kilocode/uts-contracts';
import { z } from 'zod';
import { type IdentityStore, type WaitUntil, withIdentityStore } from '../db/client';

/**
 * The bot-token mint's one statement, `uts.mint_bot_token` (migration `0026_bot_token_mint.sql`).
 * It checks the bot account and its membership and writes the audit row in the same statement:
 * `ai.kilo.uts.bot_token.issued` with the new token's id, or `ai.kilo.uts.bot_token.denied` with
 * the reason. The actor of both rows is the calling workload.
 */

export type BotTokenInput = {
  environment: UtsEnvironment;
  workload: string;
  accountId: string;
  orgId: string;
  scope: string;
  lifetimeSeconds: number;
};

export type BotTokenResult =
  | { outcome: 'issued'; tokenId: string }
  | { outcome: 'account_inactive' | 'membership_denied' };

export type BotTokenStore = { mint(input: BotTokenInput): Promise<BotTokenResult> };

/** Runs `work` with the bot-token store of one identity-store connection. */
export type BotTokenAccess = <Result>(
  work: (store: BotTokenStore) => Promise<Result>
) => Promise<Result>;

const RowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('issued'), token_id: z.uuid() }),
  z.object({ outcome: z.enum(['account_inactive', 'membership_denied']), token_id: z.null() }),
]);

export function identityStoreBotTokens(store: IdentityStore): BotTokenStore {
  return {
    async mint(input) {
      const row = await store.maybeOne(
        {
          text: 'SELECT * FROM uts.mint_bot_token($1, $2, $3, $4, $5, $6)',
          values: [
            input.environment,
            input.workload,
            input.accountId,
            input.orgId,
            input.scope,
            input.lifetimeSeconds,
          ],
        },
        RowSchema
      );
      if (row === null) throw new Error('uts.mint_bot_token returned no row');
      return row.outcome === 'issued'
        ? { outcome: 'issued', tokenId: row.token_id }
        : { outcome: row.outcome };
    },
  };
}

/** Each call opens one identity-store connection for its work and closes it in the background. */
export function botTokenAccess(connectionString: string, context: WaitUntil): BotTokenAccess {
  return work =>
    withIdentityStore(connectionString, context, store => work(identityStoreBotTokens(store)));
}
