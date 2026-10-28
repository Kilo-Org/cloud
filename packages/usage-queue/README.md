# Vercel usage queue staging readiness [AISAGE-783]

Topology: gateway (FRA/SFO) → explicit FRA Vercel topic → private FRA callback
in **kilocode-ai-gateway** → existing FRA **kilocode-app** HTTP usage writer.
No database work moves into the consumer. Cloudflare remains the default and
production cannot opt into this staging-only publisher. This is a controlled
staging experiment, with no measured improvement or production-readiness claim.

## Isolation and ownership

This package owns the Vercel publisher, staging selector, private callback,
consumer validation/retry decisions, SDK/privacy tests and this runbook. Its only
application contracts are `@kilocode/usage-contracts` and the existing
`@kilocode/worker-utils` writer client and scoped callback-token helper. It has no dependency on `web-shared`,
Next.js, the Cloudflare Worker, database persistence or application configuration.
The Vercel SDK is declared only here; gateway/web-shared depend on this package.

Next-specific code lives together in `apps/ai-gateway/src/usage-queue`: route
template, target/trigger configuration, build preparation and integration tests.
The root gateway config composes that folder's deployment settings. The normal
Next route is generated only for staging; the package does not create a public
publishing endpoint. Production and preview builds omit the callback and trigger.

The external integration points are deliberately small:

| Existing owner | Queue integration |
|---|---|
| Shared `usage-publisher.ts` | Import the package selector/publisher and delegate only on exact staging opt-in; existing Cloudflare code stays here |
| Shared `config.server.ts` | OR the isolated selector into the existing queue-only choice; the package owns the selector logic |
| Gateway `vercel.mjs` / `package.json` | Compose the queue deployment settings and run the queue prepare/test commands |
| Gateway/shared manifests | Workspace dependency on this package; no direct Vercel SDK dependency |
| Existing writer route/diagnostics/client | Recognize `queue_vercel` for caller correlation; no queue SDK dependency or persistence change |
| Root patch registry and environment catalog | Versioned SDK redaction patch and operator variable documentation, following repository conventions |

### Deleting the prototype after rollback

Stop new intake with the switchback procedure at the end of this document.
Accepted messages remain pinned to their original deployed consumers. Deleting
source in a new deployment does not delete those immutable old deployments:
**retain their consumers and compatible writer credentials/schema until accepted
work drains**. Never delete or disable old deployments to complete a code rollback.

The POC remains one commit, so reverting that commit removes both owned folders
and all integration hooks together. Verifying drain before cleanup is the
simplest procedure; an earlier code rollback must still retain the old consumer
deployments and compatible writer while they drain. If later work requires a
selective cleanup instead, a cleanup PR can:

1. Delete `packages/usage-queue` and `apps/ai-gateway/src/usage-queue`.
2. Remove the package imports and delegation branch from shared `usage-publisher.ts`,
   and remove the selector import/OR from `config.server.ts`. Their existing CF,
   direct and production SFO behavior remains owned by those files.
3. Remove `usageQueueDeployment` from the gateway root config, restore its build
   command to `next build`, and remove the queue test script/CI step and the two
   workspace dependency entries. Remove the generated-route `.gitignore` entry.
4. Remove the SDK patch registry entry/file and unused lock entries, and remove
   the prototype environment catalog entries. The repository convention requires
   the SDK patch to remain under root `patches/` while the POC is installed.
5. Remove `queue_vercel` from the writer/client/diagnostic caller-label types and
   allowlist if it is no longer needed. Historical log data remains intact; the
   label itself neither imports nor activates queue code.

No Cloudflare service code, direct billing implementation or database schema must
be moved or removed to delete this prototype. Review the small integration hunks
against the then-current main rather than restoring whole files and overwriting
later work. Re-run the default transport, cycle, patch, deployment-target and
ordinary-route checks after cleanup.

## Quick activation after merge

**One runtime switch:** set `USAGE_QUEUE_TRANSPORT=vercel` on the gateway's
**staging** environment and redeploy. It also selects queue-only accounting in
staging; `USAGE_QUEUE_ONLY_ENABLED=true` is not additionally required. Production
ignores this selector and deploys neither the callback nor its queue trigger.

There is still a one-time setup: supply the gateway's existing staging writer
URL/credential and optional protection bypass from the activation table, confirm
Queues/OIDC project access, and deploy gateway + writer. The normal staging
workflow automatically includes the FRA trigger without a queue-level concurrency
cap; no separate queue publish endpoint or manual topic-creation script is part of this POC. These
prerequisites have not been inspected or activated on the hosted project here.

