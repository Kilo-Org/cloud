# cloud-agent-next local E2E harness

Drives the real `pnpm dev:start cloud-agent` stack end-to-end — Worker,
Durable Object, Sandbox container, wrapper, and **real kilo** inside the
sandbox. Only LLM inference is deterministic: selecting
`kilo/fake-deterministic` makes the local Next.js gateway proxy kilo's
OpenRouter-shaped calls to `test/e2e/fake-llm-server.ts`.

Not wired into `pnpm test` / CI — this is for local confidence during the
cloud-agent-next refactor.

## One-time setup

1. Copy `.dev.vars.example` → `.dev.vars` and fill in local values.
   Leave `KILO_OPENROUTER_BASE` pointed at local Next.js (`@url nextjs/api`).
   For control-plane scenarios, enroll the E2E user in `CONTROL_PLANE_IDS`.
   `worktree-shared` additionally requires `WORKTREE_CREATION_ENABLED_IDS`; it creates a fresh
   personal user per run, so set both flags to `*` for that local scenario.
   Both accept comma-separated user or org IDs or `*`. Production defaults to empty/off;
   wrangler `dev` and `.dev.vars.example` default to `*`.
   Ordinary control-plane scenarios do not require `WORKTREE_CREATION_ENABLED_IDS`.
   These are Worker settings read by `auth.ts` from this service's `.dev.vars`,
   not driver environment overrides: prefixing the driver command with either
   flag does not configure the Worker. The unannotated template entries pass
   through matching root `.env.local` values during `pnpm dev:env`. Configure
   the Worker before starting it, or restart it after changing these values.
2. Ensure local Postgres is up and root `.env.local` defines `POSTGRES_URL`
   (or export `DATABASE_URL`) — the driver inserts a test user row via
   `@kilocode/db`.
3. Start the stack. The `cloud-agent` group already includes `fake-llm`:

   ```bash
   pnpm dev:start cloud-agent
   ```

   Selecting `kilo/fake-deterministic` is enough to hit fake-llm through
   Next.js. A real-model session (`kilo-auto/efficient`, etc.) uses the same
   Worker URL and does not need a restart.

## Credential containment

Control-plane sessions (`workspace_*`) respect `CREDENTIAL_CONTAINMENT_ENABLED`.
Only the literal `false` disables containment; local dev defaults to `false`.
The choice is persisted when a worktree is created and inherited by sibling chats.
Changing the environment does not switch an existing worktree or running sandbox
between contained and direct credentials.

When enabled, Cloudflare uses contained sandbox classes and the existing credential
broker; Vercel uses native network policies. Each worktree has stable credential
aliases shared by its registered Kilo roots, while different worktrees have
separate Kilo authentication contexts. Containment failures never fall back to
raw credentials. When disabled, authorized Kilo and repository credentials are
provided directly to the sandbox without alias redemption or credential injection.
Control-plane ownership, attachment scope, terminal authorization, and billing
checks still apply; direct API credentials retain their underlying access scope.
Expired direct-credential terminal leases require a session reattachment rather
than renewing only the server-side grant.

Cloudflare's native outbound handler intercepts ports 80 and 443. With containment
enabled, local targets such as `http://host.docker.internal:<offset-port>` can
bypass interception and reject aliases with HTTP 401. Contained E2E runs therefore
need sandbox-facing endpoints that traverse the native handler, plus the running
`cloudflare-git-token-service` and its capability-encryption configuration. The
local-dev direct-credential mode supports the generated high-port HTTP endpoints.

For new legacy sessions (`agent_*`), `CREDENTIAL_CONTAINMENT_ENABLED` controls
GitHub, GitLab, Bitbucket, and Kilo credential containment together. Containment
is enabled unless this variable is set to `false`. Local `dev` defaults to
`false`; set `CREDENTIAL_CONTAINMENT_ENABLED=true` in `.dev.vars` when using
proxy-compatible upstreams. Legacy devcontainer sessions remain excluded because
DIND does not support managed SCM containment.

Legacy containment flags are persisted at session creation, so changing the
variable affects new legacy sessions, not existing ones.

## Running

> **Non-zero port offset:** except for `multichat-real.ts`, the drivers below use
> the default ports (`8794`/`8811`), which only match a zero-offset session. For any other
> session, first read the offset from `pnpm dev:status --json`
> (`portOffset` field), then prefix every driver invocation with
> `WORKER_URL=http://localhost:<8794 + portOffset>` and
> `FAKE_LLM_URL=http://localhost:<8811 + portOffset>`. Without these the
> driver silently hits the wrong Worker/fake-LLM and every scenario fails
> at connection. See the env-var table below for the full list.

Real-model multichat acceptance (`kilo-auto/efficient`):

```bash
pnpm exec tsx services/cloud-agent-next/test/e2e/multichat-real.ts \
  --auth /path/to/private-auth.json \
  --out dev/logs/multichat-new-run \
  --rounds 3
```

This driver discovers the existing local stack's ports and requires an already
funded test user enrolled for control-plane and worktree creation. Pass credentials
only through an owned mode-600 auth file, never as a command-line token. The output
directory must not already exist. Bootstrap is API-assisted; sibling creation,
sends, and Stop use the real web endpoints. Three chats exercise repeated shared
file writes/reads, native tool overlap, Stop isolation, and post-Stop follow-ups.
Private reports and transcripts are retained; chats and sandboxes are not deleted
automatically. See the known CLI 7.4.20 limitation under Troubleshooting.

Official SDK basic-chat acceptance (pinned `@kilocode/sdk/v2` `7.6.2`):

```bash
pnpm --filter cloud-agent-next exec tsx test/e2e/sdk-basic-chat.ts
```

This uses a funded ephemeral local user and sends only `Authorization: Bearer ...`
to `/kilo`; prompt mutations therefore pass through real public balance
validation rather than the legacy lifecycle driver's tRPC bypass header. Because
`client.session.create()` is deliberately unsupported by the basic facade, the
driver first materializes one owned root through the existing lifecycle setup,
then proves SDK attach/chat behavior: warm and cold projected reads, cold event
wake-up plus `promptAsync()`, intentional `prompt()` rejection, active `abort()`,
stable warm/cold message pagination, and selector rejection without transcript mutation.
It stops owned sandbox families and releases any fake-LLM gate in cleanup.

Focused lifecycle scenario:

