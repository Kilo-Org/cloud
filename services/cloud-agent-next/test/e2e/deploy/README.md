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

## Why the deployed profile is paused

The rendered e2e Worker binds no production resource and has no public address
(see [What the render changes](#what-the-render-changes-and-why)). Until the
Access configuration below exists, the deploy and tests workflows stop at their
first step, which checks it. A passing run additionally needs:

- the closed ingress in [Closed CI path](#closed-ci-path): the Access
  application, its service token and the `cloud-agent-e2e` GitHub environment;
- verified staging replacements for what a session start requires: a Cloud
  Agent staging database role behind a staging Hyperdrive, Session Ingest and
  container usage meter staging RPC targets, a staging runtime-release bucket,
  and a staging-only internal secret. A deploy succeeds without them, but no
  session starts. The renderer binds them once their identifiers exist; the
  fence rejects production ones;
- a Kilo backend that signs control tokens and stream tickets with
  `NEXTAUTH_SECRET_DEV`, a personal API token issued by it, the repository
  variable `CLOUD_AGENT_E2E_BACKEND_URL` set to it (the tests workflow's required
  `backend_url`), and the renderer's `KILOCODE_BACKEND_BASE_URL`, now
  `https://api.kilo.ai`, changed to match.

Both e2e Workers verify tokens with the development signing key
(`NEXTAUTH_SECRET_DEV`). This is an intended switch: production binds the
production-labelled `NEXTAUTH_SECRET` store secret, and the e2e render replaces
it (`scripts/e2e-worker-fence.test.ts` asserts the rendered name). The Worker
never receives the user token: the driver sends it only to the backend, which
returns short-lived control tokens and stream tickets for the driver to present
to the Worker. The production backend at `https://api.kilo.ai` signs those with
the production key, so the Worker refuses them.

The e2e stack deploys and runs only from `main`: both workflows refuse any other
ref, the `cloud-agent-e2e` environment admits `main` alone, and the deploy
checks that its commit is on `origin/main` before any step receives a secret.

## Closed CI path

CI reaches the Worker only through one custom domain behind a Cloudflare Access
application whose single policy is Service Auth for one service token.

- The driver sends `CF-Access-Client-Id` and `CF-Access-Client-Secret`
  (`E2E_ACCESS_CLIENT_ID`, `E2E_ACCESS_CLIENT_SECRET`) on every request to the
  Worker, follows no redirect, and registers the token on callback targets whose
  origin is the Worker's own.
- Requests the Worker makes to its own hostname re-enter Cloudflare's front door
  under `global_fetch_strictly_public` and pass the same Access application:
  callbacks carry the registered headers, and sandbox egress gets the token from
  the e2e `ContainersOutbound` (`src/e2e-surface/access-credentials.ts`), which
  stamps it only on requests to the Worker's own origin.
- The Worker refuses every request whose `Cf-Access-Jwt-Assertion` does not
  verify against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` and
  the application audience, or whose `common_name` is not the service token's
  client id (`src/e2e-surface/access-gate.ts`). Without `E2E_ACCESS_AUD`,
  `E2E_ACCESS_TEAM_DOMAIN` or the `E2E_ACCESS_CLIENT_ID` secret it refuses
  everything.
- After each deploy, and before each test run, an anonymous request to the
  hostname must be refused by Access (`check-access-closed.sh`). Cost: the check
  passes in one request; when it never passes it fails after at most about 2.5
  minutes (six tries, each at most 15 s, 10 s apart); it runs once after a deploy
  and once before the tests.

Prerequisites, in order:

1. Check that no DNS record exists for `cloud-agent-e2e.kiloapps.io` (zone
   `kiloapps.io`, account `e115e769bcdd4c3d66af59d3332cb394`).
2. Zero Trust (team `engineering-e11`): create the service token
   `ci-cloud-agent-e2e`, duration 8760h. Record its client id and secret once.
3. Create the self-hosted Access application `cloud-agent-e2e-test` on
   `cloud-agent-e2e.kiloapps.io`, empty path, with one policy
   `ci-cloud-agent-e2e`: action **Service Auth**, Include = Service Token
   `ci-cloud-agent-e2e`. No Allow, Bypass or Everyone rule.
4. Read the application's audience (AUD) tag from its overview.
5. Before merging this change, create the GitHub environment `cloud-agent-e2e`
   with deployment branches limited to `main`, and set in it:
   - secrets `E2E_ACCESS_CLIENT_ID` and `E2E_ACCESS_CLIENT_SECRET` (step 2);
   - variables `CLOUD_AGENT_E2E_WORKER_HOSTNAME=cloud-agent-e2e.kiloapps.io`,
     `CLOUD_AGENT_E2E_ACCESS_AUD=<AUD from step 4>` and
     `CLOUD_AGENT_E2E_ACCESS_TEAM_DOMAIN=engineering-e11.cloudflareaccess.com`.
   A workflow that names a missing environment creates it without protection.
   Once the staging backend exists, also set the **repository** variable
   `CLOUD_AGENT_E2E_BACKEND_URL`; the nightly passes it to the tests workflow,
   whose calling job has no environment.
6. Confirm `CLOUDFLARE_API_TOKEN` holds account **Workers Scripts Write** (or
   Workers Editor/Admin), the permission the
   [Attach Worker Domain API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/)
   accepts; Wrangler since workers-sdk #15903 no longer needs zone Workers
   Routes for a deploy whose only routes are custom domains.
7. Check the Worker's secrets:
   `pnpm exec wrangler secret list --name cloud-agent-e2e-test` must list only
   `INTERNAL_API_SECRET`, `E2E_ACCESS_CLIENT_ID` and `E2E_ACCESS_CLIENT_SECRET`
   (the deploy refuses otherwise). Deleting any other secret is a production
   change that needs approval first.
8. Only then deploy from `main`. The deploy attaches the custom domain and the
   Access check runs right after it.

Until that first closed deploy, the live `cloud-agent-e2e-test` version stays
open in every other respect: D35 turned off only its `workers.dev` and preview
addresses, so its production bindings, schedules and queue consumer remain.

Wrangler publishes custom domains only when the config lists one, and then
replaces the script's set with exactly that list. Rendering without
`E2E_WORKER_HOSTNAME` therefore leaves a domain attached earlier in place;
detach it in the dashboard (Workers & Pages → `cloud-agent-e2e-test` → Settings
→ Domains & Routes) or with the
[Detach Worker Domain API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/delete/).
The Worker keeps refusing requests without a valid Access assertion meanwhile.

## Prerequisites

- `pnpm install` at the repo root.
- Bun 1.4.4. The Cloud Agent deploy script builds the wrapper before bundling, including for `dry-run`.
- Cloudflare auth for account `e115e769bcdd4c3d66af59d3332cb394`.
- A verified exact-SHA `wrangler.runtime-generated.json`, prepared with
  `pnpm exec tsx scripts/prepare-runtime-deploy.ts production <source-sha>` and the approved runtime
  publication read credentials. The E2E renderer inherits its descriptor and immutable runtime-free
  image, but never the production runtime bucket. It refuses an absent or non-downloaded
  configuration. The `Cloud Agent E2E deploy` workflow runs this preparation for its own `main`
  SHA, so it only deploys a SHA whose exact-SHA runtime publication has completed.
- A fake-llm admin token, exported as `FAKE_LLM_ADMIN_TOKEN` or provided by
  `E2E_AUTH_FILE`, and a user token issued by a backend that signs with
  `NEXTAUTH_SECRET_DEV`, supplied by `E2E_USER_TOKEN` or `E2E_AUTH_FILE` (see
  [Environment variables](#environment-variables) and
  [Why the deployed profile is paused](#why-the-deployed-profile-is-paused)).
- Docker scope: deploying the fake Worker needs no Docker, because it is a Worker
  and a Durable Object, not a container image. Deploying the Cloud Agent e2e
  Worker uses the prepared immutable runtime-free image. Runtime preparation needs Docker to verify it. Running the
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
   FAKE_LLM_BASE_URL=<base> test/e2e/deploy/deploy-e2e-worker.sh dry-run
   FAKE_LLM_BASE_URL=<base> E2E_WORKER_HOSTNAME=cloud-agent-e2e.kiloapps.io \
     E2E_ACCESS_AUD=<aud> E2E_ACCESS_TEAM_DOMAIN=engineering-e11.cloudflareaccess.com \
     E2E_ACCESS_CLIENT_ID=<id> E2E_ACCESS_CLIENT_SECRET=<secret> \
     test/e2e/deploy/deploy-e2e-worker.sh deploy
   # add E2E_INTERNAL_API_SECRET=<secret> on the first deploy, or to rotate it
   ```

   `render`, `dry-run` and `deploy` run the fence (`e2e-worker-fence.mjs`) on
   the rendered file before anything else uses it. `deploy` first refuses a
   Worker holding any secret other than `INTERNAL_API_SECRET`,
   `E2E_ACCESS_CLIENT_ID` and `E2E_ACCESS_CLIENT_SECRET`, then deploys the
   version together with the supplied secrets (`wrangler deploy --secrets-file`,
   additive), and finally requires Access to refuse an anonymous request to the
   hostname. Follow [Closed CI path](#closed-ci-path) before the first deploy
   with a hostname: the custom domain answers as soon as it is attached.

   The renderer points `E2E_MODEL_VALIDATION_BASE_URL` at the fake Worker origin,
   so model validation with a runtime-authorized token uses the fake catalogue.
   Production never sets that variable.

   `deploy` deploys `E2E_INTERNAL_API_SECRET` as the Worker's
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
   seed remains the only no-JWT path.

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
| `E2E_AUTH_FILE` | no | Optional mode-600 JSON file for a deployed run: `{ token, userId?, email?, fakeLlmAdminToken?, e2eInternalApiSecret? }`. Supplies the user token when `E2E_USER_TOKEN` is unset or empty, and the identity (`userId` derived from the token when omitted; `email` optional). `deploy-fake-llm.sh` reads its `fakeLlmAdminToken` field when `FAKE_LLM_ADMIN_TOKEN` is unset or empty; `deploy-e2e-worker.sh` and the deployed driver read its `e2eInternalApiSecret` field when `E2E_INTERNAL_API_SECRET` is unset or empty. |
| `E2E_USER_TOKEN` | no | An ordinary personal Kilo API token issued by the backend at `E2E_BACKEND_URL`. The driver sends it only to that backend: it exchanges it for short-lived control tokens and uses it for backend requests, including stream tickets. The Worker never receives it; it verifies the backend-issued control tokens and stream tickets with `NEXTAUTH_SECRET_DEV`, so a token for `https://api.kilo.ai` cannot drive a passing run. Takes precedence over the auth file's `token` field and needs no separate `userId`/`email`. Not read by `deploy-fake-llm.sh`. |
| `E2E_INTERNAL_API_SECRET` | required for the deployed driver; optional for deploy | Value deployed as the `cloud-agent-e2e-test` Worker's `INTERNAL_API_SECRET` secret when a source supplies it, and always presented by the driver as both the surface key and the internal tRPC key. Needed for the first deploy or a rotation; a redeploy without it keeps the deployed value. When unset or empty, both `deploy-e2e-worker.sh` and the deployed driver resolve it from the `E2E_AUTH_FILE`'s `e2eInternalApiSecret` field. The shared `requireE2eInternalSecret` rules require at least 16 characters, no whitespace, and not the development default; the dotenv alphabet `[A-Za-z0-9._~-]` is a local-renderer concern only, so a base64 value is accepted here. Must differ from production's `INTERNAL_API_SECRET` (an operator requirement the scripts cannot prove). |
| `FAKE_LLM_BASE_URL` | yes | Must be `https://<fake-host>/api/openrouter`. |
| `FAKE_LLM_ADMIN_TOKEN` | yes | Bearer for the fake's `/test/*` routes. Uploaded as the Worker secret by `deploy-fake-llm.sh` and exported for the driver. When unset or empty, the script resolves it from `E2E_AUTH_FILE`. Never the development default. |
| `WORKER_URL` | yes, for the driver | `https://<E2E_WORKER_HOSTNAME>`; the workflow builds it from `CLOUD_AGENT_E2E_WORKER_HOSTNAME`. The Worker has no `workers.dev` or preview address. |
| `E2E_WORKER_HOSTNAME` | no | Deploy: the one custom domain of the Worker. Unset renders a Worker with no address. |
| `E2E_ACCESS_AUD`, `E2E_ACCESS_TEAM_DOMAIN` | with a hostname | Deploy: the Access application audience tag and `<team>.cloudflareaccess.com`, rendered as Worker vars. The Worker refuses every request whose `Cf-Access-Jwt-Assertion` does not verify against them, and everything when either is missing. |
| `E2E_ACCESS_CLIENT_ID`, `E2E_ACCESS_CLIENT_SECRET` | with a hostname | The Access service token. The driver sends it on every Worker request and registers it on callback targets to the Worker's own origin; `deploy` deploys it as Worker secrets. Set both or neither. |
| `FAKE_LLM_WORKER_URL` | no | Default `https://fake-llm.engineering-e11.workers.dev`. |

## Authentication model

The deployed fake has two separate credential boundaries:

| Route | Credential |
|---|---|
| `/health` | none |
| `GET /api/openrouter/models`, `POST .../models/validate`, `POST .../chat/completions`, `POST .../audio/transcriptions` | A valid Kilo JWT signed with the `NEXTAUTH_SECRET` Secrets Store binding, which resolves to the development signing key `NEXTAUTH_SECRET_DEV` (both Workers are non-production), with `apiTokenPepper` present. Accepts no audience or an audience matching `cloud-agent-next`, `kilo-api` or `kilo-gateway`. Allows `tokenPurpose`, `credentialExchange`, `runtimeAdmission` and `runtimeAuthorization`; rejects `organizationId` and `organizationRole`. |
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

Both e2e Workers bind the development signing key. The Worker never receives the
user token; it receives the control tokens and stream tickets the backend issues
in exchange for it, and refuses any not signed with `NEXTAUTH_SECRET_DEV`. The
production backend at `https://api.kilo.ai` signs them with the production key,
so the deployed profile cannot run against it while the Workers use the
development key (see
[Why the deployed profile is paused](#why-the-deployed-profile-is-paused)).

## What the render changes, and why

The renderer builds the config from an allowlist: it copies only runtime
settings (`account_id`, compatibility date and flags, source maps, version
metadata, rules, observability, placement) and adds the e2e Worker's own
resources. Any other key of `wrangler.jsonc`, including a binding added later,
stays out until it is reviewed. The fence (`e2e-worker-fence.mjs`, tested by
`scripts/e2e-worker-fence.test.ts` and run by `deploy-e2e-worker.sh` on the
file it deploys) fails on any top-level key the renderer does not emit, any
Durable Object binding to another script, any Secrets Store binding whose secret
is not named `*_DEV` or `*_STAGING`, a development environment, a route without
the Access vars, and any
public address. Its production hosts and queues come from:

- the top level of every direct `services/*/wrangler.json` and
  `services/*/wrangler.jsonc`;
- the `env.production` block of each of those files, where present;
- the prepared source config the renderer read (`wrangler.runtime-generated.json`
  in the deploy; the same `renderRuntimeTarget` output in the test).

Every other resource kind is refused by the key allowlist, whatever it names.

| Change | Reason |
|---|---|
| Separate Worker `name` | The e2e Worker is distinct from production. |
| Written to `.wrangler/wrangler.e2e-test.jsonc` | Private, gitignored render. |
| `main` and container `image` paths rebased (`../src/index.ts`, `../Dockerfile*`) | The rendered config lives one directory deeper, in `.wrangler/`. |
| `workers_dev: false`, `preview_urls: false`; no routes, or only the `E2E_WORKER_HOSTNAME` custom domain | No public address; the hostname is reachable only through its Access application. |
| `vars.WORKER_URL` is `https://<E2E_WORKER_HOSTNAME>`, or absent | The Worker never advertises production's hostname. |
| With a hostname, `vars.E2E_ACCESS_AUD` and `vars.E2E_ACCESS_TEAM_DOMAIN` | The Worker verifies every request's Access assertion against them and refuses everything without them. |
| `triggers.crons: []` | The scheduled handlers read and delete report data over Hyperdrive; an empty list also removes schedules left on the script. |
| Every service binding dropped (`SESSION_SYNC`, `SESSION_INGEST`, `GIT_TOKEN_SERVICE`, `NOTIFICATIONS`, `CONTAINER_USAGE_METER`) | Each targets a production Worker. No closed staging target exists for any of them in this repository. |
| `HYPERDRIVE`, `R2_BUCKET`, `WORKSPACE_ARTIFACTS_BUCKET`, `RUNTIME_RELEASE_BUCKET` and `AI` dropped; `logpush` off | Production database, buckets, runtime publication and account AI. |
| Report-queue producer and consumer removed | The e2e Worker must not produce or consume the production report queue. |
| Callback-queue producer and consumer renamed to `cloud-agent-next-callback-queue-e2e-test`; any dead-letter queue dropped | The e2e Worker can never consume production callback messages or write to a production dead-letter queue. |
| Only the native `SandboxContainers` container kept | Native Cloudflare Containers is the only runtime; the E2E Worker exercises the same provider as production. |
| Durable Object bindings: only this script's own classes | A binding with `script_name` would reach another Worker's objects. |
| Runtime migrations preserve E2E history | `v15` removes the old runtime; `v15-e2e` creates the retained runtime namespaces. |
| Secrets Store: only `NEXTAUTH_SECRET` → `NEXTAUTH_SECRET_DEV`; `INTERNAL_API_SECRET_PROD` dropped | Verifies the ticket and API token, and seals runtime authorization, with the non-production signing key. |
| Not changed: `KILOCODE_BACKEND_BASE_URL=https://api.kilo.ai`, `KILO_SESSION_INGEST_URL` and the other production URL vars | Outbound addresses only, with no production credential bound; a staging backend replaces them. |

### Container classes and migrations

The E2E Worker provisions one container class, `SandboxContainers`, the native
runtime used by every session. `SandboxContainment` and
`SandboxSmallContainment` have no container or binding; `src/e2e-entry.ts`
exports them as no-op tombstones so their stored namespaces remain valid.

The renderer preserves the deployed Worker's migration history. The `v15`
migration deletes its old `Sandbox` namespace. The `v15-e2e` migration directly after `v15`
creates the `SandboxContainment`, `SandboxSmallContainment`, and
`SandboxContainers` namespaces, which the old E2E configuration omitted. This
applied migration stays fixed even though only `SandboxContainers` still has a
container. The local E2E renderer uses the production migration list and does not
add this deployed-only migration. Later production migrations keep their class operations and follow `v15-e2e`.

Native containers retain their production scheduling configuration. Container
image paths are rebased for the generated configuration directory.

## Token requirement

The driver requires an ordinary personal Kilo API token from the
`generateApiToken` family, supplied as `E2E_USER_TOKEN` or as the `token` field of
the auth file named by `E2E_AUTH_FILE`. Obtain one from the personal API key or
CLI token flow of the backend named by `E2E_BACKEND_URL`. Never print the token.

The driver exchanges this source token for short-lived Cloud Agent control
tokens through that backend's `/api/cloud-agent-next/token` route.
It presents the control token to the Worker and refreshes it before expiry.
Backend requests, including stream tickets, still use the source token; the
Worker never receives it.
The driver rejects session/control, organization and delegated/runtime tokens
as source credentials before it sends a request.

The Worker verifies control tokens and stream tickets with `NEXTAUTH_SECRET_DEV`,
so the backend must sign them with that key. `https://api.kilo.ai` signs with
the production key, so a token for it cannot drive a passing run (see
[Why the deployed profile is paused](#why-the-deployed-profile-is-paused)).

The renderer sets `E2E_MODEL_VALIDATION_BASE_URL` to the fake Worker origin.
Model validation accepts this base only when its origin matches
`KILO_OPENROUTER_BASE`, so the fake catalogue is the official validation route
for this e2e Worker. The fake model routes accept personal control and runtime
tokens with the audiences listed above, and reject organization claims.

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

- The fake's model routes are public but require a valid Kilo JWT; its `/test/*`
  routes require the admin token. A leaked admin token exposes only the test
  side channel (gate release, counters, scenario status), not billing or
  session data.
- The fake LLM is a public `workers.dev` endpoint with capped, not guaranteed,
  capacity. The E2E Worker has no public address; it keeps the production
  runtime classes, and legacy pools have a 40-instance cap.
- There is no per-user admission guarantee and no concurrent-run isolation.
- Capacity is capped but there is no total-spending cap.
- The supported profile is short streams only. `gate`/`hang` directives are
  reachable on the deployed fake (they need a valid model token and, for
  `gate`, an admin-token release), but they are unsupported by the deployed
  profile and are NOT guaranteed to terminate within two minutes or to survive
  an eviction. `sleepAfter` limits sidecar inactivity only.
- The e2e Worker render binds none of production's resources: no Hyperdrive,
  R2 bucket, service binding, production queue or production secret, and the
  fence rejects any. It is reachable only through the Access-protected custom
  domain, and refuses requests without a valid Access assertion.

## Running the deployed matrix

```bash
pnpm --filter cloud-agent-next run e2e:deployed
```

`e2e:deployed` is the serial run of `matrix.ts --profile deployed`. It runs every
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
`1` if any scenario failed, else `0`; a capability gap is filtered out before
spawn and reported as a skip, not a failure.

The `Cloud Agent E2E tests` workflow
(`.github/workflows/cloud-agent-e2e-tests.yml`) supports `workflow_dispatch`
and `workflow_call`. The `Cloud Agent E2E nightly` workflow deploys the e2e stack
and then calls it. Its daily 03:37 UTC schedule is paused (see
[Why the deployed profile is paused](#why-the-deployed-profile-is-paused)), so it
runs only on manual dispatch. The tests workflow runs the
parallel runner (`e2e:parallel`) as one job. Its `parallel` input defaults to
`4` and sets `E2E_PARALLEL`; `only` selects scenarios. See
[`../README.md`](../README.md#the-matrix-runner) for the scenario matrix
and the env contract.

Under the deployed profile the shared gate owns session teardown, so a scenario
that did not previously delete its session now releases its sandbox:
`interruptSession` then `deleteSession`, newest first, with the delete on a 45 s
client budget. That budget bounds the client request, not the container's
destruction.
When the last root session requires workspace deletion, the gate reads its
workspace and Kilo session ids, then calls `deleteWorktree` with a sole-session
fence and a separate 90 s client budget.

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
