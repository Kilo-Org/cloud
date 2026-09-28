# Deployed Cloud Agent E2E stack

Two independent Cloudflare Workers in account `e115e769bcdd4c3d66af59d3332cb394`:

| Worker | Role |
|---|---|
| `fake-llm` | Worker + `FakeLlmState` Durable Object that runs the shared `test/e2e/fake-llm-core.ts`. Config: `test/e2e/wrangler.fake-llm.jsonc`. |
| `cloud-agent-e2e-test` | Private render of this package's `wrangler.jsonc` produced by `test/e2e/deploy/render-e2e-worker-config.mjs`. |

The fake-llm Worker is a new, separate Worker with no container and no
`wrangler.jsonc` entry of its own; the e2e Worker is the production config
rendered into a private file. The checked-in `wrangler.jsonc` is never
modified, so the production/default deploy is unaffected.

## Prerequisites

- `pnpm install` at the repo root.
- Cloudflare auth for account `e115e769bcdd4c3d66af59d3332cb394`.
- A fake-llm admin token, exported as `FAKE_LLM_ADMIN_TOKEN` or provided by
  `E2E_AUTH_FILE`, and a user token supplied by `E2E_USER_TOKEN` or
  `E2E_AUTH_FILE` (see [Environment variables](#environment-variables)).
- Docker scope: deploying the fake Worker needs no Docker, because it is a Worker
  and a Durable Object, not a container image. Deploying the Cloud Agent e2e
  Worker still needs Docker for its sandbox container images. Running the
  deployed driver needs no local Docker daemon.
- The account subdomain is assumed to be `engineering-e11` (plan section 11.1).

## Deploy order

The commands below run from `services/cloud-agent-next` (or use the full path from the repo root).

1. Make an admin token available for the fake's `/test/*` side channel and for the
   driver, either by exporting `FAKE_LLM_ADMIN_TOKEN`:

   ```sh
   export FAKE_LLM_ADMIN_TOKEN=$(openssl rand -hex 24)
   ```

   or by pointing `E2E_AUTH_FILE` at the deployed auth file. The resolution order
   is in [Environment variables](#environment-variables).

   Separately, make a user token available for the driver: export
   `E2E_USER_TOKEN`, or put the token in the same auth file's `token` field.

   The script refuses an empty value and refuses the insecure development
   default used by a zero-config local stack.

2. Deploy the fake LLM:

   ```sh
   test/e2e/deploy/deploy-fake-llm.sh dry-run
   test/e2e/deploy/deploy-fake-llm.sh deploy
   ```

   `deploy` runs `wrangler deploy`, uploads `FAKE_LLM_ADMIN_TOKEN` as a Worker
   secret, then checks `/health`, that the JWT-gated model catalogue returns 401
   without a bearer, that `/test/requests` returns 401 without a bearer, and that
   it answers with one.

   Migration prerequisite: `fake-llm` has never been deployed, so the
   checked-in config uses the simple `v1` `new_sqlite_classes` migration. Confirm
   before a first deploy:

   ```sh
   pnpm -C services/cloud-agent-next exec wrangler deployments list --name fake-llm
   ```

   If a remote `FakeLlmContainer` class is found, appending a migration that uses
   `deleted_classes` would destroy old test state and needs explicit user
   authorization before deploy.

3. Copy the `FAKE_LLM_BASE_URL` that the script prints.

4. Render and deploy the e2e Worker:

   ```sh
   E2E_USER_ID=<id> FAKE_LLM_BASE_URL=<base> test/e2e/deploy/deploy-e2e-worker.sh dry-run
   E2E_USER_ID=<id> FAKE_LLM_BASE_URL=<base> test/e2e/deploy/deploy-e2e-worker.sh deploy
   # add E2E_INTERNAL_API_SECRET=<secret> on the first deploy, or to rotate it
   ```

   The deployed test Worker enrolls `E2E_USER_ID` for control-plane and
   worktree-session creation, and it writes to production Postgres and R2; pass
   `*` only as a deliberate opt-in to enrol every authenticated Kilo user.

   `deploy` uploads `E2E_INTERNAL_API_SECRET` as the Worker's
   `INTERNAL_API_SECRET` secret when a source supplies it. `wrangler deploy` never
   clears an existing secret, so a redeploy without one keeps the deployed value and
   only reports that it is doing so. That one value is both the `x-internal-api-key`
   the driver presents to the surface and its direct `/trpc/*` internal key, so
   it must be scoped to `cloud-agent-e2e-test` and **must differ from
   production's `INTERNAL_API_SECRET`**: holding it **plus a valid Kilo JWT**
   lets a caller call internal tRPC procedures, and on its own — no JWT — it is
   enough for the secret-only `/internal/sandbox-control/seed`. Keeping the two
   values different is an operator requirement the script cannot prove — it has
   no access to production's value — so the script only rejects an empty,
   too-short, whitespace-bearing value and the insecure local default.

   Security consequence, recorded honestly. Holding the secret with no JWT lets
   a caller replace any sandbox's wrapper credential by id
   (`POST /internal/sandbox-control/seed` is secret-only and looks the Durable
   Object up by sandbox id with no ownership check) and disrupt another user's
   running sandbox in the e2e Worker's namespace:
   `SandboxControl.setWrapperCredentialHash` overwrites the credential hash and
   destroys the runtime, readiness and heartbeat state. With a valid JWT plus the
   secret, session lookups are still keyed `${JWT userId}:${sessionId}`, so user
   A cannot reach user B's session DO by naming B's session, and `updateSession`
   only rewrites callback metadata inside the selected DO. `cleanupSession` is
   the exception: it deletes session resources without the
   `requireCurrentSessionAccess` check the public `deleteSession` applies, so the
   secret plus any valid JWT can trigger cleanup of an **unowned** session id;
   seed remains the only no-JWT path. The deployed e2e Worker writes to
   production Postgres and R2, so "separate deployment" is not a data boundary.

   The deployed driver resolves the e2e secret with the same order as the
   fake-LLM admin token (`E2E_INTERNAL_API_SECRET` → auth-file
   `e2eInternalApiSecret` → fail naming both), validates it, and exports the
   resolved value into `E2E_INTERNAL_API_SECRET` for the run.

5. Run the driver with the same admin token available (exported
   `FAKE_LLM_ADMIN_TOKEN`, or `E2E_AUTH_FILE`) and a user token (exported
   `E2E_USER_TOKEN`, or the auth file's `token` field). The driver itself, not
   only `deploy-fake-llm.sh`, accepts the auth-file source: it resolves the admin
   bearer with the same order and exports the resolved value into
   `FAKE_LLM_ADMIN_TOKEN` for the run, so the control helpers read it through
   `resolveFakeAdminToken()`; a mismatch shows up as 401s from `/test/*`.

## Environment variables

A deployed run needs two credentials: a user token and a fake-llm admin token.

The user token comes from `E2E_USER_TOKEN` when it is set and non-empty, else from
the `token` field of the JSON file named by `E2E_AUTH_FILE`. When neither supplies
it, the driver fails and names both variables. `E2E_USER_TOKEN` needs no separate
`userId` or `email`: the driver decodes the user id from the token. An empty value
counts as unset; a whitespace-padded value is present but rejected, never trimmed.

`E2E_AUTH_FILE` optionally carries the run's Kilo token, identity, and fake-llm
admin token as one file: JSON
`{ "token", "userId"?, "email"?, "fakeLlmAdminToken"? }` in a mode-600 file.
`token` is required, `userId` is optional (when present it must equal the
`kiloUserId` decoded from the token; when omitted it is derived from it), and
`email` is optional (an omitted value yields no email). Both
`deploy-fake-llm.sh` and the driver resolve the fake-llm admin token in this
order, and the driver exports the resolved value into `FAKE_LLM_ADMIN_TOKEN` for
the run:

1. `FAKE_LLM_ADMIN_TOKEN`, when set and non-empty.
2. Otherwise, the `fakeLlmAdminToken` field of the JSON file named by
   `E2E_AUTH_FILE`, when set and non-empty.
3. Otherwise the script fails and names both options.

`deploy-fake-llm.sh` additionally requires its resolved value to be at least 16
characters and to contain no whitespace (leading, trailing or internal), and
rejects the insecure development default used by a zero-config local stack. The
driver checks only that the value is non-empty, has no leading/trailing
whitespace, and is not that development default. When `deploy-fake-llm.sh` reads
the file, a missing file, unreadable file, invalid JSON, or
missing/non-string/empty `fakeLlmAdminToken` fails with a clear message; the
script never falls back to another token and never prints the token value.

| Name | Required | Meaning |
|---|---|---|
| `E2E_USER_ID` | yes | Required. The Kilo user id enrolled in `CONTROL_PLANE_IDS` and `WORKTREE_CREATION_ENABLED_IDS`. The deployed test Worker writes to production Postgres and R2, so pass `*` only as a deliberate opt-in to enrol every authenticated Kilo user. |
| `E2E_AUTH_FILE` | no | Optional mode-600 JSON file for a deployed run: `{ token, userId?, email?, fakeLlmAdminToken?, e2eInternalApiSecret? }`. Supplies the user token when `E2E_USER_TOKEN` is unset or empty, and the identity (`userId` derived from the token when omitted; `email` optional). `deploy-fake-llm.sh` reads its `fakeLlmAdminToken` field when `FAKE_LLM_ADMIN_TOKEN` is unset or empty; `deploy-e2e-worker.sh` and the deployed driver read its `e2eInternalApiSecret` field when `E2E_INTERNAL_API_SECRET` is unset or empty. |
| `E2E_USER_TOKEN` | no | An ordinary personal Kilo API token for the driver, presented verbatim. Takes precedence over the auth file's `token` field and needs no separate `userId`/`email`. Not read by `deploy-fake-llm.sh`. |
| `E2E_INTERNAL_API_SECRET` | required for the deployed driver; optional for deploy | Value uploaded as the `cloud-agent-e2e-test` Worker's `INTERNAL_API_SECRET` secret when a source supplies it, and always presented by the driver as both the surface key and the internal tRPC key. Needed for the first deploy or a rotation; a redeploy without it keeps the deployed value. When unset or empty, both `deploy-e2e-worker.sh` and the deployed driver resolve it from the `E2E_AUTH_FILE`'s `e2eInternalApiSecret` field. The shared `requireE2eInternalSecret` rules require at least 16 characters, no whitespace, and not the development default; the dotenv alphabet `[A-Za-z0-9._~-]` is a local-renderer concern only, so a base64 value is accepted here. Must differ from production's `INTERNAL_API_SECRET` (an operator requirement the scripts cannot prove). |
| `FAKE_LLM_BASE_URL` | yes | Must be `https://<fake-host>/api/openrouter`. |
| `FAKE_LLM_ADMIN_TOKEN` | yes | Bearer for the fake's `/test/*` routes. Uploaded as the Worker secret by `deploy-fake-llm.sh` and exported for the driver. When unset or empty, the script resolves it from `E2E_AUTH_FILE`. Never the development default. |
| `WORKER_URL` | no | Default `https://cloud-agent-e2e-test.engineering-e11.workers.dev`. |
| `FAKE_LLM_WORKER_URL` | no | Default `https://fake-llm.engineering-e11.workers.dev`. |

## Authentication model

The deployed fake has two separate credential boundaries:

| Route | Credential |
|---|---|
| `/health` | none |
| `GET /api/openrouter/models`, `POST .../models/validate`, `POST .../chat/completions`, `POST .../audio/transcriptions` | A valid Kilo JWT signed with the `NEXTAUTH_SECRET` Secrets Store binding, carrying `apiTokenPepper`, and carrying none of `aud`, `tokenPurpose`, `credentialExchange`, `runtimeAdmission`, `runtimeAuthorization`, `organizationId`, `organizationRole`. |
| `/test/*` | `Authorization: Bearer $FAKE_LLM_ADMIN_TOKEN` |

The model routes are enforced in the Worker entry; the `/test/*` guard is
enforced inside the shared core, so it behaves identically in the Worker and in
the local Node server. Model-route failures are 401, except a missing or empty
`NEXTAUTH_SECRET`, which is 500. The local Node server deliberately keeps the
model routes open for the Next.js gateway's static credential; only the deployed
Worker authenticates them.

The fake requires the `apiTokenPepper` claim to be **present** and accepts an
explicit `null`. Production rejects an absent claim and then compares it to the
account's stored pepper; a null claim is valid for an account whose
`api_token_pepper` is null. The fake cannot compare the claim to the account's
current pepper without a database, so it is a shape check, not full gateway
semantics.

## What the render changes, and why

| Change | Reason |
|---|---|
| Separate Worker `name` | The e2e Worker is distinct from production. |
| Written to `.wrangler/wrangler.e2e-test.jsonc` | Private, gitignored render. |
| `main` and container `image` paths rebased (`../src/index.ts`, `../Dockerfile*`) | The rendered config lives one directory deeper, in `.wrangler/`. |
| Report-queue producer and consumer removed | The e2e Worker must not produce or consume the production report queue. |
| Callback-queue producer and consumer renamed to `cloud-agent-next-callback-queue-e2e-test` | The e2e Worker can never consume production callback messages. |
| Only the `SandboxSmall` container class kept, `max_instances = 20`, `ssh.enabled = true` | The stack only runs normal `ses-` sessions; `20` is a cap rather than a reservation and leaves parallelism headroom for later parallel runs. Enables SSH inspection. |
| The other container classes removed from `containers`, `durable_objects.bindings` and `migrations` | A container class is all three entries; keeping a binding or migration without its class fails the deploy. Removing them removes unused capacity and deploy cost. |
| Billing flags off (`CLOUD_AGENT_CONTAINER_BILLING_*`) | Matches the dev profile. |
| `CREDENTIAL_CONTAINMENT_ENABLED=false` | Non-contained dispatch; see plan sections 5 and 11.6. |
| `NEXTAUTH_SECRET` Secrets Store binding added | Verifies the ticket and API token, and seals runtime authorization. |
| `SHARED_SANDBOX_OVERRIDES` KV binding pinned to the e2e namespace id | An id-less binding makes wrangler auto-provision the namespace and fail with `code: 10014` because the title already exists. |

### Container classes and removed bindings

The e2e Worker provisions exactly one container class, `SandboxSmall`, with
`max_instances: 20`. The value is an upper cap, not a reservation, and gives
parallelism headroom for later parallel runs. `SandboxSmall` keeps the rendered
`image` and `instance_type`; only `max_instances` and `ssh.enabled` change.

All other container classes (`Sandbox`, `SandboxDIND`, `SandboxCodeReview`,
`SandboxContainment`, `SandboxSmallContainment`, `SandboxCodeReviewContainment`,
`SandboxContainers`)
are removed from `containers`, `durable_objects.bindings` and `migrations`, so
those bindings do not exist on `cloud-agent-e2e-test`. The migration list keeps
each surviving SQLite Durable Object class on its original production tag
(`CloudAgentSession` `v2`, `SandboxSmall` `v3`, `UserKiloFacade` `v5`,
`StreamTicketNonceDO` `v8`, `SandboxControl` `v9`, `SandboxSession` `v10`);
entries whose classes are all removed (`v1`, `v4`, `v6`, `v7`, `v11`) are dropped, and
no surviving tag is renumbered or reordered. The e2e Worker's Durable Object
migration history is **append-only**: once a Worker has been deployed, existing
tags are part of its creation history and cannot be renumbered. To change the
class list for a Worker that has already been deployed, either delete the test
Worker first (which discards its Durable Object state and is a destructive
reset, safe only because the deployment holds disposable test state) or append
a new migration tag — never renumber existing tags. A deploy rejected with
`Cannot apply new-sqlite-class migration to class ... that is already depended
on by existing Durable Objects` is a symptom of a renumbered tag, so a rejected
deploy can require `wrangler delete --name cloud-agent-e2e-test` before the next
attempt.

Every entry of `SHARED_SCENARIOS` (`cold-hot`, `unknown-model`, `auth-reject`
and the public-surface `worktree-chat`, `worktree-multi-chat`,
`long-conversation`, `leave-and-return`) is a normal session. With
`PER_SESSION_SANDBOX_ORG_IDS='*'` they get a `ses-{hash}` sandbox ID
(`src/sandbox-id.ts`), and with `CREDENTIAL_CONTAINMENT_ENABLED='false'` their
metadata has no credential containment, so `getSandboxNamespace` reads
`env.SandboxSmall` — a kept binding. Those scenarios cannot reach a removed
binding. The worktree/worktree-creation flags this needs are already rendered
into the deployed e2e Worker config:
`WORKTREE_CREATION_ENABLED_IDS`/`CONTROL_PLANE_IDS` default to `*`
(`E2E_USER_ID`), so the four new scenarios need no additional render change.

Paths outside this stack now read a missing binding and fail. They are
documented limitations, not supported behaviour:

- Devcontainer / `dind-{hash}` sessions read `env.SandboxDIND`.
- Code-review `crv-{hash}` sessions read `env.SandboxCodeReview`.
- Isolated-standard `istd-{hash}` allocations, and shared `org-`/`usr-`/`bot-`/
  `ubt-` (or legacy `__`) route keys, fall back to `env.Sandbox`.
- Containment requests (`managedScmContainment: true`) for non-devcontainer
  sandboxes read `env.SandboxSmallContainment`, `env.SandboxContainment` or
  `env.SandboxCodeReviewContainment`; `dind-{hash}` still selects
  `env.SandboxDIND` first. New sessions never request containment here, but an
  existing session whose stored metadata already carries containment would take
  this path.

`getSandboxNamespace` returns the undefined binding, so the call that performs
`idFromName` raises instead of silently using another class. The
`CloudAgentSession` checks `!env.Sandbox && !env.SandboxSmall` and
`env.Sandbox || env.SandboxSmall` only test presence; both stay satisfied by the
kept `SandboxSmall` binding.

## Token requirement

The driver must present an ordinary personal Kilo API token from the
`generateApiToken` family, supplied as `E2E_USER_TOKEN` or as the `token` field of
the auth file named by `E2E_AUTH_FILE`. Obtain one from the user's personal API
key in the Kilo web app or the CLI token flow. Never print the token.

Session/control tokens, organization tokens, and delegated/runtime tokens take
the runtime-authorization path. Admission then fails closed with
`Model catalog authentication unavailable`, because the fake catalog URL is
never the official one. Turning containment off is not a remedy. The fake's
model routes also reject those tokens directly, so the failure is visible at the
credential boundary as a 401.

## State model

Only the counters (`nextRequestId`, `chatCompletionRequests`,
`transcriptionRequests`), the short-lived released-gate follow-ups and the
per-tag scenario counters are persisted, in one `FakeLlmState` Durable Object
(`new_sqlite_classes`, migration tag `v1`). Open streams cannot survive a Worker
eviction: a parked `gate`/`hang` is dropped, and its stream ends when the
isolate goes away. The scenario snapshot keeps the newest 200 tags by first-touch
insertion order; the oldest are evicted first, so a tag first touched before the
newest 200 is not persisted and its deployed counters restart at zero when it is
touched again.

## Deploy-safety notes

- `CONTROL_PLANE_IDS` and `WORKTREE_CREATION_ENABLED_IDS` are feature flags,
  not authentication.
- The fake's model routes are public but require a valid Kilo JWT; its `/test/*`
  routes require the admin token. A leaked admin token exposes only the test
  side channel (gate release, counters, scenario status), not billing or
  session data.
- The stack is public test endpoints with capped, not guaranteed, capacity.
  The e2e Worker provisions only the `SandboxSmall` container class with
  `max_instances: 20`; that is a cap, not a reservation, and it gives
  parallelism headroom for later parallel runs. Capacity is not guaranteed.
- There is no per-user admission guarantee and no concurrent-run isolation.
- Capacity is capped but there is no total-spending cap.
- The supported profile is short streams only. `gate`/`hang` directives are
  reachable on the deployed fake (they need a valid model token and, for
  `gate`, an admin-token release), but they are unsupported by the deployed
  profile and are NOT guaranteed to terminate within two minutes or to survive
  an eviction. `sleepAfter` limits sidecar inactivity only.
- Dedicated Worker names keep the stack addressable separately from production;
  they do not isolate its resources. The e2e Worker render clones the production
  bindings: the production Hyperdrive/Postgres database, the `kilocode-sessions`
  R2 bucket, and the production service bindings. The endpoints are public with
  valid-token admission only, and there is no per-user isolation.

## Running the deployed matrix

```bash
pnpm --filter cloud-agent-next run e2e:deployed
```

`e2e:deployed` is the serial reference runner. `smoke-deployed.ts` runs every
entry of `SHARED_SCENARIOS` through the shared gate against the deployed Worker.
A scenario
whose declared capability the deployed environment does not provide is reported
`unsupported` with the missing capability names, never run with the assertion
dropped. The four `sandboxFaults` scenarios (`external-kill`, `kill-mid-flight`,
`wrapper-freeze-settled-reap`, `wrapper-freeze-inflight-reap`) are the expected
deployed gaps: they need local fault injection the deployed profile does not
provide. `auth-reject` is not a gap—the deployed profile supplies the
`deployedHttpAuthBoundary` capability, so it runs there and is instead the local
profile's expected unsupported. The summary separates passed / failed / unsupported, and the exit policy is
`1` if any scenario failed, else `2` if any unsupported is outside the derived
expected set, else `0`; an expected capability gap is a reported skip, not a
failure.

The `workflow_dispatch`-only `Cloud Agent E2E tests` workflow
(`.github/workflows/cloud-agent-e2e-tests.yml`) runs the parallel runner
(`e2e:parallel`) as ONE job with `E2E_PARALLEL=4`; it does not run
`smoke-deployed.ts`. See
[`../README.md`](../README.md#deployed-matrix-runner) for the scenario matrix
and the env contract.

Under the deployed profile the shared gate owns session teardown, so a scenario
that did not previously delete its session now releases its sandbox:
`interruptSession` then `deleteSession`, newest first, with the delete on a 45 s
client budget. That budget bounds the client request, not the container's
destruction.

Aggregate-runtime risk: the four public-surface scenarios have declared
ceilings of 10 + 25 + 12 + 30 minutes, plus cleanup (up to about 2.5 minutes)
and transport overhead. Their budgets mix per-turn and overall timeouts, as the
existing scenarios do (`cold-hot` alone permits four 240 s turn waits), so no
whole-run total is derivable from the registry. The single job's
`timeout-minutes: 180` is a reasonable operational ceiling, not a certified
whole-run bound. None of the four public-surface scenarios uses a `gate` or
`hang`; `worktree-multi-chat` does issue a targeted interrupt of the sibling
chat.

## After a run

Cleanup against the e2e Worker must be finished FIRST. A run retains one
`cli_sessions_v2` row per started session for the enrolled user. The
user-runnable web `cliSessionsV2.delete` flow targets the PRODUCTION Worker and
is used afterwards only for those retained rows; it removes retained
ownership/history rows and is NOT a replacement for failed e2e runtime cleanup.
