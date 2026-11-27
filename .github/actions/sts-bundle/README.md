# sts-bundle

Reads the job's secret bundle from Kilo STS and sets each requested secret as a step output. It is
a port of Kilo-Org/kilocode's `.github/actions/kilo-credentials` with this repository's outputs.

**Callers.**

| Workflow | Job | Workload | Keys |
|---|---|---|---|
| `.github/workflows/cloud-agent-e2e.yml` | `tests` | `ci-cloud-agent-e2e` | `E2E_ACCESS_CLIENT_ID`, `E2E_ACCESS_CLIENT_SECRET` |
| `.github/workflows/stage-vercel-deployment.yml` | `stage` | `ci-vercel-stage`, `ci-vercel-stage-staging` | the caller's `vercel_token_key`: `VERCEL_TOKEN_APP`, `VERCEL_TOKEN_AI_GATEWAY` or `VERCEL_TOKEN_AI_GATEWAY_SECURE_PROXY` |
| `.github/workflows/promote-vercel-deployment.yml` | `promote` | `ci-vercel-promote` | `VERCEL_TOKEN`, `AXIOM_ANNOTATION_TOKEN` (best-effort) |
| `.github/workflows/cloud-agent-sentry-sourcemaps.yml` | `upload` | `ci-cloud-agent-sentry`, `ci-cloud-agent-sentry-staging` | `SENTRY_AUTH_TOKEN` |
| `.github/workflows/kilo-app-release.yml` | `preflight`, `build-and-submit` | `ci-kilo-app-release` | `EXPO_TOKEN` |
| `.github/workflows/auto-docs.yml` | `call-valtown` | `ci-auto-docs` | `DOC_WEBHOOK_URL`, `DOC_WEBHOOK_SECRET` |
| `.github/workflows/push-dev-kiloclaw.yml` | `push-dev` | `ci-kiloclaw-dev-push` (STS staging) | `FLY_DEV_API_TOKEN` |

Each policy (`services/sts/policy/`) pins its one workflow file at `refs/heads/main`, its GitHub
environment and the events its workflow runs on; its values live in Infisical `/ci/<workload>`
(production, except `ci-kiloclaw-dev-push` in staging). `scripts/sts-bundle-callers.test.mjs`
holds every caller to the rules below.

Not callers, by design: `notify-main-failure.yml`, `notify-production-deploy-failure.yml`,
`sts-deployment-watch.yml` and `sts-deployment-watch-health.yml` keep reading
`DEPLOY_NOTIFY_SLACK_WEBHOOK_URL` (and the watch its Cloudflare token) as GitHub secrets, because
those alerts must still post when STS is down.

## What it does

1. Requests a GitHub OIDC token with the audience `sts-url` (`https://sts.kiloapps.io`).
2. Sends it as the bearer token in `POST <sts-url>/v1/bundle` with the body `{}`. STS picks the
   policy from the token's claims and returns that policy's bundle.
3. Masks every value in the bundle with `::add-mask::`, including keys the job did not request:
   each line on its own, and each multi-line value as a whole.
4. Checks that the response is exactly one `ok` bundle result, that its `workload` equals the
   `workload` input, and that it is not stale.
5. Sets each requested key as a step output, written to `GITHUB_OUTPUT` with its own random
   delimiter. Nothing is written to `GITHUB_ENV`.

The action fails on any error and has no fallback to a stored secret. A failure prints one error
line of at most 300 characters. From an STS refusal it shows only the HTTP status and the short
`status`, `reason` or `error` words of the response body. It fails on a stale bundle too: STS
serves its last known copy when the secret manager is unreachable, and that copy may still hold a
revoked key.

Tokens and values never appear in a command line or in the log. The responses are kept in a
temporary directory with mode 0700, which the action deletes when it exits. The action needs
`bash`, `curl` and `jq`, all installed on the Ubuntu runners.

### Retries and timing

At most 3 attempts, each with a new OIDC token. It retries an OIDC 5xx, an STS 503 (waiting for its
`retryAfterSeconds`, else `Retry-After`, else 5 s, capped at 60 s), and the curl transport errors 7,
16, 28, 35, 52, 55, 56 and 92 (waiting 5 s). The OIDC request is limited to 30 s and each STS
request to 60 s, so the worst case before the action fails is about 6.5 minutes. A typical read
takes about a second.

## Inputs

| Input | Required | Description |
|---|---|---|
| `workload` | yes | The STS policy name of the job |
| `secrets` | yes | One bundle key per line, declared under `outputs` in `action.yml`. A key missing from the bundle fails the job |
| `sts-url` | no | `https://sts.kiloapps.io` (default) or `https://sts-staging.kiloapps.io`. Any other value fails the job, because that origin would receive the OIDC token |

## Outputs