```bash
tsx services/cloud-agent-next/test/e2e/run.ts [--api=unified|legacy] [--timeout-ms=<n>] <lifecycle> <conversation>
```

`--timeout-ms=<n>` sets one finite, positive overall deadline for the selected
`long-session`, `cold-resume`, `multi-session-collab`, or continuity scenario
(`recover-same-session`, `interrupt-then-continue`, `warm-cold-cycles`,
`question-idle-resume`, `large-stream`, `concurrent-chats`), and for any shared
scenario (`cold-hot`, `unknown-model`, `auth-reject`, `worktree-chat`,
`worktree-multi-chat`, `long-conversation`, `leave-and-return`); it is not a
per-operation timeout. The flag is rejected for all other scenarios.

Examples:

```bash
tsx services/cloud-agent-next/test/e2e/run.ts cold echo:hi
tsx services/cloud-agent-next/test/e2e/run.ts cold-hot echo:hi
tsx services/cloud-agent-next/test/e2e/run.ts worktree-shared _
tsx services/cloud-agent-next/test/e2e/run.ts worktree-chat _
tsx services/cloud-agent-next/test/e2e/run.ts worktree-multi-chat _
tsx services/cloud-agent-next/test/e2e/run.ts long-conversation echo:cold
tsx services/cloud-agent-next/test/e2e/run.ts leave-and-return _
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

# Callback delivery — the scenario opens a callback sink and asserts on receipt.
# `callbackTarget` is accepted by prepareSession only, so these scenarios pin
# `api: 'legacy'` themselves; `--api=legacy` is not needed. Under local Docker
# the sink is a host HTTP server (workerd can POST http://127.0.0.1:<ephemeral>
# on the same host; no tunnel). Over HTTP the sink is the e2e surface
# (`POST /__e2e/callbacks`) and the Worker self-fetches the returned URL. Use the
# cloud-worktree-setup user so GitHub-backed clones have an installation token.
E2E_USER_EMAIL=evgeny@kilocode.ai E2E_GITHUB_REPO=na2-org/hi-how-are-you \
  WORKER_URL=http://localhost:<8794+offset> FAKE_LLM_URL=http://localhost:<8811+offset> \
  tsx services/cloud-agent-next/test/e2e/run.ts callback-completion echo:done
tsx services/cloud-agent-next/test/e2e/run.ts callback-batch-followup _
tsx services/cloud-agent-next/test/e2e/run.ts callback-interrupt _

# Legacy API (prepareSession + initiateFromKilocodeSessionV2 / sendMessageV2).
tsx services/cloud-agent-next/test/e2e/run.ts --api=legacy cold-hot echo:legacy
```

Long-running scenarios (`long-session`, `cold-resume`,
`multi-session-collab`, and the continuity scenarios `recover-same-session`,
`interrupt-then-continue`, `warm-cold-cycles`, `question-idle-resume`,
`large-stream`, `concurrent-chats`) are not included in `smoke.ts`'s
`DEFAULT_MATRIX`. The four shared public-surface scenarios `worktree-chat`,
`worktree-multi-chat`, `long-conversation` and `leave-and-return` are
deliberately not added to `DEFAULT_MATRIX` either: they are long, so run them
with `run.ts` locally and they run automatically in `smoke-deployed` (with the
other shared scenarios). Long scenarios take 6–30 minutes and require the funded
seeded user (`E2E_USER_EMAIL=evgeny@kilocode.ai`), the offset-prefixed
`WORKER_URL` and `FAKE_LLM_URL`, and `E2E_MODEL=kilo/fake-deterministic`; the new
scenarios reject other models. They use the unified API and require
control-plane/worktree enrollment.

Matrix (runs the default regression suite):

```bash
tsx services/cloud-agent-next/test/e2e/smoke.ts
```

The matrix starts with `cold-hot`, which pays one cold sandbox boot and then
runs several hot same-session turns. The matrix tracks the session IDs returned by its own start/prepare calls.
After each scenario, including failures, it interrupts those sessions before
stopping sandboxes with proven exclusive ownership. It does not kill unrelated
or previous-run sandboxes at startup. A session that is already in its desired
end state counts as cleaned, not as a failure: the shared scenarios clean up in
their own `finally`, so the runner cleanup is an idempotent backstop. A genuine
cleanup failure still stops the matrix instead of allowing pending work to
contaminate later scenarios. Kill scenarios inject
their intentional fault before interruption, then cancel remaining work during
cleanup.

Tracking requires a returned session ID. If unified `start` allocates ownership
but fails before returning that ID, the driver cannot automatically cancel it.
Use the failed run's user ID and ownership logs to identify and interrupt only
those sessions; do not infer ownership from container creation time.

Per-run overrides via env vars. Defaults assume a zero-offset session;
for any other offset, compute the real ports from `pnpm dev:status --json`
(worker = `8794 + portOffset`, fake-LLM = `8811 + portOffset`):

| Var | Default |
|---|---|
| `WORKER_URL` | `http://localhost:8794` |
| `FAKE_LLM_URL` | `http://localhost:8811` (host-side view) |
| `E2E_GIT_URL` | `https://github.com/octocat/Hello-World.git` |
| `E2E_GITHUB_REPO` | unset. When set (`owner/repo`), start uses GitHub-app clone instead of `gitUrl`. Pair with `E2E_USER_EMAIL` for the seeded installation. |
| `E2E_USER_EMAIL` | unset (ephemeral `usr_e2e_*`). Set to the cloud-worktree-setup email to reuse that user and its GitHub integration. |
| `E2E_BRANCH` | unset. Optional checkout ref (`upstreamBranch` / `repository.branch`). |
| `E2E_MODEL` | `kilo/fake-deterministic` (the only model the fake serves) |
| `E2E_INTERNAL_API_SECRET` | unset. Required in the launcher shell for the local HTTP e2e profile (`cloud-agent-next-http`): the render command writes it into the generated `.wrangler/.dev.vars` as the Worker's `INTERNAL_API_SECRET`. The shared rules (`requireE2eInternalSecret`) reject the development default, values shorter than 16 characters, and whitespace; the renderer additionally rejects values outside `[A-Za-z0-9._~-]`, because only it writes a dotenv line. Must differ from production's `INTERNAL_API_SECRET`. The local-HTTP driver resolves it like the deployed driver — the exported value or the auth file's `e2eInternalApiSecret` — so both ends must agree. |
| `DATABASE_URL` | Optional direct database URL override for this harness |
| `POSTGRES_URL` | Repo database fallback loaded from root `.env.local` / `.env` |

