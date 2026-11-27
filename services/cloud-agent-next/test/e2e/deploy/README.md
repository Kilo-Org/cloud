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
Access configuration below exists, the `deploy` and `preflight` jobs stop at
their first step, which checks it. A passing run additionally needs:

- the closed ingress in [Closed CI path](#closed-ci-path): the Access
  application, its service token and the `cloud-agent-e2e` GitHub environment;
- verified staging replacements for what a session start requires: a Cloud
  Agent staging database role behind a staging Hyperdrive, Session Ingest and
  container usage meter staging RPC targets, a staging runtime-release bucket,
  and a staging-only internal secret. A deploy succeeds without them, but no
  session starts. The renderer binds them once their identifiers exist; the
  fence rejects production ones;
- a Kilo backend that signs control tokens and stream tickets with
  `NEXTAUTH_SECRET_DEV`, a personal API token issued by it, that backend given
  as the `cloud-agent-e2e` environment variable `CLOUD_AGENT_E2E_BACKEND_URL`, and the
  renderer's `KILOCODE_BACKEND_BASE_URL`, now `https://api.kilo.ai`, changed to
  match.

Both e2e Workers verify tokens with the development signing key
(`NEXTAUTH_SECRET_DEV`). This is an intended switch: production binds the
production-labelled `NEXTAUTH_SECRET` store secret, and the e2e render replaces
it (`scripts/e2e-worker-fence.test.ts` asserts the rendered name). The Worker
never receives the user token: the driver sends it only to the backend, which
returns short-lived control tokens and stream tickets for the driver to present
to the Worker. The production backend at `https://api.kilo.ai` signs those with
the production key, so the Worker refuses them.

The e2e stack deploys and runs only from `main`, through the `Cloud Agent E2E`
workflow (`.github/workflows/cloud-agent-e2e.yml`, manual dispatch; a schedule
returns once the stack can pass). Every job refuses another ref, the
`cloud-agent-e2e` environment admits `main` alone, the deploy checks that its
commit is on `origin/main` before any step receives a secret, and the workflow
is never a reusable workflow.

## Closed CI path

CI reaches the Worker only through one custom domain behind a Cloudflare Access
application whose single policy is Service Auth for one service token.

- The `tests` job reads the token from STS (workload `ci-cloud-agent-e2e`,
  values in Infisical production `/ci/ci-cloud-agent-e2e`) with the local
  action `.github/actions/sts-bundle`, over the job's GitHub OIDC token. The
  token never becomes a GitHub secret.
- The driver sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` on every
  request to the Worker's and the fake LLM's origins and follows no redirect.
- Requests the Worker makes to either e2e origin re-enter Cloudflare's front
  door under `global_fetch_strictly_public` and pass that origin's Access
  application: the e2e entry wraps `fetch` once and stamps the token only on
  requests to the two configured origins (callback delivery to itself, model
  validation), and sandbox egress gets it from the e2e `ContainersOutbound`
  with the same rule (`src/e2e-surface/access-credentials.ts`). After the gate
  admits a request, the entry removes the token headers and the assertion
  before any handler sees it. The Worker holds the token as the Worker secrets
  `E2E_ACCESS_CLIENT_ID` and `E2E_ACCESS_CLIENT_SECRET`, uploaded by an
  operator after the closed deploy (below); Worker secrets survive every
  `wrangler deploy`, so the deploy never carries them.
- The Worker refuses every request whose `Cf-Access-Jwt-Assertion` does not
  verify against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` and
  the application audience, or whose `common_name` is not the service token's
  client id (`src/e2e-surface/access-gate.ts`). Without `E2E_ACCESS_AUD`,
  `E2E_ACCESS_TEAM_DOMAIN` or the `E2E_ACCESS_CLIENT_ID` secret it refuses
  everything.
- After each deploy, and before each test run, an anonymous request to each
  hostname must be refused by Access (`check-access-closed.sh`).

One dispatch runs four jobs: `deploy` (optional) and `build` side by side, then
`preflight` and `tests`. `build` does a filtered install without lifecycle
scripts and uploads the installed `node_modules` trees as an artifact kept for
one day. `tests` downloads it instead of installing. The Access check
(`check-access-closed.sh`) runs once per Worker after its deploy and once per
Worker before the tests: four times when the stack is deployed, twice when it
isn't. Each check passes in one request and fails after at most about 2.5
minutes (six tries, each at most 15 s, 10 s apart). After the deploy, the
readback makes 10 names-only Cloudflare API GETs, five per Worker, each at most
3 attempts of 30 s with a short wait between them (at most 30 requests, about
15 minutes worst case). Before the run, the short extra `preflight` job makes
one secrets-names GET, and the `tests` job reads STS once (typically about 1 s;
at most 3 attempts, about 6.5 minutes worst case) and sends five requests
through Access.

The jobs of `cloud-agent-e2e.yml`:

| Job | `id-token` | Reads | Runs |
|---|---|---|---|
| `deploy` (dispatch input `deploy`, default on) | no | GitHub secrets for Cloudflare and the runtime publication | install, runtime preparation, both deploys, the readback |
| `build` | no | nothing | `pnpm install --frozen-lockfile --ignore-scripts --filter cloud-agent-next...`, then packs the `node_modules` trees as an artifact |
| `preflight` | no | `CLOUDFLARE_API_TOKEN` (secret names only) | variable checks and one Cloudflare API GET; curl, jq and `node -e`, no package code |
| `tests` | yes | the STS bundle; GitHub secrets `E2E_USER_TOKEN`, `FAKE_LLM_ADMIN_TOKEN`, `E2E_INTERNAL_API_SECRET`; no Cloudflare credential | unpacks the trees and runs the driver with the package's own `tsx`; no install, lifecycle script or package manager |

The `tests` job is a narrow, explicit exception to the STS caller rule that a
bundle-reading job runs no third-party code
(`.github/actions/sts-bundle/README.md`): the driver must send the token on
every request, so it runs in that job, and it executes runtime package code from
the frozen lockfile.

Only the Access service token comes from STS. The workflow still reads these
GitHub secrets:

- `CLOUDFLARE_API_TOKEN`, `CLOUD_AGENT_RUNTIME_R2_ACCESS_KEY_ID`,
  `CLOUD_AGENT_RUNTIME_R2_SECRET_ACCESS_KEY`: move to STS-served bundles in a
  separate change.
- `E2E_USER_TOKEN`: needs a CI user-token exchange, a later phase.
- `FAKE_LLM_ADMIN_TOKEN`, `E2E_INTERNAL_API_SECRET`: become STS bundle entries
  later.

Prerequisites, in order:

1. Check that no DNS record exists for `cloud-agent-e2e.kiloapps.io` (zone
   `kiloapps.io`, account `e115e769bcdd4c3d66af59d3332cb394`).
2. Zero Trust (team `engineering-e11`): create the service token
   `ci-cloud-agent-e2e`, duration 8760h. Its client id and secret go straight
   to step 5, nowhere else.
3. Create the self-hosted Access application `cloud-agent-e2e-test` on
   `cloud-agent-e2e.kiloapps.io`, empty path, with one policy
   `ci-cloud-agent-e2e`: action **Service Auth**, Include = Service Token
   `ci-cloud-agent-e2e`. No Allow, Bypass or Everyone rule.
4. Read the application's audience (AUD) tag from its overview.
5. Store the client id and secret in Infisical production
   `/ci/ci-cloud-agent-e2e` as `E2E_ACCESS_CLIENT_ID` and
   `E2E_ACCESS_CLIENT_SECRET`.
6. The STS policy `ci-cloud-agent-e2e` (`services/sts/policy/`) serves exactly
   those two keys, pinned to this repository, `cloud-agent-e2e.yml` at
   `refs/heads/main`, the environment `cloud-agent-e2e` and the event
   `workflow_dispatch`. Only the `tests` job reads the bundle. It merges with
   or after this change.
7. Before merging this change, create the GitHub environment `cloud-agent-e2e`
   with deployment branches limited to `main`, and set in it the variables
   `CLOUD_AGENT_E2E_WORKER_HOSTNAME=cloud-agent-e2e.kiloapps.io`,
   `CLOUD_AGENT_E2E_ACCESS_AUD=<AUD from step 4>`,
   `CLOUD_AGENT_E2E_ACCESS_TEAM_DOMAIN=engineering-e11.cloudflareaccess.com` and
   `CLOUD_AGENT_E2E_BACKEND_URL=<non-production backend that signs with
   NEXTAUTH_SECRET_DEV>` (and, after step 9, `CLOUD_AGENT_E2E_FAKE_LLM_HOSTNAME`
   and `CLOUD_AGENT_E2E_FAKE_LLM_ACCESS_AUD`). It holds no Access
   secret. A workflow that names a missing environment creates it without
   protection.
8. Confirm `CLOUDFLARE_API_TOKEN` holds account **Workers Scripts Write** (or
   Workers Editor/Admin), the permission the
   [Attach Worker Domain API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/)
   accepts; Wrangler since workers-sdk #15903 no longer needs zone Workers
   Routes for a deploy whose only routes are custom domains.
9. Fake-LLM Access, before the first deploy of this change. `fake-llm` today
   has the plain custom domain `fake-llm.kiloapps.ai` (zone `kiloapps.ai`),
   with no Access application in front of it. Create a second self-hosted
   Access application for it
   ([Create an Access application](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/),
   `POST /accounts/e115e769bcdd4c3d66af59d3332cb394/access/apps`), with exactly
   this body:

   ```json
   {
     "name": "fake-llm-e2e-test",
     "type": "self_hosted",
     "domain": "fake-llm.kiloapps.ai",
     "destinations": [{ "type": "public", "uri": "fake-llm.kiloapps.ai" }],
     "session_duration": "30m",
     "allowed_idps": [],
     "auto_redirect_to_identity": false,
     "app_launcher_visible": false,
     "policies": [
       {
         "name": "ci-cloud-agent-e2e",
         "decision": "non_identity",
         "precedence": 1,
         "include": [{ "service_token": { "token_id": "0e35e631-8a08-4fd0-9f01-d4a75050f303" } }]
       }
     ]
   }
   ```

   Then set `CLOUD_AGENT_E2E_FAKE_LLM_HOSTNAME=fake-llm.kiloapps.ai` and
   `CLOUD_AGENT_E2E_FAKE_LLM_ACCESS_AUD=<the new application's AUD>` in the
   `cloud-agent-e2e` environment. The fake LLM verifies each request's
   `Cf-Access-Jwt-Assertion` against that audience and the team domain with the
   same gate as the e2e Worker. A second application rather than a second
   destination of `cloud-agent-e2e-test`: the Access docs require each public
   hostname to be in an active zone of the account, but do not say whether one
   application's destinations may span zones (`kiloapps.io` and
   `kiloapps.ai`); a separate application is the documented case and leaves
   the live one untouched. The policy is app-scoped (inline and reusable
   policies cannot be mixed on one application).
   Keep exactly this one Service Auth policy on `fake-llm-e2e-test`: the fake
   LLM's gate binds only the application audience, so any further policy on the
   application would admit its identities too.
