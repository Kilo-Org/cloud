# AGENTS.md

## Scope

`services/kiloclaw-billing` owns the KiloClaw billing lifecycle worker.

## Allowed Writes

- This worker is allowed to write KiloClaw billing state in Postgres via Hyperdrive.
- This includes `kiloclaw_subscriptions`, `kiloclaw_instances`, `kiloclaw_email_log`, and related billing ledger rows touched by the lifecycle sweeps.

## Boundaries

- Keep KiloClaw machine lifecycle actions in the `kiloclaw` worker. Use its `/api/platform/*` contract through the `KILOCLAW` service binding.
- Keep Next.js-only billing helpers behind the internal billing side-effect endpoint. Do not call Stripe, Mailgun, or Impact directly from this worker in phase 1.
- Preserve sweep ordering and per-row error isolation. Do not fan out one queue message per row.