If `DATABASE_URL` is unset, the standalone TSX driver loads root `.env.local`
and `.env`, then falls back to `@kilocode/db` `computeDatabaseUrl()`, which
uses `POSTGRES_URL` for local development.

`FAKE_LLM_URL` is how the **driver** reaches the fake server (for
`/test/release`, `/test/gate-status`, `/test/waiters`, and `/test/requests`
side channels). `KILO_OPENROUTER_BASE` stays on Next.js; the gateway routes
`fake-deterministic` to fake-llm. If you changed the fake's port (e.g.
non-zero `portOffset`), set `FAKE_LLM_URL` to the matching host-reachable
view. Next.js picks up the same offset from
`apps/web/.env.development.local`.

The local HTTP e2e profile (`cloud-agent-next-http`) also requires
`E2E_INTERNAL_API_SECRET` exported in the shell that launches it: the renderer
reads `process.env.E2E_INTERNAL_API_SECRET` and writes it into the generated
`.wrangler/.dev.vars`, which becomes the Worker's `INTERNAL_API_SECRET`. The
local-HTTP driver calls the same `bootstrapDeployedProfile()` as the deployed
profile, so it accepts the exported value or an `E2E_AUTH_FILE` whose
`e2eInternalApiSecret` field supplies it; both ends must resolve to the same
value. The value is never written into the service command string, because tmux
mirrors those into `dev/logs/*`. Do not rotate the secret by restarting the
service: `restartServiceInTmux` reuses the pane environment, and the CLI
tunnel-restart path reloads `cloud-agent-next` rather than the HTTP variant. Stop
the HTTP group and start a fresh launcher session with
`E2E_INTERNAL_API_SECRET` exported (the same value the driver uses), and never
type the secret into a logged pane command.

## Deployed profile (`E2E_PROFILE=deployed`)

The deployed profile drives a real deployed Cloudflare stack instead of the
local Docker harness. See [`deploy/README.md`](./deploy/README.md) for the full
deploy reference.

Two Workers, in deploy order:

1. `fake-llm-e2e-test` — Worker + `FakeLlmState` Durable Object running the
   shared `fake-llm-core.ts`; deploy first with
   `test/e2e/deploy/deploy-fake-llm.sh deploy`.
2. `cloud-agent-next-e2e-test` — private render of this package's Worker;
   deploy second with
   `E2E_USER_ID=<id> FAKE_LLM_BASE_URL=<base> test/e2e/deploy/deploy-e2e-worker.sh deploy`.
   Add `E2E_INTERNAL_API_SECRET=<secret>` on the first deploy or to rotate it; a
   redeploy without it keeps the deployed Worker secret.

The fake Worker's state model: one Durable Object (`new_sqlite_classes`,
migration `v1`). Open streams cannot survive Durable Object eviction, so
`gate`/`hang` directives are unsupported on the deployed profile. The
`/test/*` scenario counters persist per tag, and the persisted snapshot retains
the newest 200 tags by insertion order, evicting the oldest first — a reused
tag that is never re-inserted can be evicted and restart its counters at zero.

Two different fake URL bases — do not conflate them:

- The deploy script prints
  `FAKE_LLM_BASE_URL=https://<fake-host>/api/openrouter`. That value is for the
  e2e Worker's provider config (`KILO_OPENROUTER_BASE`); pass it to
  `deploy-e2e-worker.sh`.
- The driver's `FAKE_LLM_URL` must be the fake Worker ROOT
  `https://<fake-host>` with **no** `/api/openrouter`, because the scenarios call
  `/test/requests` (and the other `/test/*` side channels) on it. Do not reuse
  the `/api/openrouter` provider base as `FAKE_LLM_URL`.

Driver env: `E2E_PROFILE=deployed`, `WORKER_URL`,
`E2E_BACKEND_URL=https://api.kilo.ai`, `FAKE_LLM_URL`, and a user token from
either `E2E_USER_TOKEN` or `E2E_AUTH_FILE`; optional `E2E_MODEL` (default
`kilo/fake-deterministic`) and `E2E_GIT_URL`. `E2E_USER_TOKEN`, when set and
non-empty, is an ordinary personal Kilo API token presented verbatim; it needs
no separate `userId` or `email`. Otherwise `E2E_AUTH_FILE` must name a mode-600
JSON file carrying the `token` field. When neither supplies a token the run fails
and names both variables. An empty value counts as unset; a whitespace-padded
value is present but rejected, never trimmed.

The admin
bearer for every `/test/*` side channel resolves in order: `FAKE_LLM_ADMIN_TOKEN`
when it is set and non-empty, else the `fakeLlmAdminToken` field of the auth file
named by `E2E_AUTH_FILE`, else a failure naming both options. The resolved value
must be non-empty, must not have leading/trailing whitespace, must not be the
insecure development default `local-fake-llm-admin`, and is never printed. The
deployed bootstrap exports the resolved value into `FAKE_LLM_ADMIN_TOKEN` for the
run, so `releaseGate`, `fetchFakeWaiters`, `fetchFakeRequests`,
`fetchFakeScenarioStatus` and `waitForGateEngaged` authenticate with no extra
configuration; precedence is env then auth file. The deployed profile reads the
auth file at most once and only when a source needs it: never when `E2E_USER_TOKEN`
and `FAKE_LLM_ADMIN_TOKEN` are both set. The
deployed profile never reads `.dev.vars`, root env files, or Postgres, and never
mints valid authentication credentials or stream tickets.
The `auth-reject` negative probe deliberately signs one **invalid** JWT
(wrong secret); it is used only for that bad-signature probe and is never
presented as a valid credential.

The auth file, named by the optional `E2E_AUTH_FILE`, is JSON
`{ "token", "userId"?, "email"?, "fakeLlmAdminToken"? }` in a mode-600 file:
`token` is required, `userId` is optional (when present it must equal the
`kiloUserId` decoded from the token; when omitted it is derived from it), and
`email` is optional (an omitted value yields no email). The file carries the Kilo
identity and the fake-llm admin bearer as one alternative to `E2E_USER_TOKEN` and
`FAKE_LLM_ADMIN_TOKEN`. The token must be an **ordinary
personal Kilo API token** (the `generateApiToken` family), obtained from the
user's personal API key or CLI token flow.
Session/control tokens, organization tokens, and delegated/runtime tokens are
refused with a diagnostic: they take the runtime-authorization path, and
admission then fails with `Model catalog authentication unavailable`. The token
is never printed.