10. Deploy from `main`: dispatch `Cloud Agent E2E`. The `deploy` job refuses a
    Worker holding any secret outside `INTERNAL_API_SECRET`,
    `E2E_ACCESS_CLIENT_ID` and `E2E_ACCESS_CLIENT_SECRET` (deleting another is
    a production change that needs approval first); missing Access secrets only
    print a notice, because the Worker refuses every request without them. It
    deploys both Workers (the first deploy attaches
    `cloud-agent-e2e.kiloapps.io`, keeps `fake-llm.kiloapps.ai`, and turns
    `workers.dev` and previews off) and requires Access to refuse anonymous
    requests to both hostnames.
11. Readback, in the same job (`readback-e2e-workers.mjs`, names only): no
    production binding remains (bindings equal the deployed configs),
    schedules are `[]`, `workers.dev` and previews are off, one version at
    100%, exactly the configured domain. The Access secrets are no finding here.
12. One-time operator upload, after step 11's readback shows no production
    bindings: from a disposable VM, using the approved Wrangler login route
    (token piped over ssh into a 0600 file, deleted with the VM), run a
    preflight that refuses any script other than `cloud-agent-e2e-test` and
    any secret name other than `E2E_ACCESS_CLIENT_ID` /
    `E2E_ACCESS_CLIENT_SECRET`, then `wrangler secret put` both, piped from
    Infisical production `/ci/ci-cloud-agent-e2e`, never printed. Rotation
    repeats this step. CI never uploads them. The preflight and upload are
    `test/e2e/deploy/upload-access-secrets.sh cloud-agent-e2e-test <values>`,
    where `<values>` is `-` (standard input) or a file with mode 0600 holding
    `E2E_ACCESS_CLIENT_ID=…` and `E2E_ACCESS_CLIENT_SECRET=…` lines.