Before the first deployment of this change, verify the staging selector is not
already `vercel`: that value activates immediately even if the legacy queue-only
flag is false. Deploy with the selector absent until hosted readiness is verified.

Before load, complete the private-ingress gate and one ordinary small gateway
smoke request, checking persistence and actual ACK/drain. Then use the bounded
10/25/50/100rps stages below. To stop new Vercel publication, remove/change the
transport selector and redeploy; keep old staging deployments consuming until
accepted work drains. The legacy queue-only flag determines whether the restored
path is Cloudflare or existing direct accounting.

## Readiness boundaries

| Stage | Required evidence |
|---|---|
| Merge candidate | Current-head focused tests/typechecks/lint, frozen installation including SDK patch, Next build and adapter output, independent code/operations review |
| First hosted smoke | Operator verifies project access/OIDC, negative-ingress gate, actual private trigger and FRA function placement, both deployments/settings, then authorizes one request and checks persistence **and** queue ACK |
| Bounded normal gateway load | Successful smoke, known account/provider allowance and spend/count/rate bounds, observable accepted IDs/outcomes, old queues drained, aligned telemetry and stop/drain procedure |
| Production | Not established here; producer recovery and Bouncer replay/overdraft correctness remain unresolved |

Local SDK/HTTP tests do not prove hosted durability, ordinary-HTTP isolation,
actual placement, entitlement, true billing side effects, ACK/drain or throughput.
A missing hosted prerequisite is a smoke prerequisite, not proof the local PR is
broken. No credentials, hosted messages, deployment or load are run by local checks.

## Deployment path and capacity

`deploy-staging.yml` deploys gateway and writer through
`stage-vercel-deployment.yml` from the same tested SHA, after DB startup/migrations.
The shared workflow uses **Vercel CLI 59.5.0** and `vercel deploy --target=staging`;
the Vercel project Root Directories must be `apps/ai-gateway` and `apps/web`.
Record the actual project settings/build adapter version when deployed; those
account settings cannot be established from source alone. CI's gateway job runs
a production-shape Next build, and web tests include the shared usage suites.
The staging build/adapter matrix is verified locally for this candidate; CI does
not add a separate staging build.

`apps/ai-gateway/vercel.mjs` composes the isolated
`src/usage-queue/deployment.mjs` configuration only for a staging deployment. The normal workflow already supplies `TARGET_ENVIRONMENT` to the CLI;
the hosted build receives `VERCEL_TARGET_ENV`. Missing/non-staging/conflicting
targets or `VERCEL_ENV=production` omit the queue. Config compilation occurs before
the CLI pulls remote env, so a manual CLI deploy outside this workflow must also
supply its local `TARGET_ENVIRONMENT=staging`; the `--target` argument alone is not
the gate. Do not set staging target variables on a production deploy.

The configuration explicitly selects `pnpm run build`, which runs
`src/usage-queue/prepare.mjs` before Next. It copies
`src/usage-queue/route.ts` to the ignored generated route
`src/app/api/v1/internal/queues/usage/route.ts` only in staging and removes a stale
copy on other targets. This is also the trigger selector in `vercel.mjs`. Its
`queue/v2beta` trigger uses
`usage-staging`, retries after 60s, caps deliveries at 20 and omits
**maxConcurrency** for the staging diagnostic experiment. It has a separate
function `regions: ["fra1"]` override;
normal gateway functions retain FRA/SFO. Consumer maxDuration is 180s, writer
HTTP timeout 160s, existing writer maxDuration 150s, SDK visibility 300s with renewal.
The maintained pnpm SDK patch removes receipt handles/raw errors from renewal
logs in both runtime bundles; retain its slow-renewal tests on SDK upgrades.

**Capacity is static deployment configuration, not a runtime variable.** Earlier
prototype variants used cap 4 for smoke and cap 200 for comparison. This candidate
removes the staging queue-level cap by omitting `maxConcurrency`; Vercel function
and account limits may still apply. The omission takes effect only after deployment,
so inspect the deployed trigger and retain old deployment settings in the run manifest.
Runtime flags cannot change a deployed cap. This diagnostic experiment makes no
latency or throughput improvement claim; actual scheduling, writer latency and retries matter.

Production/preview/unknown-target builds contain neither the callback route nor
its queue trigger. The ordinary gateway routes retain their FRA/SFO defaults.
Runtime producer and consumer staging guards remain as additional checks. Source
code and the SDK dependency still live in the shared checkout; the queue consumer
infrastructure is deployed only in staging.