Exact run command, from `services/cloud-agent-next`:

```bash
E2E_PROFILE=deployed pnpm exec tsx test/e2e/run.ts cold-hot echo:hi
```

Shared scenarios run under both profiles from one implementation
(`scenarios-shared.ts`). Capabilities a scenario needs but a profile does not
provide make it `unsupported`: the run reports `ok: false, unsupported: true`
with the missing capability names, and it never runs with the assertion
dropped. `auth-reject` requires `deployedHttpAuthBoundary`, so it is
`unsupported` under the local profile; `cold-hot` and `unknown-model` need no
declared capability and run under both, while container identity stays a
local-only assertion. The four public-surface scenarios (`worktree-chat`,
`worktree-multi-chat`, `long-conversation`, `leave-and-return`) declare
`sessionSandbox`, which the local profile and the deployed HTTP profile both
provide through the e2e surface; they run under both from one definition.

Scenario matrix:

| Shared scenario | What it does |
|---|---|
| `cold-hot <directive>` | One cold turn plus `echo:hot`, `slow:3:50`, `echo:followup` hot turns on one session. Requires positive cold preparation evidence and per-message hot completion evidence, and rejects any hot-turn preparation event. For an `echo:<token>` directive it also asserts the correlated cold text: assistant messages whose `info.parentID` is the cold user message id, their `text` parts selected by `part.messageID`, latest snapshot per part id, joined equals `<token>`. Non-echo directives skip that assertion (`cold-content=skipped(not-echo:<token>)`). Default `240s` per turn. Under the local profile it also proves the cold container persists and no new container appears. |
| `unknown-model` | Starts with `kilo/does-not-exist`; requires fail-closed admission (`Selected model is not available`) with no fake chat completion dispatched. Under the local profile it also confirms on a short delay that no sandbox appeared. |
| `auth-reject _` | Starts no session. Probes the fake Worker directly over HTTPS (every request timeout-bounded): each model route with no bearer → 401; `Bearer not-a-jwt` → 401; a JWT signed with the wrong secret → 401; positive control `GET /api/openrouter/models` with the real `config.bearerToken` → 200; each `/test/*` route without the admin bearer → 401 and with it → 2xx/400/404; crossover both ways (admin bearer on a model route → 401, model token on `/test/*` → 401). It proves the public HTTP auth boundary only: no sandbox credential propagation and no session path. |
| `worktree-chat _` | Creates a worktree chat through the public tRPC surface. Requires the worktree id to correspond to the workspace identity (`workspace_<uuid>` → `worktree_<uuid>`), the session's own scope id, `parentSessionId` null and `autoCommit=false`, then a cold echo boot turn, an idempotent same-key replay (same identities, `replayed=true`), and one hot echo turn with no reported preparation, matching allocation references observed before and after the turn through the capability's bounded present-reference wait, and correlated content. The boot allocation reference is acquired **after** the boot turn completes through that bounded wait with a `240 s` budget, so the wait starts only after the boot turn has completed, not while the sandbox is still cold; the hot-turn read uses the same bounded wait (`waitForPresentAllocation`) with a `30 s` cap plus a `1 s` outer backstop slack, tolerates a transient `null` observation, and hard-fails only when no reference appears within the budget. It proves matching observed references before and after each turn, not uninterrupted presence between observations. It runs under the local Docker and deployed HTTP profiles from one definition and does not restate the local-only `worktree-shared` physical claims. |
| `worktree-multi-chat _` | Boots a root chat, then starts a paced `slow:90:1000:32` turn and waits (budget `60 s`) until that turn is underway: correlated-part liveness for the paced message (transient and empty initialization parts permitted) plus a bounded increase in the fake's aggregate `chatCompletions` counter. The counter is **not** an authoritative paced-request signal: it is attributed to the paced request only under the documented assumption that no auxiliary/title request is in flight in that window, and it cannot distinguish the paced primary request from an auxiliary one. A content-based predicate (correlated non-empty text) was tried and reverted: the paced child's only correlated part can be the empty transient init part, and its streamed content can lag past the wait budget, so the predicate never fired even though the fake had served the request. The laziness baseline is taken only after readiness. It then creates a sibling chat while the turn is still streaming. Requires the root still `queued`/`running` immediately after the create and completing afterwards, the sibling to share one non-null `worktreeId` and `sandboxId` while keeping a distinct workspace/`ses_` identity and its own scope, `chatCompletions` unchanged over a 15 s window (lazy create) and over a same-key replay, the sibling's first turn to report its own `preparing`, and interleaved root-second and sibling-second turns. Chat-content isolation scans each chat's `cloud.message.*` stream and a fresh replay stream for the other chat's message ids and, without the `parentID` filter, the other chat's markers. It does not prove targeted cancel; that stays local-only (`worktree-shared`). |
| `long-conversation [echo:cold]` | One cold `echo:cold` turn plus ten hot turns (nine `echo:<token>` turns and one paced `slow:2:50` turn). Requires the cold turn to complete with a reported preparation and its correlated content, every hot turn to complete without a reported preparation and with matching allocation references observed before and after through the bounded present-reference wait (not uninterrupted presence between observations), and each `echo:` turn's correlated content. Measured behaviour, not history restoration. |
| `leave-and-return _` | Boots, completes a boot echo turn, then leaves the session with no demand. Samples the allocation reference targeting +60 s (must still be the baseline `P1`); the baseline read is the bounded present-reference wait, so it may take up to `30 s` to obtain a present reference and its measured timestamp can be later than +60 s. Then every 15 s for up to a 15-minute budget; it fails closed while `P1` remains and if a different non-null reference appears, and stops once the reference is absent. On resume it requires a reported preparation, a different non-null reference `P2`, a completed turn with its echo marker and — from a fresh replay stream — the boot turn's replayed correlated content. It never names a stop cause: a `null` reference is reported as "the allocation disappeared while unattended", not as a release. |

Run artifact for `cold-hot`: capture the fake `/test/requests`
`chatCompletions` count before and after the run and expect **at least 4 new
completions** across the run (one cold turn plus three hot turns). Record that
delta with the scenario's
`session=workspace_<uuid>; cold=complete; cold-content="<token>"; hot=...` line
and the deployment id from `wrangler deployments list`.