13. Tests: dispatch again (the `deploy` input may be off). The `preflight` job,
    which runs no package code and is the only job besides `deploy` with the
    Cloudflare credential, checks the variables and, names only, that both
    Access secrets exist on the Worker, and stops with a pointer to step 12
    otherwise. The `tests` job, the only STS bundle reader and free of any
    Cloudflare credential, then proves the closed path (anonymous refused; with
    the service token, `WORKER_URL/health` and the fake LLM answer) before the
    run.
14. Rollback: redeploy the previous version id of each Worker. The readback
    prints each Worker's active version id (outside the comparison), so the
    run log of step 11 names the versions to return to; Cloudflare keeps the
    earlier ones. Through a reviewed change.

The readback covers versions, `workers.dev` and preview flags, schedules,
custom domains and bindings. Zone routes and queue consumers are covered by the
fence on the rendered config (no route other than the one custom domain, no
production queue), not by the readback.

Without `CLOUD_AGENT_E2E_FAKE_LLM_HOSTNAME`, `CLOUD_AGENT_E2E_WORKER_HOSTNAME`,
the AUD or the team domain, `deploy` refuses before uploading anything.

Rotating the service token:

1. Rotate the token's secret in Zero Trust (or create a replacement token and
   add it to both applications' policies), keeping a grace period for the
   previous secret.