### Message authentication independent of private routing

The publisher wraps the unchanged `UsageRecordRequest` in a version-1 signed
envelope using the existing scoped HMAC callback-token helper. The signature
binds the complete JSON payload and `usage-staging` topic to the
`vercel-usage-queue-v1` purpose, using the existing staging `USAGE_WRITER_SECRET`;
no additional operator variable or credential is required. The secret is never
included in the message. Missing signing configuration prevents publication.

Before parsing usage or calling the HTTP writer, the consumer verifies the
signature and expected topic. Unsigned, altered, wrong-key, wrong-purpose or
wrong-topic messages fail without writer I/O or ACK. Queue-shaped headers alone
do not authenticate a request. The original usage ID remains the publish
idempotency key and the writer's persistence identity.

CLI and hosted-build target labels can differ: a manual CLI invocation without
`TARGET_ENVIRONMENT=staging` can omit the trigger even though the hosted staging
build generates a route. Message authentication makes that route fail closed for
forged billing events; it does not establish platform-private classification or
repair a missing delivery trigger. Such a deployment still fails the required
negative-ingress/readiness gate and must not be used for the experiment. Do not
work around a missing signature by accepting raw payloads. Old deployment-pinned
messages retain their original consumer code; keep those deployments and writer
credentials/schema compatible while they drain.

Topics are project scoped and messages deployment pinned. Put the callback in
the producer gateway project, not the separate writer project. Old cap-200
consumer deployments retain their own limits; new uncapped deployments set no
queue-level concurrency budget. The shared writer sees aggregate traffic from
all active deployment partitions. Drain/isolate old partitions before comparisons.

Current Vercel docs define queue-triggered functions as private, with no public
URL. Verify deployed output/console actually classifies this function that way;
a Next route existing is insufficient. Do not add a public publishing endpoint
or a web rewrite for the callback. Publisher storage is explicitly `fra1`.
Queue metadata region is storage, while `VERCEL_REGION`/`executionRegion` identify
compute. Confirm function region settings; proxy region and leading
`x-vercel-id` hops do not establish compute. Queue failover may temporarily use
a neighboring storage region; strict residency is not guaranteed.

## Operator activation table

Use the repository's user-run `pnpm web:env set <VARIABLE>` / `pnpm web:env copy`
workflow (DEVELOPMENT.md) for shared environment changes; agents must not run it
or read/copy secret files. Scope ordinary flags to the **staging custom environment**,
then redeploy: server configuration is read at process startup, not live remotely.
Do not set these on production. Existing credentials must be supplied securely,
never pasted into commands, PRs, logs or manifests.

| Project / environment | Setting | Required value / action | Kind and redeploy |
|---|---|---|---|
| Gateway / staging | `VERCEL_TARGET_ENV` | Vercel supplied `staging` | Platform; verify target |
| Gateway / staging | `VERCEL_ENV` | Vercel supplied, must not be `production` | Platform; verify |
| Gateway / staging | `USAGE_QUEUE_ONLY_ENABLED` | Not required for Vercel; retain the existing CF/direct choice | Legacy CF flag; does not override exact `vercel` |
| Gateway / staging | `USAGE_QUEUE_TRANSPORT` | Exact `vercel` | Ordinary selector; redeploy |
| Gateway / staging | `USAGE_WRITER_URL` | `https://staging-app.kilo.ai/api/internal/usage/record` | Ordinary URL; verify destination, redeploy |
| Gateway / staging | `USAGE_WRITER_SECRET` | Match the existing staging writer's `INTERNAL_API_SECRET`; also signs/verifies the scoped queue envelope | Existing credential; secure workflow, redeploy |
| Gateway / staging | `USAGE_WRITER_PROTECTION_BYPASS` | Existing writer automation bypass if protection requires it | Existing credential; secure workflow, redeploy |
| Gateway / staging | `VERCEL_QUEUE_DEBUG` | Unset or `0` | Ordinary setting; SDK debug can expose headers |
| Gateway project | OIDC + Queues access | Confirm deployed SDK can publish/consume in this project; verify plan/permissions | Platform prerequisite; no login/pull performed here |
| Writer / staging | `INTERNAL_API_SECRET` | Existing matching secret, existing DB/runtime settings retained | No new queue flags; deploy caller-label change |
| Gateway / staging | CF `USAGE_INGEST_URL` / `USAGE_INGEST_PUBLISH_SECRET` | Retain existing values for switchback | Existing configuration/credential |
| Gateway deployment | Topic / storage / callback region / cap | `usage-staging` / FRA / FRA / omitted `maxConcurrency` | Static config; requires deployment |

