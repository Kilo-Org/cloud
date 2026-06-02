# cloud-agent-next local E2E harness

Drives the real `pnpm dev:start cloud-agent` stack end-to-end — Worker,
Durable Object, Sandbox container, wrapper, and **real kilo** inside the
sandbox. Only LLM inference is deterministic: kilo's OpenRouter-shaped
calls are routed to a local fake gateway
(`test/e2e/fake-llm-server.ts`) instead of a real model provider.

Not wired into `pnpm test` / CI — this is for local confidence during the
cloud-agent-next refactor.

## One-time setup

1. Copy `.dev.vars.example` → `.dev.vars` and fill in local values.
2. Ensure local Postgres is up and root `.env.local` defines `POSTGRES_URL`
   (or export `DATABASE_URL`) — the driver inserts a test user row via
   `@kilocode/db`.
3. Point kilo at the fake LLM gateway instead of a real provider. Edit
   `services/cloud-agent-next/.dev.vars`:

   ```bash
   # Real LLM (default):
   # KILO_OPENROUTER_BASE=http://localhost:3000/api

   # Fake LLM (E2E harness):
   KILO_OPENROUTER_BASE=http://localhost:<8811 + portOffset>/api
   ```

   `<portOffset>` is the dev-session port offset reported by
   `pnpm dev:status --json` (usually `0` for the first session). The Worker
   calls the fake's `POST /api/openrouter/models/validate` route through this
   host-reachable URL and translates it to `host.docker.internal` when injecting
   sandbox provider configuration.

4. Start the stack including the `fake-llm` dev service:

   ```bash
   pnpm dev:start cloud-agent fake-llm
   ```

   Switching back to a real LLM later is just a `.dev.vars` edit plus a
   `pnpm dev:restart cloud-agent-next` — no flag toggles.

## Running

Single scenario:

```bash
tsx services/cloud-agent-next/test/e2e/run.ts [--api=unified|legacy] <lifecycle> <conversation>
```

Examples:

```bash
tsx services/cloud-agent-next/test/e2e/run.ts cold echo:hi
tsx services/cloud-agent-next/test/e2e/run.ts cold-hot echo:hi
tsx services/cloud-agent-next/test/e2e/run.ts hot echo:hi
tsx services/cloud-agent-next/test/e2e/run.ts followup echo:continue
tsx services/cloud-agent-next/test/e2e/run.ts external-kill echo:hi
tsx services/cloud-agent-next/test/e2e/run.ts kill-mid-flight hang

# Queue semantics — use a gate tag the scenario will pass through as
# `__fake__:gate:<tag>` internally. Queue scenarios ignore the conversation
# value for their own directive and just use it as a tag suffix.
tsx services/cloud-agent-next/test/e2e/run.ts queue-while-busy gate1
tsx services/cloud-agent-next/test/e2e/run.ts queue-overflow _
tsx services/cloud-agent-next/test/e2e/run.ts queue-interrupt-clears _

# Failure, streaming, and cleanup edge cases.
tsx services/cloud-agent-next/test/e2e/run.ts llm-error boom
tsx services/cloud-agent-next/test/e2e/run.ts chunked-streaming slow:5:50
tsx services/cloud-agent-next/test/e2e/run.ts empty-response _
tsx services/cloud-agent-next/test/e2e/run.ts interrupt-mid-stream _
tsx services/cloud-agent-next/test/e2e/run.ts unknown-model _
tsx services/cloud-agent-next/test/e2e/run.ts waiters-clean _

# Callback delivery — driver stands up a local HTTP sink and asserts on receipt.
tsx services/cloud-agent-next/test/e2e/run.ts callback-completion echo:done
tsx services/cloud-agent-next/test/e2e/run.ts callback-batch-followup _
tsx services/cloud-agent-next/test/e2e/run.ts callback-interrupt _

# Legacy API (prepareSession + initiateFromKilocodeSessionV2 / sendMessageV2).
tsx services/cloud-agent-next/test/e2e/run.ts --api=legacy cold-hot echo:legacy
```

Matrix (runs the default regression suite):

```bash
tsx services/cloud-agent-next/test/e2e/smoke.ts
```