### Public-surface-only evidence

The four shared scenarios above reach the Worker only through `client.ts` tRPC
helpers, WebSocket streams, the fake `/test/*` surface and the `sessionSandbox`
capability. They inspect no Docker files or processes, no worker logs and no
Postgres/`@kilocode/db`, and they call no auth helper directly. Authentication
is profile-specific: the deployed/HTTP path mints no token, while the local
Docker profile authenticates through the same local `mintApiToken` seam as every
other local scenario (`client.ts` → `auth.ts`). The acknowledged transitive
`client.ts → auth.ts → @kilocode/db` import exists, but no new scenario path
uses it.

Honest limits, recorded deliberately:

- `fetchFakeRequests` is a global counter on a shared fake, so the lazy-create
  evidence holds only while no other run is dispatching. In `worktree-multi-chat`
  a bounded increase in that same counter is the paced-readiness gate; it is
  **not** an authoritative paced-request signal. It is attributed to the paced
  request only under the assumption that no auxiliary/title request is in flight
  in that window, and the fake's aggregate `/test/requests` surface cannot
  distinguish the paced primary request from an auxiliary one.
- `worktree-multi-chat` paced readiness is **correlated-part liveness for the
  paced message** (transient and empty initialization parts permitted) **plus a
  bounded increase in the aggregate `chatCompletions` counter**, budget `60 s`.
  This proves the turn is live and that some request was dialed; it does not
  prove the increase was the paced primary request. A stronger content predicate
  (correlated **non-empty text**) was tried and reverted: live runs showed the
  paced child with `children=1 parts=9 correlated=2 text=1 nonEmptyText=0` (only
  the empty transient init part) while the fake had already served the paced
  request, so the predicate never fired and the counter check was never
  consulted.
- `physicalProviderRef === null` is not a release proof: a `creating` allocation
  and a local probe error also yield `null`. The leave-and-return baseline
  targets +60 s but is acquired through the bounded present-reference wait, so it
  may take up to `30 s` to obtain a present reference and its measured timestamp
  can be later than +60 s; the baseline sample plus "no demand during the
  interval" is what makes the absence meaningful, and the stop cause is never
  claimed from it. Local absence is a coarse signal.
- A missing preparation event proves the absence of *reported* preparation, not
  the absence of attachment.
- The fresh replay stream proves that the DO's persisted event log still replays
  the boot marker ("replayed transcript preservation"), not sandbox transcript
  or model-context restoration. The collector is removal-aware, so a replay that
  removes the content no longer passes.
- Chat-content isolation is a content check only: it does not prove physical
  isolation or that the two chats share one container.
- Cleanup is clean only for the returned-id path. A create that succeeds
  server-side but loses its response, or is aborted, returns no id and cannot be
  cleaned from that call; operation keys make the create idempotent for retry.

Run artifacts for the new scenarios (local Docker profile):

- `worktree-chat`: `session=workspace_<uuid>; ses=ses_...; worktreeId=worktree_<uuid> (matches workspace identity); scope=self; autoCommit=false; allocationRef=<R>; initial=<marker>; hot=no-preparing; hotAllocationRef=<R> (read); replay=idempotent`
- `worktree-multi-chat`: `root=...; sibling=...; worktree=<worktree_...>; sandboxId=<ses-...>; scope=distinct; rootNonterminalAfterSiblingCreate=true; lazyChatCompletions=<before>-><after> (unchanged over <interval>); replay=idempotent; siblingPreparing=true; interleaved=root-second+sibling-second complete; chatContentIsolation=true (no other-chat ids or markers in either chat's streams/replay)`
- `long-conversation`: `cold=prepare; hot=10/10 complete; no-preparing=true; allocationRef stable=<R> (read each turn)`
- `leave-and-return`: `session=workspace_<uuid>; providerRef=<P1>; baselineSample=<P1>@t=<ms>; absentSample=null@t=<ms>; samples=<n>:<ref>@t=<ms>|<ref>@t=<ms>|...; resumePreparing=true; replacement=<P2>!=<P1>; replayedTranscript=<bootMessageId>:<marker>; stopCause=not-read` (every poll sample is reported with its elapsed time, all measured from one interval origin)

### Deployed matrix runner

```bash
pnpm --filter cloud-agent-next run e2e:deployed
```

`smoke-deployed.ts` runs every entry in `SHARED_SCENARIOS` through the shared
gate against a deployed Worker, passing each scenario's `defaultConversation`
and `defaultTimeoutMs` under the unified API. It needs no local Docker daemon and
never reads `.dev.vars`, root env files, or Postgres. It is a separate runner,
not a profile switch in `smoke.ts`: the local matrix inserts a Postgres user,
loads `.dev.vars`, and stops Docker sandboxes.

Each scenario owns its own cleanup. The runner tracks session ids through
`onSessionCreated` and, after each scenario, repeats `interruptSession` and
`deleteSession` as a tolerant backstop; a backstop failure is logged, never
thrown, so one stuck session cannot hide the remaining scenarios.

The summary reports passed / failed / unsupported as distinct categories.
Exit policy: `1` if any scenario failed, else `2` if any was unsupported, else
`0`. An `unsupported` result also has `ok: false`, so failure means
`!ok && !unsupported`. The unsupported lines name the missing capabilities.

The `e2e-deployed` GitHub workflow (`.github/workflows/e2e-deployed.yml`) is a
`workflow_dispatch`-only runner around this script. It maps the `worker_url`,
`fake_llm_url` and `backend_url` inputs to `WORKER_URL`, `FAKE_LLM_URL` and
`E2E_BACKEND_URL`, passes `E2E_USER_TOKEN` and `FAKE_LLM_ADMIN_TOKEN` only as
environment variables, tees the log, uploads it, and writes the counts plus the
unsupported scenarios and missing capabilities to the job summary even when the
runner fails.

Accepted production-coupling risk (repeated from `deploy/README.md`): dedicated
Worker names keep the stack addressable separately from production; they do
**not** isolate its resources. The e2e Worker render clones the production
bindings — the production Hyperdrive/Postgres database, the `kilocode-sessions`
R2 bucket, and production service bindings — and its endpoints are public with
valid-token admission only, with no per-user isolation.

Docker scope boundary: deploying the fake Worker needs no Docker (it is a Worker
and a Durable Object, not a container image); deploying the Cloud Agent e2e
Worker still needs Docker for its sandbox container images; running the deployed
driver needs no local Docker daemon.