Exact `vercel` alone selects Vercel plus queue-only accounting under the staging
guard, including when the legacy queue-only flag is absent/false. Setting only
that legacy flag false does not turn Vercel off: remove/change the selector.
Absent, misspelled or case-mismatched transport values restore the existing
Cloudflare/direct choice controlled by the existing flags. Production
excludes Vercel even if the selector is accidentally copied. Effective queue-only
mode selects one transport, so no dual publication. Missing writer config fails consumption and retries; it does not
redirect an accepted event to Cloudflare or the gateway billing writer.

## Negative-ingress gate before the first hosted smoke

This is an **operator-only procedure after separate authorization**, not a probe
performed by local verification. Platform private-function isolation is the
security boundary; the SDK callback does not authenticate public CloudEvents.
Source rewrites or a non-2xx response alone cannot establish hosted isolation.

Before publishing any smoke event, inventory the actual staging gateway/web
aliases and deployment URLs. For each applicable host, send one ordinary HTTP
`POST` per path below; include both versioned and unversioned web aliases from
`apps/web/ai-gateway-rewrites.mjs`:

| Staging host | Path |
|---|---|
| `staging-ai-gateway.kilo.ai` | `/api/v1/internal/queues/usage` |
| `staging-app.kilo.ai` | `/api/gateway/v1/internal/queues/usage` |
| `staging-app.kilo.ai` | `/api/gateway/internal/queues/usage` |
| `staging-app.kilo.ai` | `/api/openrouter/v1/internal/queues/usage` |
| `staging-app.kilo.ai` | `/api/openrouter/internal/queues/usage` |

For each request, send **empty JSON `{}`**, `content-type: application/json`,
**no `ce-*` headers**, and no usage payload, queue receipt or queue token. Keep a
fresh operator-side probe ID and timestamp for correlation; capture the platform
request/trace ID from the response. The installed SDK rejects this request while
parsing, before invoking the consumer or writer. Never substitute a valid billing
fixture or genuine CloudEvent/receipt: negative probes must not create billing
or acknowledge actual messages.

If deployment protection rejects the request, repeat using the operator's
existing authorized protection-bypass mechanism for the gateway/web ingress as
applicable. A protection 401/403 is not proof the underlying callback is private.
Use secure tooling; never record bypass credentials or full request headers.

Record each probe ID, host/path, timestamp, status and platform request/trace ID.
Require deployed **private-function classification**, non-2xx, and correlated
platform invocation/access evidence that the queue callback was not invoked
through any path. Any SDK-specific parser response (including a 400 about
CloudEvent headers, content type or body fields) proves callback code ran and
**fails the gate**. Inspect callback invocation traces and consumer failure/start/
completion logs, as well as writer invocation/completion logs; require no writer
call or `writer_caller=queue_vercel` completion attributable to a probe. This
empty-body probe is rejected before consumer logs, so their absence alone cannot
establish isolation. Confirm log coverage, retention and ingestion; missing or
sampled invocation evidence leaves the boundary unverified.

**Stop before smoke/load** if any callback invocation or writer activity is
attributable to a probe, any probe returns 2xx, protection cannot be bypassed for
this check, or evidence cannot establish the boundary. Preserve sanitized probe
correlations and investigate platform routing/classification; do not activate
publishing, weaken validation or add a failed-event ACK to make the check pass.

## One-request smoke, then bounded normal gateway load

1. Record source SHA, gateway/writer deployment IDs, project/target, runtime flags,
   actual trigger/cap/regions and SDK patch pin. Wait for **both** deployments.
   Complete the negative-ingress gate above; verify the callback is private and
   no queue path is publicly routable.
2. Confirm staging source queues/old deployment partitions and CF DLQ state;
   identify unrelated writer activity. Use one authorized ordinary gateway request
   with a dedicated test account/session and known small model/output budget.
   Retain request ID, input/outcome, API timestamps and any emitted usage ID.
3. Correlate `usage enqueue accepted` (`transport=vercel`), consumer start/completion,
   writer `usage_record_completion` (`writer_caller=queue_vercel`), matching DB row
   and payer amount. Consumer returns only for matching recorded/duplicate; an
   HTTP 200 inference result alone is insufficient. Verify actual queue ACK and
   zero backlog/retries separately, plus actual FRA execution. Do not infer ACK
   from the recorded row or from consumer completion logged before the SDK ACK.
