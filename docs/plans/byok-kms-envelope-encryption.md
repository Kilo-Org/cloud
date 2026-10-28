# BYOK envelope encryption via external KMS service

**Status:** Approved API design; ready for PR 1 implementation
**Context:** Slack thread `C0BJL2D5YTT/p1792769029889259` (team-cloud-agents)

## Problem

BYOK provider keys are encrypted with AES-256-GCM using `BYOK_ENCRYPTION_KEY`, an environment variable on the Cloud web app. A database compromise does not expose plaintext keys, but a compromise of the app runtime exposes the root key and every stored BYOK. The goal is to move the root of trust out of the app runtime, so decrypting a stored key requires an authenticated, auditable, rate-limitable call to a separate service backed by KMS.

## Goals

- A database dump alone cannot reveal BYOK plaintext.
- An app-runtime compromise cannot decrypt the whole table without calling the KMS service; the service can enforce auth, auditing, and rate limits.
- Keys can be rotated at the KMS-key, DEK, and transport layers independently.
- Existing rows keep working throughout rollout.

## Non-goals

- Migrating or backfilling existing rows (follow-up PR).
- Removing `BYOK_ENCRYPTION_KEY` or the legacy `encrypted_api_key` column (follow-up PR).
- Implementing the KMS service itself. This plan defines the client contract only; the service is owned separately.
- Changing the coding-plan inventory encryption (`coding_plan_key_inventory`) or other `encryptApiKey` consumers. They stay on the legacy path.

## Final API contract

Both endpoints are HTTPS `POST` with `content-type: application/json` and `authorization: Bearer <BYOK_KMS_SERVICE_TOKEN>`.

### `POST {BYOK_KMS_SERVICE_URL}/encrypt`

Request:

```json
{
  "jwe": "<compact JWE>"
}
```

The JWE is produced by the app with the shared transport key:

- `alg`: `dir`
- `enc`: `A256GCM`
- protected header:
  - `v`: `1`
  - `owner_type`: `"user"` or `"organization"`
  - `owner_id`: owner's ID
  - `provider_id`: the BYOK provider ID
- plaintext: the UTF-8 BYOK API key

The transport key is `BYOK_KMS_TRANSPORT_ENCRYPTION_KEY` (falls back to `BYOK_ENCRYPTION_KEY`). It protects the HTTP body only. It is not the at-rest root.

Response `200`:

```json
{
  "encrypted_data": { "iv": "<base64>", "data": "<base64>", "authTag": "<base64>" },
  "wrapped_dek": "<base64 KMS ciphertext>",
  "kms_key_id": "arn:aws:kms:...",
  "kms_key_version": "1",
  "algorithm": "aes-256-gcm",
  "envelope_version": 1
}
```

Service behavior:

1. Decrypt the JWE with the transport key. Reject on failure.
2. Read `owner_type`, `owner_id`, `provider_id` from the protected header. Reject if `v` is unknown.
3. Call KMS `GenerateDataKey` with the context `{ owner_type, owner_id, provider_id }` as encryption context.
4. Encrypt the BYOK with the plaintext DEK using AES-256-GCM.
5. Discard the plaintext DEK and return only the envelope above.

### `POST {BYOK_KMS_SERVICE_URL}/decrypt`

Request:

```json
{
  "wrapped_dek": "<base64>",
  "kms_key_id": "arn:aws:kms:...",
  "kms_key_version": "1",
  "context": { "owner_type": "user", "owner_id": "...", "provider_id": "..." }
}
```

Response `200`:

```json
{ "dek": "<base64 32-byte DEK>" }
```

Service behavior: call KMS `Decrypt` on `wrapped_dek` with the supplied `context`; KMS rejects on context mismatch. Return the plaintext DEK. The app decrypts `encrypted_data` in memory and never persists the DEK.

Errors: any non-2xx is treated as a failure by the app. The app does not parse error bodies for control flow.

### Context binding