The deployed profile's `auth-reject` scenario is the only deployed negative
auth proof. It does not exercise a sandbox, so it cannot show that credentials
reached the fake from inside a session.

Every other shared scenario is local-only because it needs Docker-backed
inspection/control (the four public-surface scenarios above are the exceptions
and run under both). Long `gate`/`hang` directives are outside the supported
deployed profile (short streams only), and none of the four new scenarios uses
a gate, `hang` or interrupt.

The deployed profile does **not** send `x-skip-balance-check`: the enrolled user
must have positive balance, and a 403 at `start` means fund the user.

Honest caveat: `cold-hot` proves the warm dispatch path, not physical
container identity. The absence of hot-turn preparation events is not proof that
the same container served the turns; identity stays a local-only assertion.

The four new scenarios' deployed statements are inference, not proof: the
deployed matrix was not run for this change. They add four entries to the
deployed matrix; `timeout-minutes: 120` in `.github/workflows/e2e-deployed.yml`
is a reasonable operational ceiling (the four new scenario ceilings alone are
10 + 12 + 12 + 30 minutes plus cleanup and transport), not a certified
whole-matrix bound. Their `sessionSandbox` capability over HTTP reports the
persisted control-plane allocation reference, so "the same container" is
allocation-reference stability, not a live runtime observation, and the HTTP
surface cannot enumerate containers.

Cleanup and retained artifacts: cleanup against the e2e Worker runs first —
`interruptSession` and `deleteSession`, each attempted independently and bounded
by an abort timeout. The public `deleteSession` does not delete live
`cli_sessions_v2` rows, so one retained row per started session survives for the
enrolled user. The user-runnable web `cliSessionsV2.delete` flow (which targets
the PRODUCTION Worker) is the later cleanup for those rows, not a fallback for
failed e2e cleanup.

Troubleshooting:

- **Token refused with a policy diagnostic** — use an ordinary personal token;
  the auth-file rule above lists the rejected families.
- **Missing user token** — set `E2E_USER_TOKEN`, or set `E2E_AUTH_FILE` to a
  mode-600 JSON file with a `token` field; the failure names both.
- **`WORKER_URL`/`FAKE_LLM_URL`/`E2E_BACKEND_URL` must be `https://`** — the
  deployed profile refuses plain HTTP.
- **403 at `start`** — fund the enrolled user; the deployed profile does not
  bypass balance admission.
- **Container cold-start timeout** — `cold-hot` defaults to 240s per
  turn; a first real container boot can exceed two minutes.
- **Fake Worker `/health`** — `curl https://fake-llm-e2e-test.<sub>.workers.dev/health`
  confirms the container Worker is up.

## Gateway contract

The fake gateway serves the Kilo routes used in this harness:

- `GET /api/openrouter/models` - runtime model discovery inside sandboxed kilo.
- `POST /api/openrouter/models/validate` - Worker-side fail-fast model validation.
- `POST /api/openrouter/chat/completions` - deterministic streamed completion scenarios.

### SDK coverage boundary

`sdk-basic-chat.ts` intentionally avoids timing-sensitive assertions already
covered by focused unit or Workers-runtime fixtures: multi-root mapping
ordering and zero-DO list projection, R2 replacement races, private-path
optional fixture variants, and SSE heartbeat/comment parsing. The normal acceptance
scenario asserts that blocking `prompt()` remains intentionally unsupported;
chat admission and wake-up are tested exclusively through `promptAsync()`.

## Conversation directives

A conversation directive is embedded in the user-visible prompt as
`__fake__:<scenario>[:<arg1>[:<arg2>...]]`. The fake LLM gateway parses it
from the last user message and dispatches the matching scenario. The
source of directive truth is `test/e2e/fake-llm-core.ts`, shared by the local
Node server (`fake-llm-server.ts`) and the deployed Worker + Durable Object
(`fake-llm-worker.ts`).

| Directive | Behavior |
|---|---|
| *(no `__fake__:` directive)* | Echo the last user message after stripping kilo `<environment_details>`. |
| `slow:<n>:<ms>` | `n` content chunks `<ms>` apart, then stop + `[DONE]`. Used for pacing/timing probes. |
| `realistic:<text>` | Role delta, 3 deterministic reasoning deltas, then content deltas with whitespace separators as their own deltas, then stop + [DONE] with usage; text is capped at 4000 characters and 512 pieces to emulate a real provider stream. |
| `idle` | One empty-delta chunk, then stop + `[DONE]`. |
| `hang` | Opens the SSE stream but emits nothing and never closes. Drives abort/timeout paths. |
| `error-terminal:<msg>` | HTTP 400 with OpenAI-shaped error body carrying `<msg>`. Exercises nonretryable provider-error propagation through the gateway. |
| `error:<msg>` | HTTP 402 with OpenAI-shaped error body carrying `<msg>`. The non-BYOK gateway converts this to retryable HTTP 503. |
| `gate:<tag>` | Opens the SSE stream, emits no chunks, blocks until the driver calls `POST /test/release?tag=<tag>`. On release, emits `"done"` + stop + `[DONE]`. |
| `read-then-write:<tag>:<srcPath>:<destPath>:<prefix>` | Issues a real `read` for `srcPath`, then writes `prefix` plus a newline plus the cleaned read body to `destPath`, and gates until release. The prefix may contain colons; line-number wrappers and prompt context are removed from the carried body. |

Unknown `__fake__:<name>` directives produce HTTP 402 with
`unknown fake scenario: <name>` — easy to spot in fake-LLM logs.
A prompt with no `__fake__:` prefix echoes instead.

### Side channels

The fake LLM server exposes four helper endpoints for driver code (not used
by kilo). Every one of them requires `Authorization: Bearer <admin token>`,
where the token is `FAKE_LLM_ADMIN_TOKEN` or, for a zero-config local stack,
the insecure development default `local-fake-llm-admin`:

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
`fetchFakeWaiters()`, and `fetchFakeRequests()` in `client.ts`, which attach the
bearer from `fakeControlHeaders()` in the same module. The token comes from
`resolveFakeAdminToken()` in `fake-llm-admin.ts` — the same resolver the local
Node server uses — so a non-default `FAKE_LLM_ADMIN_TOKEN` reaches both ends
without further configuration. Set it when the fake is reachable beyond
localhost: the fake binds `0.0.0.0`, and the public tunnel refuses to publish
the development default. The deployed Worker requires the token as a Worker
secret; see `deploy/README.md`.

