# mobile: remote-cli.sh exec run -m kilo-auto/efficient fails ProviderModelNotFoundError — CLI ids need the kilo/ prefix

Symptom: `apps/mobile/e2e/remote-cli.sh exec run -m kilo-auto/efficient --auto "<prompt>"` fails
with `ProviderModelNotFoundError` / `Model not found: kilo-auto/efficient`, and the run still
creates an empty session row in the mobile Agents list.

Cause: the handoff/workflow "kilo-auto/efficient" id is the IN-APP id. The CLI's provider/model
format needs the provider prefix: `kilo/kilo-auto/efficient` (WORKFLOW.md's "kilo/kilo-auto/* are
the same models as CLI ids" is the only place this is stated, and it is easy to read past).

Fix: run `apps/mobile/e2e/remote-cli.sh exec models` first and copy the exact id
(`kilo/kilo-auto/efficient`); never guess from the in-app id. Side effect to expect: each failed
run leaves an empty `New session - <ts>` row in the session list — harmless, but do not confuse
it with the content session when picking rows to tap.

Bonus: a fresh E2E account starts with $0 credit; `kilo/kilo-auto/efficient` then fails with
"Add credits to continue". Seed first:
`pnpm dev:seed app:user-id <email>` then `pnpm dev:seed app:add-credits <user-id> 10`.
