# Session share maintenance tooling

This procedure covers the bounded maintenance script in `scripts/session-shares/`.
It runs in dry-run mode by default and only changes database rows or session
share blobs when `--apply` is passed with an explicit target and a private
manifest path.

The script never prints share ids, blob locations, share capabilities, or
session transcripts. It prints counts and batch sizes. The manifest contains the
reviewed candidate rows and therefore must stay outside the repository, in a
directory readable only by the operator.

## Targets

| Target | Effect |
|---|---|
| `v2-webhook-bot` | Clears `cli_sessions_v2.public_id` only for non-NULL rows whose `kilo_user_id` starts with `bot-webhook-`. |
| `v1-publisher-mismatch` | Removes `shared_cli_sessions` rows whose publisher differs from the source `cli_sessions.kilo_user_id`, then deletes the share's captured `shared-sessions/<share_id>` blobs. |
| `all` | Both targets in one reviewed manifest. |

The v2 target preserves human owners, other bot types, session contents, and
every other row field. The v1 target is based on a publisher/owner comparison,
not on the assumption that only the webhook path can produce a mismatch.

## Execution conditions

Complete all three conditions before applying changes in production.

1. **Confirm the webhook share procedures are gone from the active deployment.**
   Verify that the deployed web application no longer exposes the v1 or v2
   webhook share procedures, and that a new webhook request cannot create a new
   public share. Do not apply while either procedure can still be invoked.
2. **Review the production dry run and verify the v1 rule against real data.**
   Run the dry run with a private manifest path, inspect the candidate counts,
   and review the manifest privately. Confirm that the v1 publisher/owner
   mismatches are the intended rows and that the publisher recorded on each
   share differs from the source owner. The code-level rule is not evidence
   about production data.
3. **Apply the reviewed candidate set, then verify denial and blob cleanup.**
   Reuse the reviewed manifest. Confirm that an old v2 share token and an old v1
   share link no longer resolve, that captured v1 blobs are absent, and that
   unrelated shares and blobs still resolve.

## Dry run

Dry run performs only reads. Without `--manifest` it prints aggregate counts and
does not write a file. With `--manifest` it also records the exact candidate set
for later review and application; no database row or blob is changed.

```sh
POSTGRES_URL='postgres://…' \
  pnpm session-shares:cleanup \
  --target all \
  --manifest /secure/operator/session-share-manifest.json
```

To read production, use the repository's production database selection, for
example `USE_PRODUCTION_DB=true` with `POSTGRES_URL_PRODUCTION` configured, and
run the same command. Keep the manifest and its output private.

Review the manifest privately before applying. It contains the candidate share
ids, owner ids, and captured blob filenames needed to finish deletion after the
share row is removed. The manifest records a hash of the target host, port, and
database name; use the same database connection for the reviewed dry run and the
apply, or the manifest will be rejected. Use a new manifest path when you want a
fresh candidate set.

## Apply

Apply requires `--apply`, `--target`, and `--manifest`. The manifest must come
from a completed dry run. Apply refuses a missing manifest or one whose
discovery did not finish, so it never discovers and removes candidates in a
single step. For v1 targets, apply also needs the web app's existing R2
variables: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and
`R2_CLI_SESSIONS_BUCKET_NAME`. Dry run does not need R2 credentials.

```sh
POSTGRES_URL='postgres://…' \
  pnpm session-shares:cleanup \
  --apply \
  --target all \
  --manifest /secure/operator/session-share-manifest.json
```

The script revalidates every manifest candidate against the current row and
skips candidates that changed after review. It applies the reviewed set in
bounded batches, and for v1 it updates the manifest to `revoking` before the
share row is deleted and to `row_deleted` before the captured blobs are deleted.
If blob deletion fails, the share row stays removed and the manifest keeps the
captured filenames so a later run can finish the deletion.

A complete run exits `0`. A partial run exits `2` and reports remaining items,
failed items, and pending blob deletions. Rerun the same command with the same
manifest to retry or resume. Repeated runs are safe; completed and changed items
are not processed again. Candidates that appear after manifest creation are not
part of the reviewed set and are not removed by that manifest.

Use `--batch-size` (default 200, maximum 1000) to change the batch bound. Use
`--max-attempts` (default 3, maximum 10) to bound retries inside one run.

## Verification

After apply:

- For a v2 candidate, confirm the old share token is rejected by the public
  session share resolver. A human-owned or other-bot share that was not a
  candidate must still resolve.
- For a v1 candidate, confirm `/share/<share_id>` no longer resolves, and that
  the captured `shared-sessions/<share_id>` objects are gone. An owner-matched
  share and unrelated blobs must remain.
- Rows whose stored blob URL is outside the share's canonical
  `shared-sessions/<share_id>` prefix are revoked, but that blob is left in
  place and counted in `unsafe_blob_items` for private review.
- Re-run apply with the same manifest and confirm it reports complete with no
  further changes.

## Unresolved categories

These rows are deliberately not removed by this tooling:

- **Orphan v1 shares.** A `shared_cli_sessions` row with `session_id = NULL` has
  no source session to join, so the publisher/owner rule cannot classify it.
  The dry run reports the orphan count. It is not a candidate and is not
  deleted.
- **Unmatched v1 shares.** A non-NULL `session_id` with no source row is reported
  separately as unmatched and is also not a candidate.
- **Human-owned v2 shares published by a colleague.** These cannot be
  distinguished from ordinary self-shares by stored data. The tooling leaves all
  human-owned v2 shares alone.

Do not broaden deletion, remove unrelated shares, or revoke all human or
organization shares to compensate for these categories. Review them separately.

## Local verification

The script tests use a fake in-memory blob store with the same key shape as the
R2 adapter; they do not use a real R2-compatible service. Database effects run
against a real local PostgreSQL database. CI typechecks the tooling, but does
not run this suite because it needs a disposable database; run it manually
before applying changes.

```sh
POSTGRES_URL='postgres://postgres:postgres@localhost:5432/share_cleanup_test' \
  pnpm test:session-shares
```

The test database must be disposable and its name must contain `test` or
`share_cleanup`. The tests drop and recreate only the tables they need.
