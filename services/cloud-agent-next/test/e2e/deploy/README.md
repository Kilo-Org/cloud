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
   ```

   The deployed test Worker enrolls `E2E_USER_ID` for control-plane and
   worktree-session creation, and it writes to production Postgres and R2; pass
   `*` only as a deliberate opt-in to enrol every authenticated Kilo user.

5. Run the driver with the same admin token available (exported
   `FAKE_LLM_ADMIN_TOKEN`, or `E2E_AUTH_FILE`). The driver reads it through
   `resolveFakeAdminToken()`; a mismatch shows up as 401s from `/test/*`.

## Environment variables

`E2E_AUTH_FILE` is the single configuration file for a deployed run: it holds the
Kilo token, the user id, the email, and the fake-llm admin token. The
`deploy-fake-llm.sh` script resolves the fake-llm admin token in this order:

1. `FAKE_LLM_ADMIN_TOKEN`, when set and non-empty.
2. Otherwise, the `fakeLlmAdminToken` field of the JSON file named by
   `E2E_AUTH_FILE`, when set and non-empty.
3. Otherwise the script fails and names both options.

The resolved value must be non-empty, at least 16 characters, contain no
whitespace, and must not be the insecure development default used by a
zero-config local stack. When the script reads the file, a missing file,
unreadable file, invalid JSON, or missing/non-string/empty `fakeLlmAdminToken`
fails with a clear message; the script never falls back to another token and
never prints the token value.

| Name | Required | Meaning |
|---|---|---|
| `E2E_USER_ID` | yes | Required. The Kilo user id enrolled in `CONTROL_PLANE_IDS` and `WORKTREE_CREATION_ENABLED_IDS`. The deployed test Worker writes to production Postgres and R2, so pass `*` only as a deliberate opt-in to enrol every authenticated Kilo user. |
| `E2E_AUTH_FILE` | no | JSON file for a deployed run (Kilo token, user id, email, fake-llm admin token). `deploy-fake-llm.sh` reads its `fakeLlmAdminToken` field when `FAKE_LLM_ADMIN_TOKEN` is unset or empty. |
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
| The other six container classes removed from `containers`, `durable_objects.bindings` and `migrations` | A container class is all three entries; keeping a binding or migration without its class fails the deploy. Removing them removes unused capacity and deploy cost. |
| Billing flags off (`CLOUD_AGENT_CONTAINER_BILLING_*`) | Matches the dev profile. |
| `CREDENTIAL_CONTAINMENT_ENABLED=false` | Non-contained dispatch; see plan sections 5 and 11.6. |
| `NEXTAUTH_SECRET` Secrets Store binding added | Verifies the ticket and API token, and seals runtime authorization. |
| `SHARED_SANDBOX_OVERRIDES` KV binding pinned to the e2e namespace id | An id-less binding makes wrangler auto-provision the namespace and fail with `code: 10014` because the title already exists. |

### Container classes and removed bindings

The e2e Worker provisions exactly one container class, `SandboxSmall`, with
`max_instances: 20`. The value is an upper cap, not a reservation, and gives
parallelism headroom for later parallel runs. `SandboxSmall` keeps the rendered
`image` and `instance_type`; only `max_instances` and `ssh.enabled` change.

All six other container classes (`Sandbox`, `SandboxDIND`, `SandboxCodeReview`,
`SandboxContainment`, `SandboxSmallContainment`, `SandboxCodeReviewContainment`)
are removed from `containers`, `durable_objects.bindings` and `migrations`, so
those bindings do not exist on `cloud-agent-e2e-test`. The migration list keeps
each surviving SQLite Durable Object class on its original production tag
(`CloudAgentSession` `v2`, `SandboxSmall` `v3`, `UserKiloFacade` `v5`,
`StreamTicketNonceDO` `v8`, `SandboxControl` `v9`, `SandboxSession` `v10`);
entries whose classes are all removed (`v1`, `v4`, `v6`, `v7`) are dropped, and
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

The supported scenarios (`cold-hot-remote`, `unknown-model-remote`,
`auth-reject-remote`) are normal sessions. With
`PER_SESSION_SANDBOX_ORG_IDS='*'` they get a `ses-{hash}` sandbox ID
(`src/sandbox-id.ts`), and with `CREDENTIAL_CONTAINMENT_ENABLED='false'` their
metadata has no credential containment, so `getSandboxNamespace` reads
`env.SandboxSmall` — a kept binding. Those scenarios cannot reach a removed
binding.

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
`generateApiToken` family. Obtain one from the user's personal API key in the
Kilo web app or the CLI token flow. Never print the token.

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

## After a run

Cleanup against the e2e Worker must be finished FIRST. A run retains one
`cli_sessions_v2` row per started session for the enrolled user. The
user-runnable web `cliSessionsV2.delete` flow targets the PRODUCTION Worker and
is used afterwards only for those retained rows; it removes retained
ownership/history rows and is NOT a replacement for failed e2e runtime cleanup.
