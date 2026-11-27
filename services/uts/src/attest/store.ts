import type { UtsAttestationType, UtsEnvironment } from '@kilocode/uts-contracts';
import { z } from 'zod';
import { type IdentityStore, type WaitUntil, withIdentityStore } from '../db/client';

/**
 * The attestation statements (migration `0017_mobile_attestation.sql`), one SQL statement each:
 * claim a code's attestation before verifying it, and settle the claim with the result.
 */

export type ClaimInput = {
  codeHash: Uint8Array;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  dpopJkt: Uint8Array;
  claimId: string;
  /** Null when the request carries no attestation (a retry of an attested exchange). */
  proof: { type: UtsAttestationType; keyId: Uint8Array | null } | null;
};

export type ClaimResult =
  | { outcome: 'claimed'; storedKey: { publicKey: Uint8Array; signCount: number } | null }
  | {
      outcome:
        | 'attested'
        | 'proof_required'
        | 'unknown_key'
        | 'busy'
        | 'refused'
        | 'reused'
        | 'invalid_grant';
    };

export type SettleInput = {
  environment: UtsEnvironment;
  codeHash: Uint8Array;
  claimId: string;
  result:
    | { kind: 'attested'; publicKey: Uint8Array | null; signCount: number | null }
    | { kind: 'refused'; reason: string }
    | { kind: 'released' };
};

export type SettleOutcome = 'attested' | 'refused' | 'key_known' | 'released' | 'stale';

export type AttestationStore = {
  claim(input: ClaimInput): Promise<ClaimResult>;
  settle(input: SettleInput): Promise<SettleOutcome>;
  /**
   * Development without attestation config only: marks the code exempt, so the exchange
   * statement's backstop lets it through. The statement refuses every other environment.
   */
  exempt(input: { environment: UtsEnvironment; codeHash: Uint8Array }): Promise<void>;
};

/** Runs `work` with the attestation store of one identity-store connection. */
export type AttestationAccess = <Result>(
  work: (store: AttestationStore) => Promise<Result>
) => Promise<Result>;

const ClaimRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('claimed'),
    public_key: z.instanceof(Uint8Array).nullable(),
    sign_count: z.bigint().nullable(),
  }),
  z.object({
    outcome: z.enum([
      'attested',
      'proof_required',
      'unknown_key',
      'busy',
      'refused',
      'reused',
      'invalid_grant',
    ]),
  }),
]);

const SettleRowSchema = z.object({
  outcome: z.enum(['attested', 'refused', 'key_known', 'released', 'stale']),
});

const ExemptRowSchema = z.object({ outcome: z.literal('exempt') });

export function identityStoreAttestations(store: IdentityStore): AttestationStore {
  return {
    async claim(input) {
      const row = await store.maybeOne(
        {
          text: 'SELECT * FROM uts.claim_code_attestation($1, $2, $3, $4, $5, $6, $7, $8)',
          values: [
            input.codeHash,
            input.clientId,
            input.redirectUri,
            input.codeChallenge,
            input.dpopJkt,
            input.claimId,
            input.proof?.type ?? null,
            input.proof?.keyId ?? null,
          ],
        },
        ClaimRowSchema
      );
      if (row === null) throw new Error('uts.claim_code_attestation returned no row');
      if (row.outcome !== 'claimed') return { outcome: row.outcome };
      return {
        outcome: 'claimed',
        storedKey:
          row.public_key === null || row.sign_count === null
            ? null
            : { publicKey: row.public_key, signCount: Number(row.sign_count) },
      };
    },

    async settle(input) {
      const { result } = input;
      const row = await store.maybeOne(
        {
          text: 'SELECT * FROM uts.settle_code_attestation($1, $2, $3, $4, $5, $6, $7)',
          values: [
            input.environment,
            input.codeHash,
            input.claimId,
            result.kind,
            result.kind === 'attested' ? result.publicKey : null,
            result.kind === 'attested' ? result.signCount : null,
            result.kind === 'refused' ? result.reason : null,
          ],
        },
        SettleRowSchema
      );
      if (row === null) throw new Error('uts.settle_code_attestation returned no row');
      return row.outcome;
    },

    async exempt(input) {
      const row = await store.maybeOne(
        {
          text: 'SELECT * FROM uts.exempt_code_attestation($1, $2)',
          values: [input.environment, input.codeHash],
        },
        ExemptRowSchema
      );
      if (row === null) throw new Error('uts.exempt_code_attestation returned no row');
    },
  };
}

/** Each call opens one identity-store connection for its work and closes it in the background. */
export function attestationAccess(connectionString: string, context: WaitUntil): AttestationAccess {
  return work =>
    withIdentityStore(connectionString, context, store => work(identityStoreAttestations(store)));
}
