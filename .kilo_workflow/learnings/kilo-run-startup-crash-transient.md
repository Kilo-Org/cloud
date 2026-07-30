# kilo run crashes at startup (credential write / Session not found) — transient, redispatch once

Symptom: a dispatched `kilo run` dies within seconds, before any real work, with `EXITCODE=1`
and one of these signatures as its last lines:

- `Failed query: update "credential" set "value" = ... _tag: "EffectDrizzleQueryError"` plus a
  Bun stack trace — the CLI refreshed its OAuth token at startup and the SQLite write to the
  shared credential store failed under contention (many parallel `kilo run` processes).
- `Session not found` or another `EffectDrizzleQueryError` — the local SQLite session store
  raced on first write when many CLIs launched at once.

Either way the round is void (no sentinel). The token itself is fine — the logged payload
carries a far-future `exp` — and no `~/.local/share/kilo/kilo-<branch>.db` gets created.

Cause: startup races on the machine-local SQLite stores, under contention from parallel
workflows. Transient; unrelated to the prompt, model, flags, or agent definition.

Fix: discard the void round and dispatch a fresh session — the identical redispatch typically
succeeds immediately. It still counts toward the loop's round cap. The launch scripts
(`dispatch-role.sh`, `launch-interactive.sh`) space concurrent launches ~3s apart through a
machine-global gate, which keeps fan-outs from clustering into this crash; a hand launch gets
no such protection.

Before redispatching, rule out the look-alikes that will NOT clear on retry:

- **Disk full** — the classic cause of SQLite write failures: `df -h /Users`.
- **Auth genuinely wedged** — `PAID_MODEL_AUTH_REQUIRED` needs an interactive `kilo auth login`.
  If the logged credential payload has a future `exp`, auth is not the problem.
- **Poisoned env / known-bad CLI** — a run inheriting a parent kilo's `KILO_*`/`OPENCODE*` env
  hits `Session not found` deterministically (the launch scripts strip these; a hand launch must
  too); CLI 7.4.13–7.4.15 had a fresh-database `Session not found` bug on macOS, fixed in 7.4.16.

Handling notes: the crash log's `params` can include the OAuth **refresh JWT** — redact
`eyJ[A-Za-z0-9_.-]+` before keeping any of it as evidence. Never delete
`~/.local/share/kilo/auth.json`, `account.json`, or any `kilo-*.db`, and never kill another
workflow's `kilo run` to free a lock. Three consecutive void rounds with this signature is an
infrastructure blocker to report, not something to keep redispatching through.

Distinct from the mid-run provider stream stall (exit 0 after real work, reported VOID by `await-role.sh`).