The matrix starts with `cold-hot`, which pays one cold sandbox boot and then
runs several hot same-session turns. Fresh sessions use per-session sandboxes
in local dev, so the harness identifies each newly-created sandbox instead of
killing every sandbox between cases. Kill scenarios only terminate the sandbox
family created for that scenario.

Per-run overrides via env vars:

| Var | Default |
|---|---|
| `WORKER_URL` | `http://localhost:8794` |
| `FAKE_LLM_URL` | `http://localhost:8811` (host-side view) |
| `E2E_GIT_URL` | `https://github.com/octocat/Hello-World.git` |
| `E2E_MODEL` | `kilo/fake-deterministic` (the only model the fake serves) |
| `DATABASE_URL` | Optional direct database URL override for this harness |
| `POSTGRES_URL` | Repo database fallback loaded from root `.env.local` / `.env` |

If `DATABASE_URL` is unset, the standalone TSX driver loads root `.env.local`
and `.env`, then falls back to `@kilocode/db` `computeDatabaseUrl()`, which
uses `POSTGRES_URL` for local development.

`FAKE_LLM_URL` is how the **driver** reaches the fake server (for
`/test/release`, `/test/gate-status`, `/test/waiters`, and `/test/requests` side channels). It is separate from
`KILO_OPENROUTER_BASE` in `.dev.vars`, which is the Worker-reachable gateway
base used for lightweight model validation; runtime setup translates local
hostnames for **kilo inside the sandbox** when necessary. If you changed the
fake's port (e.g. non-zero `portOffset`), set both values to the matching
reachable views.

## Gateway contract

The fake gateway serves the Kilo routes used in this harness:

- `GET /api/openrouter/models` - runtime model discovery inside sandboxed kilo.
- `POST /api/openrouter/models/validate` - Worker-side fail-fast model validation.
- `POST /api/openrouter/chat/completions` - deterministic streamed completion scenarios.

## Conversation directives

A conversation directive is embedded in the user-visible prompt as
`__fake__:<scenario>[:<arg1>[:<arg2>...]]`. The fake LLM gateway parses it
from the last user message and dispatches the matching scenario. The
source of directive truth is `test/e2e/fake-llm-server.ts`.

| Directive | Behavior |
|---|---|
| `echo:<text>` | One SSE chunk with `delta.content = <text>`, then `finish_reason: stop`, then `[DONE]`. |
| `slow:<n>:<ms>` | `n` content chunks `<ms>` apart, then stop + `[DONE]`. Used for pacing/timing probes. |
| `idle` | One empty-delta chunk, then stop + `[DONE]`. |
| `hang` | Opens the SSE stream but emits nothing and never closes. Drives abort/timeout paths. |
| `error:<msg>` | HTTP 402 with OpenAI-shaped error body carrying `<msg>`. Exercises kilo's error propagation. |
| `gate:<tag>` | Opens the SSE stream, emits no chunks, blocks until the driver calls `POST /test/release?tag=<tag>`. On release, emits `"done"` + stop + `[DONE]`. |

Unknown or missing directives produce HTTP 402 with
`unknown fake scenario: <name>` — easy to spot in fake-LLM logs.

### Side channels

The fake LLM server exposes four helper endpoints for driver code (not used
by kilo):

- `POST /test/release?tag=<tag>` — release a parked `gate:<tag>` turn. 204
  on hit, 404 if no waiter is parked for that tag.
- `GET /test/gate-status?tag=<tag>` — returns `{ tag, engaged }` so the
  driver can poll until a gate is actually holding a stream (i.e. kilo has
  dialed the fake and the turn is blocked).
- `GET /test/waiters` — returns parked gate counts plus live hang/gate streams
  so scenarios can detect leaked fake-server waiters after a terminal turn.
- `GET /test/requests` — returns chat completion request counts so model
  preflight scenarios can prove that rejected models did not reach dispatch.

These are wrapped by `releaseGate()`, `waitForGateEngaged()`,
`fetchFakeWaiters()`, and `fetchFakeRequests()` in `client.ts`.

## Lifecycle scenarios