## Lifecycle scenarios

For the session-continuity contract (long-lived, recoverable chats) and the
reusable catalog of planned and existing scenarios, see
[`SESSION-CONTINUITY.md`](./SESSION-CONTINUITY.md).

| Lifecycle | What it does |
|---|---|
| `cold` | Fresh session; verify a new per-session sandbox appears and the conversation completes. |
| `hot` | Warmup with `echo:warmup`, then send the real prompt on the same session. Same container. |
| `followup` | Same as `hot` today; kept distinct for future resume-path splits. |
| `cold-hot` | One cold turn plus `echo:hot`, `slow:3:50`, and `echo:followup` hot turns on the same session/sandbox. |
| `worktree-shared` | Creates a new worktree and a sibling chat; verifies idempotent creation, a shared dirty checkout, and chat isolation. Requires both `CONTROL_PLANE_IDS` and `WORKTREE_CREATION_ENABLED_IDS` enrollment and `--api=unified`; pass `_` as the conversation placeholder. |
| `long-session` | Runs 11 sequential real file turns (writes plus read/edit turns) in one sandbox, asserting exact dirty file state and this root's checkpoint identity after every turn. Requires the seeded enrolled user and `kilo/fake-deterministic`. |
| `cold-resume` | Waits for the control plane's automatic idle stop, then resumes the same session on a new container and asserts two-sided history preservation and a stable Git HEAD before releasing a gate-only turn; dirty-file survival is recorded as a non-gating observation. Requires the seeded enrolled user and `kilo/fake-deterministic`. |
| `multi-session-collab` | Runs planner, implementer, and reviewer chats serially in one worktree; each real file artifact carries the previous token and all three files are asserted on disk. Requires the seeded enrolled user and `kilo/fake-deterministic`. |
| `recover-same-session` | Captures the target connection by `sandboxId` plus connection/wrapper ids, pauses the owned primary wrapper (`docker pause`), requires a matched `deadline_fired deadlineId=heartbeatExpiry` followed by a matched `recovery_outcome cause=heartbeat_expired outcome=started` before any recovery send, then completes a new ordered-lifecycle message on the original `workspace_*` session. A `control_disconnected` started outcome is reported as generic same-session recovery, not heartbeat coverage. Requires control-plane/worktree enrollment. |
| `interrupt-then-continue` | Interrupts a gated turn, asserts `cloud.message.failed reason=interrupted`, then completes a follow-up on the same session in the same container. |
| `warm-cold-cycles` | Runs two work -> automatic idle-stop -> resume -> work cycles with independent idle-stop evidence, old-primary absence, distinct replacement container, pre-idle history, and a completed ordered-lifecycle follow-up per cycle. Each cycle records its resumed message id and dirty-file survival; completed cycles are retained if a later cycle fails. |
| `question-idle-resume` | Sends a real `question:<tag>:<text>` and leaves it unanswered; requires a positive scoped pending-question observation while the primary is inspectable (inspection failure is inconclusive) and automatic idle-stop within the idle budget, then requires the parked message to be terminal (`failed`/`interrupted`) before continuing. The exact-match target heartbeat `waitingOn=input` is the input-wait proof and may be absent once the parked message is terminal. Continues on a replacement container. |
| `large-stream` | Runs a 256 KiB `tool-stream:<tag>:<bytes>` turn plus a paced `slow:20:50:32` follow-up; claims large-stream coverage only for the exact completed read call whose streamed part is correlated and whose persisted output meets the request, otherwise records requested vs observed vs written bytes. |
| `concurrent-chats` | Boots three independent sessions, parks one gated turn in each with proven overlapping `running`, classifies each `completed_clean`/`completed_after_recovery`/`wedged`/`failed` from matched recovery evidence, and requires a completed same-chat follow-up for any turn that did not complete. |
| `external-kill` | Warmup, `docker kill` the sandbox, send another prompt, verify recovery/failure. |
| `kill-mid-flight` | Cold `hang`, kill while pending, verify DO surfaces disconnect/error. |
| `queue-while-busy` | Block on `gate:<tag>`, enqueue two echoes, release the gate, assert FIFO delivery through `cloud.message.*` events. |
| `queue-rapid-fire-no-gate` | Send immediate follow-ups behind `echo:first` and assert they reach their terminal FIFO state without gate coordination. |
| `queue-overflow` | Block on `gate:overflow`, fill the pending queue until enqueue fails with HTTP 429, release gate, drain. |
| `queue-interrupt-clears` | Block on `gate:<tag>`, enqueue two, `interruptSession`, assert `cloud.message.failed` with `reason: 'interrupted'` for each. |
| `llm-error` | Return fake provider HTTP 402 (terminal credit-exhaustion classification), assert `cloud.message.failed` with `status: 'failed'` and no retry status, assert `interruptSession` is a no-op on the settled message (`failed` stays durable, no `reason=interrupted`), then assert a completed follow-up on the same session and container. |
| `chunked-streaming` | Stream delayed fake chunks and assert multiple downstream `message.part.delta` events survive. |
| `empty-response` | Run `idle`, assert completion, and assert no downstream `message.part.delta` is emitted. |
| `interrupt-mid-stream` | Interrupt an actively gated fake request and assert the active message is interrupted, not a queued message. |
| `unknown-model` | Use a model rejected by the fake validation route and require synchronous rejection before sandbox creation or fake chat dispatch. |
| `waiters-clean` | Complete a normal fake turn, then assert the fake server has no parked waiters or live responses. |
| `callback-completion` | Open the profile's callback sink, register `callbackTarget.url`, run `echo:done`, assert the sink received `status: 'completed'`. |
| `callback-batch-followup` | Queue two turns behind a gated callback session, assert one callback for the final queued turn, then assert a later hot turn emits a fresh callback and no extra one after the batch settles. |
| `callback-interrupt` | Gated active turn + `interruptSession`, assert callback fires with `status: 'interrupted'`. |

The three callback scenarios are shared definitions. Their `callbacks` capability
is provided by the profile: a host HTTP sink under local Docker, and the e2e
surface sink (`POST /__e2e/callbacks`, `GET`/`DELETE /__e2e/callbacks/:token`)
over HTTP, where the Worker self-fetches the minted URL.