4. Predeclare a run manifest: exact revisions/transport/cap, account/model/regions,
   unique request/session IDs, count, maximum in-flight requests, offered rate,
   duration, per-request output limit and total spend budget. Use the same plan for
   CF and Vercel. Confirm the account/provider allowance covers the proposed rate;
   do not bypass rate limits or turn 429s into more load. Start with a small cohort,
   then separately authorized 10/25/50/100 requests/s stages, bounded in count/time
   and separated by full drain and fresh baseline windows. Do not start 100rps
   merely because the queue-level concurrency cap is omitted.
5. Stop **new intake** on unexplained publish loss/unknown acceptance, sustained
   retries/backlog age beyond the declared gate, writer 429/503, DB overload,
   spend cap, or account/provider rejection. Keep accepted work consuming; examine
   cold activation/recovery separately before increasing rate. Do not count a
   request rejected before inference as a queue throughput failure or silently
   drop unsent requests from the denominator. Set a bounded observation/drain
   deadline; if it expires, report residual IDs/backlog rather than claiming drain.

### Fair comparison and measurement

| Control | Cloudflare pinned source / deployed comparator | Vercel candidate |
|---|---|---|
| Ceiling and scope | Pinned main uses one global queue at `max_concurrency=200`; record actual queue identity/location, deployed Worker revision and all consumers | Staging trigger omits `maxConcurrency`; record platform limits and inventory old deployment partitions |
| Batch / writer calls | Pinned main uses batch 1 / timeout 0 / sequential calls; deployed batch and per-batch parallelism must be recorded | One event/callback and one awaited writer call |
| Retry / recovery | `max_retries=3`, `retry_delay=60`, configured DLQ; verify retention and deployed settings | 20 deliveries, 60s retry, 24h TTL, no built-in DLQ |
| Writer admission | Same existing staging writer, revision, HTTP budget, DB pool and other traffic | Same; omitting the queue cap does not prove achieved concurrency |

These source defaults describe main `b63e3f2b12ee2b8876dc266edd1e260553936f92`,
not verified hosted settings. If the operator selects a single EU queue, record
its actual identity/location and deployed revision; this prototype neither creates
nor depends on it. A comparator with batch 2, parallelism 2 and cap 200 can permit
up to **400 concurrent writer calls**; the earlier Vercel cap-200 variant allowed
200 one-event callbacks. This candidate omits the Vercel queue cap. A CF cap of
100 with parallelism 2 preserves a 200-call bound. Include all
retained consumers/partitions and the deployed relay/writer revisions in the
manifest; do not import pending EU or batching changes to construct this POC.

Align observed effective writer concurrency and workload before attributing any
result to transport. Comparing capped CF with this uncapped Vercel candidate is an
**unmatched whole-system comparison** unless effective writer concurrency is aligned.
A historical CF400/Vercel200 scenario is an **unmatched whole-system
comparison**, even if both consumer settings say 200. If CF200 is compared
with a cap-4 smoke variant, label it
**unmatched whole-system configurations (CF200/Vercel4)**, not transport isolation.
The intentional Vercel policy remains **20 total deliveries with 60s retry**;
CF has three retries after the first attempt, **four total attempts**. For each valid
queued message whose attempts reach the writer, Vercel therefore permits up to
**5× the configured attempt budget** (20 versus 4), independent of the concurrency
setting.
Delivery failures before the writer can consume budget without an HTTP write;
measure actual writer calls, retries and DB pressure rather than inferring them.
Failure/saturation tests are **not matched on retry pressure** and must be labeled
separately from steady-state capacity comparisons. Stop new intake on writer
429/503, unexplained retries/loss or the declared overload/age gate; preserve and
monitor accepted work through bounded drain and the recovery limits below.
Never acknowledge failed billing, including `not_recorded` or invalid payloads,
to equalize attempt budgets or force a drain. Neither configured cap nor a drain
timeout proves recovery; retain residual IDs and exhausted/expired outcomes.

Use complete writer HTTP start/end trace intervals for `/api/internal/usage/record`,
segmented by `queue` / `queue_vercel`; retries are separate attempts even with the
same usage ID. Sweep boundaries for concurrency-over-time, peak and time-weighted
mean. Consumer completion timestamp minus CF `writer_duration_ms` or Vercel
`writer_http_duration_ms` is only an estimate: exclude validation/missing-config
paths, include failures and window-crossing calls, and account for missing
completions/crashes and logging uncertainty. Reconcile against writer traces;
incomplete intervals cannot establish exact concurrency or transport isolation.