| Lifecycle | What it does |
|---|---|
| `cold` | Fresh session; verify a new per-session sandbox appears and the conversation completes. |
| `hot` | Warmup with `echo:warmup`, then send the real prompt on the same session. Same container. |
| `followup` | Same as `hot` today; kept distinct for future resume-path splits. |
| `cold-hot` | One cold turn plus `echo:hot`, `slow:3:50`, and `echo:followup` hot turns on the same session/sandbox. |
| `external-kill` | Warmup, `docker kill` the sandbox, send another prompt, verify recovery/failure. |
| `kill-mid-flight` | Cold `hang`, kill while pending, verify DO surfaces disconnect/error. |
| `queue-while-busy` | Block on `gate:<tag>`, enqueue two echoes, release the gate, assert FIFO delivery through `cloud.message.*` events. |
| `queue-rapid-fire-no-gate` | Send immediate follow-ups behind `echo:first` and assert they reach their terminal FIFO state without gate coordination. |
| `queue-overflow` | Block on `gate:overflow`, fill the pending queue until enqueue fails with HTTP 429, release gate, drain. |
| `queue-interrupt-clears` | Block on `gate:<tag>`, enqueue two, `interruptSession`, assert `cloud.message.failed` with `reason: 'interrupted'` for each. |
| `llm-error` | Return fake provider HTTP 402 and assert the turn reaches a failed terminal event instead of hanging. |
| `chunked-streaming` | Stream delayed fake chunks and assert multiple downstream `message.part.delta` events survive. |
| `empty-response` | Run `idle`, assert completion, and assert no downstream `message.part.delta` is emitted. |
| `interrupt-mid-stream` | Interrupt an actively gated fake request and assert the active message is interrupted, not a queued message. |
| `unknown-model` | Use a model rejected by the fake validation route and require synchronous rejection before sandbox creation or fake chat dispatch. |
| `waiters-clean` | Complete a normal fake turn, then assert the fake server has no parked waiters or live responses. |
| `callback-completion` | Stand up local HTTP sink, register `callbackTarget.url`, run `echo:done`, assert the sink received `status: 'completed'`. |
| `callback-batch-followup` | Queue two turns behind a gated callback session, assert one callback for the final queued turn, then assert a later hot turn emits a fresh callback. |
| `callback-interrupt` | Local HTTP sink + gated active turn + `interruptSession`, assert callback fires with `status: 'interrupted'`. |

### API dimension

The harness exercises both tRPC surfaces. Pass `--api=legacy` to drive the
`prepareSession` + `initiateFromKilocodeSessionV2` + `sendMessageV2`
procedures (what the web UI uses today); the default `--api=unified` uses
the newer `start` / `send` procedures. `prepareSession` requires
`INTERNAL_API_SECRET` — the driver reads it from `.dev.vars` automatically.

## Troubleshooting

- **`Must provide either githubRepo or gitUrl`** — The driver defaults to
  a public HTTPS repo. Override with `E2E_GIT_URL=...` if your network
  blocks GitHub or you prefer a different test repo.
- **`NEXTAUTH_SECRET` not set** — Copy `.dev.vars.example` → `.dev.vars`
  and fill in the local secret (same value used by `apps/web`).
- **`POSTGRES_URL not configured`** — Set root `.env.local` `POSTGRES_URL`,
  or export `DATABASE_URL` to override the database URL for this harness.
- **Sandbox calls out to a real provider** — check `.dev.vars`
  `KILO_OPENROUTER_BASE` is pointing at
  `http://localhost:<8811 + portOffset>/api` and that the `fake-llm` service is
  running (`pnpm dev:status`). Runtime configuration translates this URL for
  sandbox access. Tail the fake's log (`tail -f dev/logs/fake-llm.log`) to
  confirm kilo is hitting it.
- **`waitForGateEngaged` timed out** — kilo never reached the fake LLM. Most
  common cause: `KILO_OPENROUTER_BASE` still points at a real provider or the
  fake service is not running.
- **`releaseGate` returned 404** — the gate already went away, usually
  because the wrapper's request was aborted (e.g. by an `interruptSession`).
  Queue-interrupt-clears tolerates this; other scenarios treat it as an
  error.