One output per bundle key that a policy read by this repository's workflows grants. Adding a key
means adding one output to `action.yml` in the same pull request as the first workflow that
requests it. Outputs of keys the job did not request are empty strings.

## Rules for a calling job

- It runs in the GitHub environment that its STS policy names, whose deployment branch policy
  allows `main` only, and it has `permissions: id-token: write`.
- Its workflow is never callable with `workflow_call`: the OIDC token of a reusable workflow carries
  that workflow's `job_workflow_ref`, so any workflow allowed to call it would receive its bundle.
  Exception: `stage-vercel-deployment.yml`, `promote-vercel-deployment.yml` and
  `cloud-agent-sentry-sourcemaps.yml` are reusable, because a deploy workflow's own file belongs to
  its trigger-only migration policy; `scripts/sts-bundle-callers.test.mjs` pins their callers, and
  a caller passes no secret and grants `id-token: write` as the ceiling of the called reader job.
- `secrets:` lists every key the job reads.
- Each value goes to the step that needs it, with `env:` on that step only, never in the job's
  `env:` or in `GITHUB_ENV`.
- Every action used in the job is pinned by its full commit SHA.
- Every step before this one is trusted: an earlier step can change the `PATH` and the environment
  this action runs with.
- No step in the job installs packages or runs lifecycle scripts, and none runs code from a fork or
  a pull request. With `id-token: write`, any step can request its own OIDC token and read the
  bundle itself.

**Exception, `cloud-agent-e2e.yml` `tests`.** The e2e driver must send the Access headers on every
request, so the values have to be in the job that runs it, and the driver runs package code. The
job therefore installs nothing: the `build` job installs with `--frozen-lockfile --ignore-scripts`,
has no `id-token`, and hands the installed workspace over as an artifact. The `tests` job reads the
bundle, downloads that workspace and runs the driver with the package's own `tsx`, without a
package manager. The exposure left is the runtime code of packages pinned by the lockfile.

**Exception, a tool that consumes the token.** Where the credential's only consumer is a
third-party CLI, that CLI runs with the token; no split can avoid it. Each such job installs
nothing: a helper job that cannot read the bundle installs or builds, packs the result and uploads
it as an artifact, and the reader job reads the bundle first, then downloads and unpacks it and runs
the tool by its path, without a package manager and without adding it to `PATH`.

- `stage-vercel-deployment.yml` `stage` and `promote-vercel-deployment.yml` `promote`: the pinned
  Vercel CLI, installed once per run by the caller's `vercel-cli` job
  (`install-vercel-cli.yml`, no `id-token`). Exposure: the runtime code of the pinned CLI version
  and of the dependencies npm resolves for it at install time, as before this change. The `stage`
  job checks out the deployed commit, so it loads this action from a side checkout of the run's
  own commit (`sts-action/`) and reads the bundle before the deployed commit reaches the runner.
- `cloud-agent-sentry-sourcemaps.yml` `upload`: the maps and the argument lists the deploy job
  staged (`stageSentryUploads` in `services/cloud-agent-next/scripts/sentry-source-maps.ts`), in a
  per-attempt artifact. Before unpacking, `scripts/ci/check-sentry-handoff.sh` refuses any member
  but `uploads.json`, `sentry-cli` and code files with maps in numbered folders (no dotfile,
  `.sentryclirc`, `.env`, `sentry.properties`, absolute path, `..` or link). The job runs only a
  `sentry-cli` binary it fetches itself and checks against the integrity `pnpm-lock.yaml` records
  at the deployed commit (and that equals the handed-over one), from an empty directory with the
  maps by absolute path, `SENTRY_LOAD_DOTENV=0` and `SENTRY_URL` fixed, and it refuses an argument
  list that is not a source map upload or that names `--url`, `--auth-token` or `--header`.
  Exposure: what the staged maps carry, the output of the cloud-agent-next deploy job, which runs
  the packages its lockfile pins and its build.
- `kilo-app-release.yml` `preflight` and `build-and-submit`: `eas-cli` from the `kilo-app...`
  closure the `app-workspace` job installs. `eas-cli` evaluates `app.config.ts`, so the exposure is
  the runtime code of the packages this lockfile pins for the app, as in the e2e exception.

**Exception, `push-dev-kiloclaw.yml` `push-dev`.** Its policy is a staging one for a development
registry token and names no GitHub environment; the `refs/heads/main` pin keeps it to dispatches
on main. The image build installs packages, but inside BuildKit, which receives neither the job's
environment nor its OIDC request token; the read runs right after the checkout.

## Tests

`scripts/sts-bundle-action.test.mjs` runs the script with stand-in `curl` and `sleep` commands and
checks the outputs, masking, the workload and stale checks, refusals, retries and that no token or
value reaches a command line. It runs in the `ci-wiring` job. To run it alone from the repository
root, with `bash` and `jq` installed:

```sh
node --test scripts/sts-bundle-action.test.mjs
```