2. Update `/ci/ci-cloud-agent-e2e` in Infisical production; the next `tests`
   run reads the new values from STS.
3. Repeat step 12 with the new values; no deploy is needed.
4. End the grace period (or remove the old token from the policies).

Until that first closed deploy, the live `cloud-agent-e2e-test` version stays
open in every other respect: only its `workers.dev` and preview addresses have
been turned off, so its production bindings, schedules and queue consumer
remain. `fake-llm` stays reachable at `fake-llm.kiloapps.ai` and on
`workers.dev` until step 9 and its first deploy from this change.

What a full run can do today. The `tests` job runs every scenario once the
deploy succeeds, but a passing run is not possible yet: the closed e2e Worker
binds no Hyperdrive, Session Ingest, usage meter, Git Token Service or runtime
bucket (none has a staging replacement in the repository), and the run needs a
backend that signs with `NEXTAUTH_SECRET_DEV` (`CLOUD_AGENT_E2E_BACKEND_URL`) and a user token
it issued. With those missing, the deploy, the readback and the closed-path
proof can pass; scenarios that create sessions fail at the first database,
ingest or runtime-download call.

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
- No Cloudflare login: local commands are `render` and `dry-run` only.
- A verified exact-SHA `wrangler.runtime-generated.json`, prepared with
  `pnpm exec tsx scripts/prepare-runtime-deploy.ts production <source-sha>` and the approved runtime
  publication read credentials. The E2E renderer inherits its descriptor and immutable runtime-free
  image, but never the production runtime bucket. It refuses an absent or non-downloaded
  configuration. The `Cloud Agent E2E` workflow runs this preparation for its own `main`
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

Only the reviewed `Cloud Agent E2E` workflow writes to Cloudflare for the test
Workers; no step below uses a personal login for a write. Locally, the scripts'
`render` and `dry-run` commands are the whole use. The commands run from
`services/cloud-agent-next` (or use the full path from the repo root).

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

2. Render and dry-run the fake LLM locally (no write):

   ```sh
   E2E_FAKE_LLM_HOSTNAME=fake-llm.kiloapps.ai test/e2e/deploy/deploy-fake-llm.sh dry-run
   ```

   The script has no default address: it refuses before rendering or uploading
   anything without `E2E_FAKE_LLM_HOSTNAME`. In the workflow, `deploy` renders
   `test/e2e/.wrangler/wrangler.fake-llm.jsonc` with that one custom domain,
   fences it, runs `wrangler deploy`, uploads `FAKE_LLM_ADMIN_TOKEN` as a Worker
   secret and requires Access to refuse an anonymous request. `probe`, run by
   the `tests` job with the Access service token, checks `/health`, that the
   JWT-gated model catalogue and `/test/requests` return 401 without a bearer,
   and that `/test/requests` answers with the admin bearer. A 401 from the
   Worker itself carries `X-Cloud-Agent-E2E-Refusal`, so it never passes for an
   Access refusal.

