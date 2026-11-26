import {
  type UtsEnvironment,
  type UtsTicketPurpose,
  UtsTicketPurposeSchema,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import { type IdentityStore, type WaitUntil, withIdentityStore } from '../db/client';
import type { ProofBinding } from '../grants/store';

/**
 * The one-time ticket statements (migration `0008_passkeys_device_tickets.sql`, design 5.3): a
 * ticket is minted from a first-party grant in one statement with its audit row, and consumed by
 * its first redemption in one statement with its audit row.
 */

export type IssueTicketInput = {
  environment: UtsEnvironment;
  tokenHash: Uint8Array;
  grantId: string;
  clientId: string;
  proof: ProofBinding;
  ticketHash: Uint8Array;
  purpose: UtsTicketPurpose;
  audience: string;
  resource: string | null;
};

export type IssueTicketResult =
  | { outcome: 'issued'; expiresAt: Date }
  | { outcome: 'invalid_grant' | 'invalid_target' | 'dpop_mismatch' | 'dpop_replay' };

export type RedeemedTicket = {
  accountId: string;
  purpose: UtsTicketPurpose;
  resource: string | null;
  orgId: string | null;
  grantId: string;
  clientId: string;
};

export type RedeemTicketResult =
  | ({ outcome: 'redeemed' } & RedeemedTicket)
  | { outcome: 'unknown' };

export type TicketStore = {
  issue(input: IssueTicketInput): Promise<IssueTicketResult>;
  redeem(
    environment: UtsEnvironment,
    ticketHash: Uint8Array,
    audience: string
  ): Promise<RedeemTicketResult>;
};

export type TicketAccess = <Result>(
  work: (store: TicketStore) => Promise<Result>
) => Promise<Result>;

export function ticketAccess(connectionString: string, context: WaitUntil): TicketAccess {
  return work =>
    withIdentityStore(connectionString, context, store => work(identityStoreTickets(store)));
}

const IssueRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('issued'), ticket_expires_at: z.date() }),
  z.object({
    outcome: z.enum(['invalid_grant', 'invalid_target', 'dpop_mismatch', 'dpop_replay']),
  }),
]);

const RedeemRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('redeemed'),
    ticket_account: z.string(),
    ticket_purpose: UtsTicketPurposeSchema,
    ticket_resource: z.string().nullable(),
    ticket_org: z.uuid().nullable(),
    ticket_grant: z.uuid(),
    ticket_client: z.string(),
  }),
  z.object({ outcome: z.literal('unknown') }),
]);

export function identityStoreTickets(store: IdentityStore): TicketStore {
  async function one<Row extends z.ZodType>(
    text: string,
    values: readonly unknown[],
    row: Row
  ): Promise<z.output<Row>> {
    const result = await store.maybeOne({ text, values }, row);
    if (result === null) throw new Error('a ticket function returned no row');
    return result;
  }

  return {
    async issue(input) {
      const row = await one(
        'SELECT * FROM uts.issue_ticket($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          input.environment,
          input.tokenHash,
          input.grantId,
          input.clientId,
          input.proof.jkt,
          input.proof.jti,
          input.ticketHash,
          input.purpose,
          input.audience,
          input.resource,
        ],
        IssueRowSchema
      );
      if (row.outcome !== 'issued') return { outcome: row.outcome };
      return { outcome: 'issued', expiresAt: row.ticket_expires_at };
    },

    async redeem(environment, ticketHash, audience) {
      const row = await one(
        'SELECT * FROM uts.redeem_ticket($1, $2, $3)',
        [environment, ticketHash, audience],
        RedeemRowSchema
      );
      if (row.outcome !== 'redeemed') return { outcome: 'unknown' };
      return {
        outcome: 'redeemed',
        accountId: row.ticket_account,
        purpose: row.ticket_purpose,
        resource: row.ticket_resource,
        orgId: row.ticket_org,
        grantId: row.ticket_grant,
        clientId: row.ticket_client,
      };
    },
  };
}