The context is the row's owner and provider. KMS enforces it, so a wrapped DEK copied to another row, owner, or provider fails to decrypt. The app must send exactly the same context used at encryption time, which is derived from the row's `organization_id` / `kilo_user_id` and `provider_id`. Changing `provider_id` on an existing row is not supported; updates that change provider must re-encrypt.

## Storage

New column on `byok_api_keys`:

- `encrypted_api_key_envelope jsonb NULL` typed as `BYOKApiKeyEnvelope`:

```ts
export type BYOKApiKeyEnvelope = {
  encrypted_data: EncryptedData;
  wrapped_dek: string;
  kms_key_id: string;
  kms_key_version: string;
  algorithm: 'aes-256-gcm';
  envelope_version: 1;
};
```

Store the `/encrypt` response exactly as received (after schema validation).

`encrypted_api_key` stays `NOT NULL` in this PR. Create and update write both columns. Readers prefer the envelope when present and fall back to the legacy column.

Do not store owner or provider inside the envelope. They are already row columns and are reconstructed as KMS context.

### Why these fields

- `kms_key_id` / `kms_key_version`: decrypt old rows after KMS key rotation, and select rows for re-wrap.
- `algorithm` / `envelope_version`: allow a future cipher or envelope migration and a lazy-rotation selector.
- `encrypted_data` / `wrapped_dek`: the ciphertext and its KMS-wrapped DEK.

## Rotation

- **KMS key rotation:** re-wrap `wrapped_dek` under the new KMS key and update `kms_key_id` / `kms_key_version`. Ciphertext is unchanged. Provided by a later `/rewrap` endpoint or a backfill job.
- **DEK / data rotation:** decrypt, re-encrypt, and replace the envelope; bump `envelope_version` when the scheme changes.
- **Transport key rotation:** update the app and the KMS service together. No DB change.
- Row `updated_at` records when an envelope was last written; no separate rotation timestamp.

## Client behavior

### Write path (create and update in `apps/web/src/routers/byok-router.ts`)

1. Validate the credential as today.
2. Encrypt with the legacy `encryptApiKey` (unchanged, still written).
3. If `BYOK_KMS_SERVICE_URL` is set, build the transport JWE and call `/encrypt`; parse the response with Zod.
4. Insert or update both `encrypted_api_key` and `encrypted_api_key_envelope`.
5. If the KMS call fails, fail the mutation. Do not silently write only the legacy column when the service is configured, because that would make the new protection a per-row decision.

When `BYOK_KMS_SERVICE_URL` is unset, write only the legacy column (envelope `NULL`). This keeps local development and existing deployments working.

### Read path

Used by `decryptByokRow` in `packages/web-shared/src/lib/ai-gateway/byok/index.ts` and its callers (`getBYOKforUser`, `getBYOKforOrganization`, `byok-router` test path):

1. If `encrypted_api_key_envelope` is non-null, call `/decrypt` with `wrapped_dek`, `kms_key_id`, `kms_key_version`, and the row context; decrypt `encrypted_data` with the returned DEK in memory.
2. Otherwise, decrypt `encrypted_api_key` with `BYOK_ENCRYPTION_KEY` (unchanged).

Because `decryptByokRow` becomes async and needs owner context, its signature changes. Update all call sites, including `apps/web/src/routers/byok-router.ts`.

Timeouts: set a per-request timeout (proposed 5s) with `AbortSignal.timeout`. A timeout or non-2xx on the read path fails that key's resolution; the gateway should treat the key as unavailable rather than failing open to another credential.

### Client module

Add `packages/web-shared/src/lib/ai-gateway/byok/kms-client.ts` with:

- `getByokKmsClientConfig()` reading `BYOK_KMS_SERVICE_URL`, `BYOK_KMS_SERVICE_TOKEN`, `BYOK_KMS_TRANSPORT_ENCRYPTION_KEY`.
- `encryptByokForStorage({ apiKey, context })` returning the envelope or `null` when unconfigured.
- `decryptByokEnvelope(envelope, context)` returning plaintext.