3. Render and dry-run the e2e Worker locally (no write):

   ```sh
   E2E_FAKE_LLM_HOSTNAME=fake-llm.kiloapps.ai test/e2e/deploy/deploy-e2e-worker.sh dry-run
   ```

   The workflow's `deploy` job runs `deploy-e2e-worker.sh deploy` with
   `E2E_WORKER_HOSTNAME`, `E2E_FAKE_LLM_HOSTNAME`, `E2E_ACCESS_AUD` and
   `E2E_ACCESS_TEAM_DOMAIN` from the `cloud-agent-e2e` environment.
   `render`, `dry-run` and `deploy` run the fence (`e2e-worker-fence.mjs`) on
   the rendered file, with the configured hostnames as the exact hosts, before
   anything else uses it. `deploy` first refuses a Worker holding any secret
   other than `INTERNAL_API_SECRET`, `E2E_ACCESS_CLIENT_ID` and
   `E2E_ACCESS_CLIENT_SECRET` (a missing Access secret only prints a notice;
   the operator uploads them after the deploy, see [Closed CI path](#closed-ci-path)),
   then deploys the version together with `INTERNAL_API_SECRET` when supplied
   (`wrangler deploy --secrets-file`, additive), and finally requires Access to
   refuse an anonymous request to the hostname.

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

4. Run the driver with the same admin token available (exported
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
| `FAKE_LLM_URL` | yes, for the driver | `https://<E2E_FAKE_LLM_HOSTNAME>`; the workflow builds it. |
| `FAKE_LLM_ADMIN_TOKEN` | yes | Bearer for the fake's `/test/*` routes. Uploaded as the Worker secret by `deploy-fake-llm.sh` and exported for the driver. When unset or empty, the script resolves it from `E2E_AUTH_FILE`. Never the development default. |
| `WORKER_URL` | yes, for the driver | `https://<E2E_WORKER_HOSTNAME>`; the workflow builds it from `CLOUD_AGENT_E2E_WORKER_HOSTNAME`. The Worker has no `workers.dev` or preview address. |
| `E2E_WORKER_HOSTNAME` | no | Deploy: the one custom domain of the Worker. Unset renders a Worker with no address. |
| `E2E_ACCESS_AUD`, `E2E_ACCESS_TEAM_DOMAIN` | with a hostname | Deploy: the Access application audience tag and `<team>.cloudflareaccess.com`, rendered as Worker vars. The Worker refuses every request whose `Cf-Access-Jwt-Assertion` does not verify against them, and everything when either is missing. |
| `E2E_ACCESS_CLIENT_ID`, `E2E_ACCESS_CLIENT_SECRET` | driver, with a hostname | The Access service token. In CI only the `tests` job reads it from STS (`ci-cloud-agent-e2e`); the driver sends it on every request to `WORKER_URL` and `FAKE_LLM_URL` and registers it on callback targets to the Worker's own origin. Set both or neither. The Worker holds the same values as operator-uploaded Worker secrets; the deploy script never reads or uploads them. |
| `E2E_FAKE_LLM_HOSTNAME` | yes | The fake LLM's Access-protected hostname; the workflow sets it from `CLOUD_AGENT_E2E_FAKE_LLM_HOSTNAME`. No default. |

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
- The fake LLM has no public address either: its one custom domain sits behind
  an Access application, and its capacity is capped, not guaranteed. The E2E
  Worker has no public address; it keeps the production
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

The `Cloud Agent E2E` workflow (`.github/workflows/cloud-agent-e2e.yml`) runs on
manual dispatch from `main` only; its schedule returns once the stack can pass
(see [Why the deployed profile is paused](#why-the-deployed-profile-is-paused)).
Its `deploy` input (default on) deploys first; the `preflight` job checks the
variables and the Worker's Access secret names; the `tests` job then runs the
parallel runner (`matrix.ts --profile deployed`) with the package's own `tsx`.
Its `parallel` input defaults to `4` and sets `E2E_PARALLEL`; `only` selects
scenarios; the backend is the environment variable `CLOUD_AGENT_E2E_BACKEND_URL`
and must be a non-production backend. See
[`../README.md`](../README.md#the-matrix-runner) for the scenario matrix and
the env contract.

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