### e2e surface auth (HTTP profiles)

The `/__e2e/*` surface is mounted only on the e2e entrypoint. Every route needs
**both** the e2e-scoped `INTERNAL_API_SECRET`, presented as `x-internal-api-key`
and compared in constant time, and a valid Kilo JWT. The secret gate runs first,
so an absent or wrong secret is rejected before JWT verification and before any
Hyperdrive dereference.

`POST /__e2e/callbacks/:token` is the single exemption from both gates: callback
delivery sends no Kilo credential, so ingest authenticates with its unguessable
path token. Mint (`POST /__e2e/callbacks`), read/delete (`GET`/`DELETE
/__e2e/callbacks/:token`) and any extra or trailing path segment stay behind both
gates.

Security consequence, recorded honestly. Holding the e2e secret with no JWT lets
a caller replace any sandbox's wrapper credential by id
(`POST /internal/sandbox-control/seed` is secret-only and unowned) and disrupt
another user's running sandbox in the e2e Worker's namespace:
`SandboxControl.setWrapperCredentialHash` overwrites the credential hash and
destroys the runtime, readiness and heartbeat state. With a valid JWT plus the
secret, isolation is still partial: session lookups are keyed
`${JWT userId}:${sessionId}`, so user A cannot reach user B's session Durable
Object by naming B's session, and `updateSession` only rewrites callback metadata
inside the selected DO. `cleanupSession` is the exception: it deletes session
resources without the `requireCurrentSessionAccess` check the public
`deleteSession` applies, so the secret plus any valid JWT can trigger cleanup of
an **unowned** session id; seed remains the only no-JWT path.
`E2E_INTERNAL_API_SECRET` must differ from production's value — an operator
requirement the scripts cannot prove.

### API dimension

The harness exercises both tRPC surfaces. Pass `--api=legacy` to drive the
`prepareSession` + `initiateFromKilocodeSessionV2` + `sendMessageV2`
procedures (what the web UI uses today); the default `--api=unified` uses
the newer `start` / `send` procedures. `prepareSession` requires
`INTERNAL_API_SECRET`: the driver reads it from `.dev.vars` for the Docker
profile and from the resolved e2e secret for the deployed and local-HTTP
profiles, and it always POSTs `/trpc/prepareSession`. The e2e surface has no
prepare adapter; scenarios that pin the legacy flow (the callback scenarios)
select it themselves.

## Troubleshooting

- **Known CLI 7.4.20 stall during snapshot initialization** — Local real-model
  multichat runs have stopped receiving native HTTP responses and global event
  heartbeats after snapshot initialization began, while the Kilo process remained
  alive. Captured container memory was about 1 GB with zero OOM events. The wrapper
  correctly reports `feed_stale` and retires the shared runtime as `kilo_unhealthy`,
  which can fail sibling turns. The underlying native cause is not established;
  snapshot activity is a correlation, not a proven cause. This remains a known
  limitation: keep snapshots and health deadlines unchanged, preserve failed-run
  evidence, and distinguish failed cases from downstream checks that were not run.
- **`Must provide either githubRepo or gitUrl`** — The driver defaults to
  a public HTTPS repo. Override with `E2E_GIT_URL=...` if your network
  blocks GitHub or you prefer a different test repo.
- **`NEXTAUTH_SECRET` not set** — Copy `.dev.vars.example` → `.dev.vars`
  and fill in the local secret (same value used by `apps/web`).
- **`POSTGRES_URL not configured`** — Set root `.env.local` `POSTGRES_URL`,
  or export `DATABASE_URL` to override the database URL for this harness.
- **Sandbox calls out to a real provider** — the session model must be
  `kilo/fake-deterministic`, Next.js must have `FAKE_LLM_URL` set (from
  `pnpm dev:env`), and the `fake-llm` service must be running
  (`pnpm dev:status`). Tail the fake's log (`tail -f dev/logs/fake-llm.log`)
  to confirm kilo is hitting it through the gateway.
- **`waitForGateEngaged` timed out** — kilo never reached the fake LLM. Most
  common cause: the session used a real model, `FAKE_LLM_URL` is missing from
  Next.js, or the fake service is not running. Confirm with
  `curl -s -H "Authorization: Bearer ${FAKE_LLM_ADMIN_TOKEN:-local-fake-llm-admin}" $FAKE_LLM_URL/test/requests`
  (expect a rising `chatCompletions` count as kilo dials the fake) and
  `tail -f dev/logs/fake-llm.log` — a
  stream that stays empty while a turn is "preparing" means the wrapper
  never started, not a fake-LLM problem. A 401 here means the token in your
  shell differs from the one the fake was started with.
- **`/test/*` side channels return 401** — the driver and the fake disagree on
  `FAKE_LLM_ADMIN_TOKEN`. Both read `resolveFakeAdminToken()`; restart the fake
  after changing the variable so the running process and the driver match.
- **`Worker "git-token-service-dev" not found` in `cloud-agent-next.log`** —
  the `GIT_TOKEN_SERVICE` service binding could not resolve. The Worker log
  shows the failure as `Failed to issue Kilo session capability` and the turn
  terminates immediately with `cloud.message.failed`. Cause: the
  `cloudflare-git-token-service` dev process is up on its port but stale and
  not heartbeating into the shared dev-registry (check
  `.wrangler/dev-registry/` for a missing `git-token-service-dev` entry). Fix:
  `pnpm dev:restart cloudflare-git-token-service`, then confirm the entry
  reappears. The fake LLM is irrelevant here — kilo never gets far enough to
  dial it.
- **Matrix fails with `preparing×N` and no terminal** — Correlate the failed
  message with Worker and wrapper logs before classifying the cause. Container
  startup failures happen before wrapper bootstrap; a `post-bootstrap kilo
  session lookup begin` without an end identifies a later native lookup stall.
  Matrix cleanup interrupts its tracked sessions before stopping exclusively
  owned sandboxes. For older runs or an interrupted driver, cancel only the
  recorded run-owned sessions before any owned-family teardown: killing a
  container alone leaves queued work able to recreate it after a Worker restart.
  Preserve the failed result and rerun the scenario in isolation; a successful
  retry does not erase the original failure.
- **`releaseGate` returned 404** — the gate already went away, usually
  because the wrapper's request was aborted (e.g. by an `interruptSession`).
  Queue-interrupt-clears tolerates this; other scenarios treat it as an
  error.
