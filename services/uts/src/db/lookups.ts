import { z } from 'zod';
import type { IdentityStore } from './client';
import { BOT_KEY_STATUSES } from './enums';

/**
 * PAT and org bot key lookups, the only statements the PAT Hyperdrive config runs. Each calls a
 * stored function that probes the unique index on the token hash; no row means the token is
 * unknown, revoked, expired, owned by a blocked account, or (for a bot key) past its flagged
 * cutoff.
 */

export const PatLookupRowSchema = z.strictObject({
  pat_id: z.uuid(),
  account_id: z.string(),
  audience: z.string(),
  scope: z.string(),
  org_id: z.uuid().nullable(),
  expires_at: z.date(),
});

export const BotKeyLookupRowSchema = z.strictObject({
  bot_key_id: z.uuid(),
  org_id: z.uuid(),
  audience: z.string(),
  scope: z.string(),
  status: z.enum(BOT_KEY_STATUSES),
  valid_until: z.date(),
});

const TokenHashSchema = z
  .instanceof(Uint8Array)
  .refine(value => value.byteLength === 32, 'expected a 32-byte SHA-256 hash');

export function lookupPat(store: IdentityStore, tokenHash: Uint8Array) {
  return store.maybeOne(
    { text: 'SELECT * FROM uts.lookup_pat($1)', values: [TokenHashSchema.parse(tokenHash)] },
    PatLookupRowSchema
  );
}

export function lookupBotKey(store: IdentityStore, tokenHash: Uint8Array) {
  return store.maybeOne(
    { text: 'SELECT * FROM uts.lookup_bot_key($1)', values: [TokenHashSchema.parse(tokenHash)] },
    BotKeyLookupRowSchema
  );
}