Use `jose` (`CompactEncrypt` with `dir`/`A256GCM`). `jose` is in the catalog (`6.2.12`) but is not yet a `packages/web-shared` dependency; add it as `"jose": "catalog:"`. Confirm the Jest transform handles `jose` (`apps/web/jest.config.ts` already allows `jose@` in `transformIgnorePatterns`).

No `// comments` in new code, per repo convention.

## Configuration

Add to `.env.local.example` and `ENVIRONMENT.md`:

- `BYOK_KMS_SERVICE_URL` — base URL; unset disables the envelope path. `[SERVER]`
- `BYOK_KMS_SERVICE_TOKEN` — bearer token; required when URL is set. `[SECRET]`
- `BYOK_KMS_TRANSPORT_ENCRYPTION_KEY` — base64 32-byte transport key; falls back to `BYOK_ENCRYPTION_KEY`. `[SECRET]`

`BYOK_ENCRYPTION_KEY` stays required in `config.server.ts` for this PR.

## PR 1 — backwards-compatible schema and dual write

Scope:

1. `packages/db/src/schema-types.ts`: add `BYOKApiKeyEnvelope`.
2. `packages/db/src/schema.ts`: add `encrypted_api_key_envelope: jsonb().$type<BYOKApiKeyEnvelope>()` (nullable) to `byok_api_keys`.
3. Generate the migration with `pnpm drizzle generate --name byok_api_key_envelope`. Do not hand-edit generated SQL or snapshots. The expected DDL is a single nullable `ADD COLUMN`, which is additive and deploy-safe. Review it before committing.
4. `kms-client.ts` and the `jose` dependency.
5. Create/update dual-write in `byok-router.ts`; read preference in `decryptByokRow` and its callers.
6. Config entries in `.env.local.example` and `ENVIRONMENT.md`.
7. Tests:
   - `index.test.ts`: legacy-only rows still decrypt; envelope rows call the KMS client and do not read `BYOK_ENCRYPTION_KEY`; mismatched context fails.
   - `kms-client` unit tests with a stubbed `fetch`: request body shape, bearer header, response Zod validation, non-2xx failure, timeout.
   - `byok-router` create/update: envelope unset leaves the column `NULL`; service configured writes both columns; KMS failure fails the mutation.
   - Migration consistency via `packages/db/src/schema.test.ts`.
8. `user/index.ts` `softDeleteUser` already deletes `byok_api_keys` rows by `kilo_user_id`; no change needed. Confirm in `apps/web/src/lib/user/index.test.ts` coverage still passes.

Out of scope for PR 1: backfill, removing the legacy column, `/rewrap`, any change to `coding_plan_key_inventory`, `custom_llm`, or ChatGPT OAuth connection encryption.

Verification: `pnpm --filter @kilocode/db typecheck`, `pnpm --filter web typecheck` (or repo `pnpm typecheck`), `pnpm lint`, targeted Jest for the BYOK tests, and `pnpm drizzle:verify-bootstrap`.

## PR 2 — backfill and cutover (follow-up, not planned in detail here)

1. Backfill: for each row with `encrypted_api_key_envelope IS NULL`, decrypt legacy, call `/encrypt`, write the envelope. Run as a batched, resumable job; verify counts.
2. Stop legacy writes; keep the legacy column populated until verified.
3. Make `encrypted_api_key` nullable; stop reading it.
4. Drop `encrypted_api_key` and remove `BYOK_ENCRYPTION_KEY` from `config.server.ts` once the envelope is the only path.

## Open items

- KMS service ownership, deployment, and audit/rate-limit policy.
- Exact KMS key ARN per environment and the initial `kms_key_version` value.
- Whether `/rewrap` is a service endpoint or a job that calls `Decrypt` + `Encrypt` on the service side.
- Behavior for coding-plan-managed keys (`management_source = 'coding_plan'`): they go through the same write path only if the coding-plan flow calls the same router; verify before PR 1 lands.