Report offered/sent/success/rejected/unsent counts, publication acceptance/failure/
unknown outcomes, queue age **at consumer start**, full writer HTTP duration,
existing accounting event-age p50/p95/p99, actual ACKs/backlog, and DB resource
series over aligned intake **and drain** windows. Compare matched observations;
subtracting unrelated percentiles does not isolate network or queue latency.
For cold recovery, record last consumer activity, idle interval, first delivery,
backlog slope, retries and time to verified drain at the same cap/rate.

## Recovery limits and honest reconciliation

One SDK send awaits acceptance up to two seconds. The SDK has no send AbortSignal;
`acceptance_unknown` means the request may still finish or be cut off at request
lifetime end. `publish_failed` also does not prove a row cannot later appear.
The caller returns null without another transport/direct billing fallback and
retains existing best-effort Bouncer reporting. No producer outbox exists.
Publishing deduplicates by finalized usage ID, but persistence still deduplicates
billing; these are separate guarantees.

For normal gateway tests, retain request IDs/outcomes and all observable usage /
queue message / writer IDs. Reconcile observable accepted/successful IDs with
actual persistence and ACKs. Mark unknown, missing, duplicate, late, uncorrelated
and unreconstructable events explicitly; request manifests and aggregate logs
cannot reconstruct finalized IDs/costs or establish exact billing equality when
coverage is incomplete. Hold intake and preserve accepted work while investigating.
This limitation does not require building an outbox before a controlled bounded
staging test, but prevents a production durability claim.

Optional **queue→writer fixture diagnostic**: before publishing, an operator can
prepare and securely retain exact `UsageRecordRequestSchema`-validated finalized
fixture JSON with unique stable usage IDs, expected payer/cost and a manifest of
attempts/results, then publish through this package's Vercel publisher (which
signs the envelope) or the unchanged CF ingress. Do not send raw fixtures directly
to the Vercel topic. The
known original source permits reconciliation and approved same-ID replay. Do not
include credentials or real prompts, reuse already-billed IDs as a fresh workload,
or call fixture-only 100 events/s a gateway/inference 100rps result. This diagnostic
is optional and does not replace the ordinary gateway path above.

Consumer failures (`not_recorded`, invalid payload, timeout, 429/503, unavailable,
malformed/mismatched response) throw and are retried. Invalid events remain
observable by message ID without logging payloads. Vercel has **no built-in DLQ**:
at 20 deliveries or 24h expiry unresolved events can be discarded. Assign an
operator and retry/message-age alerts before load; inspect exact project/deployment/
topic failures early. Logs are not a replay store. Approved recovery must use an
actual retained finalized event with its original usage ID and reconcile existing
billing first; if no source exists, record an unresolved loss, never invent costs.
Receiving/deleting/republishing with queue tools is a separately authorized mutation.

## Switchback without stranding accepted work

For **new events only**, set `USAGE_QUEUE_TRANSPORT=cloudflare` (or remove it),
set `USAGE_QUEUE_ONLY_ENABLED=true`, and redeploy staging to select the existing
CF processing path. For existing direct accounting, remove/change the Vercel selector **and** set
`USAGE_QUEUE_ONLY_ENABLED=false`, then redeploy. That flag alone cannot disable
an exact `vercel` selector. The removed shadow-publishing flag has no effect. Verify the chosen
destination and writer before switching; never dual-publish a billed event.

Retain old Vercel deployments/consumers and compatible writer credentials/schema
until their pinned work ACKs/drains. Publishing opt-out does not disable the
consumer's independent staging guard. Inventory old caps and aggregate writer
load; keep observing CF source/DLQ queues as well. Deleting old consumers or
deployments is **not normal rollback**: it stops delivery and strands pending
work until expiry. Emergency containment requires separate authorization and an
honest residual/recovery record.

References: current [SDK](https://vercel.com/docs/queues/sdk),
[quickstart](https://vercel.com/docs/queues/quickstart),
[concepts](https://vercel.com/docs/queues/concepts),
[limits](https://vercel.com/docs/queues/pricing), and
[programmatic Vercel configuration](https://vercel.com/docs/project-configuration/vercel-ts).
Never run dev servers with real queue credentials during local unit checks;
development SDK/broker configuration can still publish hosted messages.
