# ADR 0005: Custom Auto Routers and Client-Served Models

## Status

Accepted and in effect. Supersedes [ADR 0003: Efficient Model Pools](./0003-efficient-model-pools.md)
since the cutover described below. Amends [ADR 0002](./0002-auto-routing-efficient.md) invariant 5
for custom routers only.

## Context

`kilo-auto/efficient` and `kilo-auto/frontier` route only to models that the Kilo gateway
serves. Owners (users and organizations) can narrow efficient to a pool of at most 10 gateway
models (ADR 0003). Two kinds of model cannot take part in auto routing:

- Local models (Ollama, LM Studio, other OpenAI-compatible servers on the user's machine). The
  gateway cannot reach them.
- Models outside the gateway catalog: provider keys held by the CLI, other providers, and
  direct-BYOK models that the gateway serves only with a Kilo-stored owner key.

The owner pool also mixes two products. Efficient is a platform product whose behavior differs
per owner, and a customizable router that is not named as one.

## Decision

Split auto routing into platform routers and custom routers.

- `kilo-auto/efficient` and `kilo-auto/frontier` use platform-selected pools. Users and organizations
  select their routing mode. Organization model policy still filters the platform candidates.
- A **custom router** is owned by a user or an organization. Its owner selects the benchmark
  difficulty, routing mode, default member, and model pool. The pool can contain gateway and client
  models. The Efficient or Frontier base selects the benchmark dataset and routing thresholds.
- The CLI routes client models. It calls a public `/v1/decide` route on the auto-routing worker,
  then dispatches the chosen model itself. The gateway routes custom routers for every other
  client, with gateway candidates only.
- The owner's CLI runs evals for every model that the platform key cannot serve. The benchmark
  worker grades the uploaded outputs.

## Model IDs

| Owner | Model ID | Resolution |
|---|---|---|
| User | `kilo-auto/custom/<slug>` | The authenticated user. |
| Organization | `kilo-auto/custom/org/<slug>` | The request's active organization context. |

- A slug matches `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`.
- `org` is reserved in the user namespace.
- An owner has at most 10 custom routers.
- An organization ID without an organization context is a `router_not_found` error.
- A member can use a personal router in an organization context. The organization pays, and the
  organization model policy removes denied gateway candidates.
- `kilo-auto/org` route targets can name an organization custom router of the same organization.
  The organization model catalog lists that organization's routers for both the fallback and
  custom-mode pickers, excluding personal routers. The gateway resolves the target with gateway
  candidates only.
- Personal model validation includes the authenticated user's custom routers, matching the model
  catalog. Missing routers and routers owned by another user return `unavailable`; a router lookup
  failure returns a service error so Cloud Agent can retry.

## Router definition

Custom router definitions live in PostgreSQL, table `auto_routing_custom_routers`:

| Column | Meaning |
|---|---|
| `id` | UUID primary key. |
| `owned_by_user_id` / `owned_by_organization_id` | Exactly one is set. |
| `slug`, `name` | Unique slug per owner; display name. |
| `base_router` | `efficient` or `frontier`. Selects the dataset, thresholds, and switch settings. |
| `mode` | `cost_per_accuracy`, `best_accuracy`, or `cheapest`. The only owner knob. `cheapest` picks the lowest estimated request cost among candidates that meet the base router's accuracy threshold; when none does, it picks the most accurate candidate. |
| `entries` | JSON array of 1–20 pool entries. |
| `default_entry_key` | Key of the pool entry used on a null decision. |
| `created_by_user_id`, `created_at`, `updated_at` | Audit fields. |

A pool entry is one of:

- `{ kind: 'gateway', model }` — a gateway model ID. Kilo-stored direct-BYOK IDs are allowed.
- `{ kind: 'client', provider, model, variants, capabilities, pricing }` — the CLI's own provider
  and model IDs. `variants` lists the CLI variant names (empty means one null variant).
  `capabilities` holds the context limit, input modalities, tool calling, and reasoning support.
  `pricing` holds per-token prices; absent pricing means $0.

The entry key is `gateway:<model>` or `client:<provider>/<model>`. The CLI registers client
entries from its own configuration (`kilo auto router add`). The web editor manages gateway
entries and can remove client entries.

Pool updates must include `defaultEntryKey`, even when the selected default does not change.
The web editor sends both fields when it changes the pool.

Write requests carry an explicit entry budget: model IDs up to 200 characters, provider IDs up to
100, at most 20 variants of up to 100 characters, at most 10 input modalities of up to 50
characters, context lengths up to 10,000,000, per-million-token prices that are finite and at most
1,000,000, and default entry keys up to 320 characters. The budget applies to create, update, and
client-entry registration; stored definitions and responses still parse rows written before it, so
the worker keeps serving them.

The serving worker reads definitions through its existing Hyperdrive binding with an isolate
cache. The web app owns create, update, and delete.

## Linked entries

Gateway and client entries can explicitly set `measuredAs` to a platform model ID whose
measurements they reuse. The entry keeps its own serving identity, capabilities, variants,
and owner pricing. A link is a live reference, not a copied measurement or a new benchmark
profile. The CLI may `suggestMeasuredAs`, but the owner must confirm the suggestion before
it becomes an explicit `measuredAs`; model-name similarity never creates an implicit link.

Saving a new or changed link requires an existing ready platform measurement for the selected
base router, and the web service fetches the platform measurements list before it takes the
owner's advisory lock, so a queued save never holds a pooled connection across that request.
Unchanged links with the same entry key are exempt; changing the base router revalidates every
link. An update that loses the race to a concurrent save re-validates the merged definition under
the lock. A client-entry registration instead refuses with a retryable `invalid_request` when the
base router changed concurrently, because its link was checked for the difficulty read before the
lock. Linked gateway entries do not enter platform benchmark admission. Once saved, a link serves
the newest ready measurement, including stale measurements and measurements whose model has since
disappeared from the gateway catalog.

Variants match by exact same name; the default variant matches only `null`. There is no
cross-variant fallback. Unmatched variants remain client-measured rather than inheriting a
different platform variant. Accuracy and latency come from the referenced measurement. Cost
is repriced using the measurement's token means (input, cached input/cache read, output, and
reasoning) and the entry's own pricing: client pricing supplied by the owner, or its own
model-catalog pricing for a direct-BYOK gateway entry. Null client pricing means $0. Older
summaries without token means use a blended-price ratio to scale measured cost.

## Measurements

The benchmark worker stays the only writer of measurements and routing tables.

| Entry | Who runs the eval | Who pays inference | Stored as |
|---|---|---|---|
| Gateway model in the platform pool | Platform container | Platform | Global `benchmark_profiles`, keyed by base router |
| Gateway model only in an owner pool | Platform container, after the owner's explicit confirmed request | One payer account per model request; platform coverage from the platform's join onward | Same global registry row; the request's D1 case receipts |
| Linked gateway or client entry | No new eval; live platform measurement | No new inference | Referenced global measurement, repriced for the entry |
| Any other entry, including Kilo-stored direct-BYOK IDs | Owner's CLI | Owner | Owner-scoped client profiles |

- **A pool save starts nothing.** Saving a pool (create, edit, alias move, subscription sync)
  validates it and records a registry row with both demand flags off: the row is serving
  bookkeeping and can be claimed by an explicit request, but it never queues measurement by
  itself. `POST /admin/profiles/register` still admits pairs, but only the platform list and an
  explicit paid request drive work; nothing re-admits a pool automatically.
- **An owner benchmarks explicitly.** The pool's benchmark surface asks for a quote (a read-only
  plan), shows the estimate and an advisory full-cost scenario, and starts only on the owner's
  click. The quote is a frozen plan over (engine identity, concrete model, variant, repetition,
  case); a pool edit, a case-dataset deploy, or an alias move invalidates the quote rather than
  changing what a confirmed one measures. A quote expires; each click consumes one quote, and a
  request that is still staging when its plan changes closes and asks for a fresh estimate.
- **Reuse is per slot, across repetition counts.** A slot is satisfied by one valid stored draw at
  this engine identity: successful exit, not timed out, above the case's minimum revision, and not
  preceded by the pair's invalidation. Repetition `r` is filled only by repetition `r`, so a prior
  run of any repetition count contributes its measured repetitions and one draw is never counted
  twice. A reused slot is not a new draw and never charges.
- **One payer per model request, billed just in time.** The gateway's native usage writer bills the
  request against exactly one attached payer account, and the worker records a read-only receipt
  for the signed usage id. The case store assigns that account deterministically round-robin among
  distinct active payer accounts at the moment the model request starts; a known pre-provider
  payment refusal detaches it and the next funded account may be assigned for the same model
  request. Once usage is accepted, or the attempt is uncertain, nothing reassigns it. A platform
  membership that commits first latches the case run as platform-covered: that coverage is sticky,
  no user account is attached afterwards, and a user charge already recorded stands. Platform
  joining later covers the later requests of that case, never the earlier ones retroactively.
  Usage is booked under a reserved project: `Auto-routing benchmarks / platform` for a
  platform-covered call, else `Auto-routing benchmarks / <user|org>/<pool-slug>/<routerId>`, with
  the concrete model on the usage row, so spend groups by pool and model without naming the owner.
  A usage id whose native receipt has not committed is reported `pending`, never free and never
  charged twice.
- **The quote's maximum is advisory, never a cap.** It is the sum of the per-slot estimates for
  the slots that request would pay for. Nothing is reserved, deducted or refunded; confirmed
  native spend may exceed it, is disclosed as an overage, and does not stop the request. Spending
  stops only on an owner pause or a payer that cannot pay, and the settled native amount is
  authoritative. An expired quote, or one whose pool, engine, case set or alias target changed,
  is never reused: the owner needs a fresh estimate.
- **A payment refusal skips only that payer.** The case store detaches a payer only after the
  gateway confirms that no provider call started. It can then select a different payer for the
  same request. A superseded selection is resolved again without detaching its payer. If no
  candidate remains, pause the case and require fresh confirmation. A call that may have reached
  the provider is never reassigned.
- **Pause removes one payer, not the generation.** Pausing detaches the request's payers. Other
  payers can keep the case running. If the last payer pauses, the store cancels the exact
  generation and stops the runner. Native charges for calls that already ran stand, even if the
  case fails, returns no usable result, or is cancelled. A refusal before dispatch charges nothing.
- **Permanent failure is proven, not counted per row.** Six consecutive failed attempts with no
  newly completed valid case make a retryable failure permanent. An attempt counts only when the
  run's own finalization saw its durable results and lane evidence: copied results are not
  progress, and cancellations, runs that never attempted the pair, and operator-fenced legacy work
  neither extend nor break the streak. A valid score of zero is progress. Terminal classes stay
  permanent at once, and an explicit admin re-admission is the only way back; a pool save cannot
  re-admit a pair.
- **The deploy changes no measurement.** The engine identity, the active measurement revision
  (revision 3), the case set, and the ranking policy stay as deployed. A deploy schedules no stored
  work again: it does not requeue pairs, consume a staged measurement activation, invalidate
  results, backfill a measurement, or rebuild an unchanged routing artifact. A later platform
  measurement, serving membership change, or explicit routing policy edit can publish a new table.
- Client profiles are keyed by (owner, base router, entry key, variant, engine identity,
  repetitions). They are never shared with another owner or promoted to the platform.
- Only router editors upload client results. For an organization, the editor roles are the
  organization owner, admin, and billing manager.
- Client latency comes from the uploader's machine.
- The engine identity stays `router:vN:datasetHash`. The CLI version is deliberately not part of
  it: the platform container pins its CLI version, and a CLI release must not force hours of
  client re-evals. A change that invalidates results, including a platform CLI bump that changes
  measurements, increments `BENCHMARK_ENGINE_VERSION`.

## Client eval protocol

`kilo auto eval <router>` runs missing and stale client pairs. It shows an estimate and asks for
confirmation. It requires Docker for every case. It runs each case in a local image built from
`node:22-slim` with the host's CLI version installed, the same base as the platform container.
The host's CLI version must be a published version; a source or branch build must pass
`--cli-version <version>`. Local endpoints are reached through `host.docker.internal`.

1. The CLI asks for a plan. The plan lists (entry, variant, case, repetition) items that have no
   current result.
2. The CLI fetches the prompt of each case. The prompt is the exact `kilo run` argument that the
   platform runner sends, built by one function for both paths, so client and platform rows are
   measured on identical input. The golden answer and the check never leave the benchmark
   worker.
3. The CLI uploads each output with cost, duration, exit code, and timeout state.
4. The benchmark worker grades the output with the platform graders. It bills judged-grader
   cost to the owner as usage model `auto-routing/grader`. An owner with an insufficient balance
   gets `insufficient_balance`.

Uploads are per case, so an interrupted eval resumes. A route becomes usable as soon as it has
graded cases; the Wilson lower bound penalizes thin coverage.

## Custom routing tables

- The table for a custom router contains every pool entry that has a measurement for the base
  router.
- Each pair uses its newest ready measurement. A measurement from an older engine identity
  still serves and carries `stale: true`. This applies to gateway and client rows in custom
  routers. Platform routers keep exact identity (ADR 0002 invariant 5).
- Thresholds, noise band, token profile, and switch settings come from the base router.
- Ranking: within the accuracy band, $0 candidates rank before paid candidates. $0 candidates are
  ordered by `effectiveLatency^1.5 / wilson^15`. Paid candidates keep the existing value formula.
- **Serving pins.** A completed request pins the usable concrete target its owner confirmed.
  Confirmation time orders callbacks; the pool must still match the confirmed version.
  When the stable catalog alias moves, save its previous concrete target on existing pools
  that have a ready shared measurement but no pin. Save the observations and the alias move
  in one transaction under the benchmark readiness lease. This does not start any measurement.
  Unmeasured entries follow the new target. Do not infer targets from before deployment.
  Both serving paths rank and dispatch the pinned target while it remains usable.
  If the catalog no longer serves it, dispatch the live target and show a warning.
  A ready replacement can be confirmed at no cost. Clients cannot write pins.
  A pool edit preserves the stored pin by entry key.
- **Benchmark output is shared, not per pool.** A ready measurement is global for its concrete
  target, base router, variant, engine identity, and repetitions. Every pool that uses that target
  (directly, through a `measuredAs` link, or through a saved serving pin) reads the same rows, so a
  new compatible result serves all of them without their owner requesting, confirming or paying for
  it. The per-pool request only ever pays for slots that had no reusable draw; nothing about it
  scopes the result.
- **A model row states whether it can serve in that pool.** The editor distinguishes a model that
  is active (served by a current or pinned measurement), benchmarking, paused with its reason,
  permanently failed, and an alias whose pinned target has gone so it needs re-benchmarking. A
  case whose payers cannot be charged is paused and carries that reason; there is no separate
  waiting state. A model with no measurement yet is simply not benchmarked, which is not an error.
  These indicators come from the shared registry and status reads, so a measurement that lands is
  reflected on every pool's next routing and status read, without a click or a charge. The exact
  re-read timing is an implementation detail, not a contract.
- **Adding a permanently failed model is refused.** The read-only add check resolves each asked
  model, alias included, to its exact gateway pairs at the target base router and refuses the add
  when any pair is permanently unavailable, naming the pair and the reason. A model already saved
  stays in the pool with that explanation; the check never admits a benchmark or spends.

## Serving

### CLI path

The new CLI calls `POST /v1/decide` only when the selected custom router has a client entry
that the CLI can serve. Otherwise it sends the custom model ID to the gateway.

- Authentication: `Authorization: Bearer <Kilo token>`, verified by the worker. The optional
  `X-KiloCode-OrganizationId` header selects the organization context; the worker checks
  membership.
- The worker checks the balance of the paying owner before classification and rejects with
  `insufficient_balance`. The classifier is billed as today (ADR 0002 billing policy).
- The request carries the raw OpenAI-format `messages` and `tools`, the session ID, and the
  client entries this CLI can serve. The worker runs the gateway's normalization.
- The worker drops client entries that the CLI did not list.
- Organization model policy (group-policy grants, provider limits, the deny list, and the
  data-collection rule) runs in the gateway. The worker asks the gateway for the denied gateway
  entries through an internal endpoint, so one implementation applies on both paths. On a
  transient failure, the worker retries once. If the lookup still fails, listed client entries
  can serve; otherwise the worker returns a retryable error, never `custom_router_unavailable`.
- Users in a blocked email domain get `forbidden` on every public route. If the blocked-domain
  list cannot load, the worker returns a retryable error.
- The response names the chosen entry and variant, and a signed decision ID.
- When the pick is a gateway model, the CLI calls the gateway with the concrete model ID and the
  `X-Kilo-Auto-Decision` header. The gateway verifies the decision, checks that the user,
  organization, model, and variant match, and records the custom router ID as `auto_model`. A
  decision for a client entry or a `kilo-auto/*` model is rejected.
- Client picks are recorded only in the worker decision log. The CLI reports no client usage.

Authentication, organization membership, and balance checks shared by the gateway and the
worker live in an internal package.

### Gateway path

Older CLIs, OpenClaw, and API clients send the custom model ID to the gateway. The gateway calls
the internal `/decide` with the custom router reference. The worker considers gateway entries
only. The gateway passes `router_not_found` and `custom_router_unavailable` to the caller; any
other worker failure is a retryable `auto_routing_unavailable`. The gateway does not fall back to
a model outside the pool. Organization deny-list IDs are normalized and expanded to the exact
gateway candidate IDs, including suffixed variants, before calling the worker; the gateway also
rejects a worker pick that matches any denied candidate.

The `kilo-auto-frontier-routing` flag gates only the platform frontier table. A custom router with
a frontier base serves its own pool and does not read that table, so the flag does not apply.

### Null decisions

A null decision uses the default member. If this client cannot serve the default member, it uses
the first pool entry that this client can serve. If no entry is available, the request fails
with `custom_router_unavailable`. A custom router never routes outside its pool.

## Rollout and cutover

1. Deploy contracts, benchmark support, web, serving, and gateway integration behind the
   `kilo-auto-custom-routers` flag. Publish the CLI after cloud verification. The flag was
   rolled out to everyone and removed before the cutover; custom routers no longer have a gate.
2. Deploy the overlap migration separately from graduation. Keep legacy serving, settings,
   and storage. Run the silent conversion before sending the advance notice.
   - Each saved pool becomes an owner-scoped `efficient` custom router.
   - The migrated row is canonical for both model IDs. Edits do not update separate copies.
   - Copy the owner's configured mode, using the default when none is saved.
     Custom modes are independent of platform mode settings and organization mode inheritance.
     Platform mode settings remain stored and editable throughout the transition.
   - Keep the migrated slug stable and reject deletion until graduation; benchmark difficulty remains editable.
   - Migrated owners and authorized organization editors keep using their router.
   - New legacy pool saves also convert before acknowledging success, including owners missed
     by an earlier scan.
3. Resolve every conversion exception and verify both model IDs before the blast.
   Conversion sends no email. Repeated conversion must not overwrite edits.
4. Run the notice script in dry-run mode. Review the live cohort, then explicitly send.
   Use a staffed cutover window and allow a full notice period before graduation.
   Retain the private campaign directory across retries. Provider acceptance is not proof of
   inbox delivery; inspect delivery failures and suppressed recipients separately.
   The notice tells organization billing contacts to share the organization model ID with members
   and update shared integrations.
5. During the notice period, both IDs use the shared pool. Repeat discovery before cutover.
   Refresh the reviewed campaign for new recipients without resetting delivery history.
   Give late recipients the full notice period; postpone cutover when necessary.
6. At graduation, deploy only the cutover:
   - Efficient stops reading owner pools and overlap aliases. Its pool becomes platform-selected.
   - Platform modes remain selectable, retaining organization, personal, then default precedence.
   - The custom model ID retains its own pool and independently selected mode and benchmark difficulty.
   - Remove legacy pool settings/UI, custom-mode inheritance compatibility, and temporary pool edit guards.
     Keep the platform mode endpoint, mode-only UI, and persisted mode storage.
   - Do not reconvert pools or resend the advance notice.
7. Retire one-time pool conversion tooling after verification. Preserve the existing mode Durable
   Object, its binding, namespace, and saved modes. Do not apply a `deleted_classes` migration.

Owners with a configured mode but no saved pool are outside the pool migration and notice cohort.
Their platform mode settings remain valid and editable after cutover. They need no custom router
to keep selecting a platform routing mode.

### Operator commands

#### Historical pool conversion (before tooling retirement)

The conversion script and its worker endpoint are removed at this revision. The commands below
document the pre-retirement procedure and require the #7808 cutover revision on `main`
(`c03b06b1cae03f5f400119133469813bba27ef62`), not this checkout. Do not deploy the retired
conversion endpoint again after cutover.

From that revision, run from the repository root with approved production credentials.
The default is read-only; `--apply` is required for conversion.

```sh
pnpm --filter auto-routing exec tsx scripts/convert-owner-pools.ts --dry-run
pnpm --filter auto-routing exec tsx scripts/convert-owner-pools.ts --apply
pnpm --filter auto-routing exec tsx scripts/convert-owner-pools.ts --dry-run
```

The historical scanner requires `CLOUDFLARE_API_TOKEN` and `INTERNAL_API_SECRET`.
Retain every report. Resolve unreadable, invalid, unmatched, missing-owner, collision, and
router-cap findings before declaring the cohort complete. Interrupted writes retain a recovery
fence; retry the conversion on the pre-retirement deployment rather than clearing the fence manually.
If a scan response is lost, recover owner keys from the structured
`auto_routing_owner_pool_conversion_scan` event's `readFailedOwners`, `invalidPoolOwners`,
`invalidModeOwners`, `needsAttentionOwners`, and `notPostedOwners` arrays before declaring the
run clean; a retry can skip owners already marked converted.
`--limit` controls the page size, not the total number of owners.

#### Advance notice (before graduation)

These commands belong to rollout step 4, not tooling retirement. Do not resend the advance
notice after cutover.

Set `CUTOVER_AT` to a future timestamp with an explicit timezone.
Set `STATE_DIR` to a private, durable campaign directory outside the checkout.
The script requires `POSTGRES_SCRIPT_URL`; normal database configuration remains required.
Sending also requires the production Mailgun configuration and `VERCEL_TARGET_ENV=production`.

```sh
pnpm --filter web script src/scripts/notify-auto-routing-pool-users.ts --cutover-at "$CUTOVER_AT" --state-dir "$STATE_DIR"
pnpm --filter web script src/scripts/notify-auto-routing-pool-users.ts --cutover-at "$CUTOVER_AT" --state-dir "$STATE_DIR" --send
```

The dry run writes a private hashed plan, but sends nothing.
Live personal owners and direct or inherited organization billing contacts receive one grouped
notice per address. Soft-deleted users are never owners or contacts. An owner with no live, valid
contact is not sent. The plan saves its private hash, and the output reports the unreachable count.
Reuse the same timestamp and directory. `--refresh-plan` reviews cohort changes without resending
successful targets. Resolve unknown delivery outcomes against provider records with
`--reconcile-target` and `--reconcile-outcome`; use `--help` for the exact recovery procedure.
Do not discard a used plan or remove its lock until the prior sender has stopped.
A changed cutover date requires a separately reviewed update campaign, not an ordinary retry.
If cutover passes during sending, the script stops before the next recipient and returns the
saved partial summary with a nonzero exit status. Pending recipients stay pending; sent and
unknown outcomes retain their history. Do not send an expired advance notice. Preserve the
original campaign for reconciliation, and review a future campaign containing only pending or
provider-confirmed `not_sent` recipients. Explicitly exclude sent and unknown targets; copying
the entire original cohort into a new directory would notify successful recipients again.

### Cutover verification

- Verify a mode-only owner and an owner with a converted pool.
- Save each platform mode, restart the worker, and read the saved mode again.
- Clear the organization override and verify personal-mode inheritance.
- Clear the personal mode and verify the default.
- Verify Efficient selects from the platform table despite a retained legacy pool.
- Edit a non-default custom-router member without changing the default member.
- Reload the settings page and verify the custom pool, mode, and benchmark difficulty.
- During tooling retirement, reuse the persisted namespace and verify these settings again.
- Confirm the retired conversion endpoint returns not found while mode reads and writes remain available.

## Paid benchmark deployment

This is the operator choreography for the explicit paid flow. Do not treat any step as already
proved for a given release: run every check on the release being deployed and record counts and
pass/fail, never customer data, model output, credentials, or tenant identifiers.

1. **Freeze the release.** Confirm the branch is the reviewed head and that the engine identity,
   the active measurement revision, the case dataset, and the ranking policy are unchanged from
   what is deployed. A raise of the engine identity or measurement revision is a separate,
   budgeted change, not part of this deploy.
2. **Rehearse on non-production data.** Take a bounded read-only copy of the benchmark D1 database
   and only the PostgreSQL rows the flow needs, keep it on the single test host, and apply the
   additive migrations to the copy. Run both a normal dispatch tick and the unchanged daily
   reconciliation over it, including a pool that already has correct measurements and no pending
   work. Compare, before and after: sorted result counts and digests, published
   routing-artifact bytes, the runnable slot set, registry statuses, request statuses, payer
   assignments, and usage receipts. Also compare, per saved pool, the routing table bytes and the
   classification of each model row (active, benchmarking, paused, permanently failed, alias
   re-benchmark needed). Pass when no stored measurement is scheduled again, no artifact changes
   for an unchanged pool, every already correctly benchmarked pool keeps the same table and needs
   no quote or click, and no request transitions on its own. Report counts and pass/fail only.
   Delete the exact copies and local artifacts afterwards and log the deletion.
3. **Enter the operator hold and cancel every legacy run.** An operator acquires the dispatch pause
   token before any migration or deploy, so no dispatcher claims work during the rollout. The
   deploy wrapper retains that token and fails closed if it changes or expires; do not release it
   until step 6 passes. While the hold is retained, run `scripts/legacy-cancel.mjs` from
   `services/auto-routing-benchmark` in the mandatory order: `--dry-run --remote` to review the
   exact statements, `--apply --remote --baseline-out <path>` to cancel, then
   `--verify --remote --baseline <path>` as the last pre-deploy gate. Deploy only on exit `0`:
   `3` means the lease guard refused, `4` means live work remained or a protected artifact moved
   (while still PRE-cutover, re-apply and re-verify; after migration 0038 do not re-run — see
   step 5), and `5` is a D1/transport error. Pass the exact held token
   (`--expect-token operator-pause-<name>`) and a remaining-lease floor (`--min-remaining-ms`);
   this release does not use a broad `token LIKE 'operator-pause-%'` check, because it would
   accept another operator's pause. The cancel fences every unfinished legacy run and its chunks,
   parks profile and re-measure claims, and preserves every completed result, summary, lane record,
   routing artifact and finished profile row; a cancelled run is marked `failed` with an
   operator-cancel marker, not a model failure. A run the old image admits inside the window keeps
   the same guarantee only through the worker's own retirement: any decider run whose
   `admission_marker` is `NULL` is never initialized, measured or published, whatever its
   `started_at`, so a post-cutover timestamp cannot make legacy work claimable. Migration
   `0038` adds that column with no backfill: existing rows stay `NULL` and are treated as legacy.
4. **Apply and deploy.** Apply the additive D1 migrations and the PostgreSQL pool-entry index.
   The index limits alias promotion to pools that contain an affected alias.
   PostgreSQL keeps the existing native usage schema. D1 migration `0038` creates the case
   fence, request tables, receipts, and attempt history, and adds `benchmark_runs.admission_marker`.
   The readiness migration adds one epoch row per base router. It does not invalidate results or
   rebuild a table. Each custom routing request reads that epoch by key before reusing cached
   rankings. A shared gateway benchmark changes the epoch with its ready profile, so the next
   request can use that result. Owner-local client measurements remain separate and can take up to
   the existing cache limit of 60 seconds to appear. If the epoch is unavailable, the serving
   Worker reads the full pool table and shares that read with concurrent requests. If both reads
   fail, it returns a retryable error instead of serving an unverified cached table.
   The wrapper holds dispatch while it drains active work, applies migrations, deploys the
   benchmark Worker, and waits for a changed container image. Verify the platform funding
   organization and its executor membership before dispatch resumes. The Worker, web, and
   gateway deploy jobs can complete in different orders. The operator hold fences benchmark
   dispatch, not ordinary routing.
5. **Prove legacy work is fenced and existing pools are unchanged.** With the worker live and the
   hold still held, read (do not write) the request, registry, and run tables: every legacy run is
   terminally cancelled (none queued, paused, or resumable), no pre-cutover user run resumes, no
   queued owner subscription becomes a paid request, no legacy profile is pending for the drained
   queue, and no stored measurement is requeued. Use `scripts/legacy-cancel.mjs --legacy-residue
   --remote` for the late legacy check: it is read-only, defined only for the post-cutover schema,
   and reports legacy work (a run whose `admission_marker` is `NULL`, the same predicate the paid
   Worker uses) separately from paid work, exiting `4` if a legacy run is `running` or owns an
   unfinished chunk. **Do not re-run `--apply`, `--verify` or `--dry-run` after the migration** —
   they refuse on a post-cutover database (exit `4`, no writes), because on that schema a
   `status = 'running'` cancel cannot distinguish a legacy run from one a user explicitly
   confirmed through the paid flow. A nonzero legacy count means keep the hold and escalate. A paid
   request that is `preparing`/`active` with a running case while the hold is retained is an
   expected user confirmation — a legitimate click under the hold — and is never a reason to
   cancel; confirm only that no paid work is spending while the hold is in place. Check that a pool
   save or alias scan creates no request, and that an already correctly benchmarked pool keeps its
   routing table and model indicators without a quote or click.
6. **Release and verify.** Before release, confirm the benchmark Worker, serving Worker, web, and
   gateway each contain the merged head. Confirm the benchmark Worker answers the serving
   Worker's readiness check. One successful deployment proves nothing about the others.
   Until the serving Worker and gateway deploys are both verified, an older gateway verifies
   the unchanged `v1` token and ignores the optional alias proof fields because its parser
   strips them, so strict signed alias-retirement verification must not be claimed.
   Then release only the exact pause token passed to `--expect-token`, never a broad `LIKE` match.
   Verify read-only:
   platform dispatch resumes, a pool quote is `empty` or `ready` without starting work, a fresh
   confirmed request produces its cases, and the usage receipts and admin payer breakdown match
   the requests that ran. A failed check keeps the hold and stops the rollout; do not compensate by
   editing balances, request rows, or registry statuses by hand.

Roll back by restoring the previous worker and web releases. The migrations are additive, so a
previous release ignores the new tables; leave stored results, requests, and receipts in place.

## Invariants

1. The benchmark worker is the only writer of measurements and tables (ADR 0002 invariant 1).
2. A custom router never routes outside its pool, including on a null decision.
3. Golden answers and checks never leave the benchmark worker.
4. Client measurements are owner-scoped and never affect another owner's routing.
5. Platform routers require exact engine identity; custom routers serve the newest measurement
   and flag it stale.
6. Inference is billed per model request to one payer account, and user work exists only after an
   explicit confirmed request. A platform pool membership that commits before the request covers it
   from then on; it never covers a charge already recorded. Linking an entry never starts new
   platform inference. The owner pays for client inference, judged grading of client outputs, and
   classification.
7. A custom pool save, alias move, subscription sync, schedule, retry, or deploy starts no
   measurement without an owner confirmation. The platform still measures new members and moved
   platform aliases automatically. Deployment never requeues an existing measurement.

## Consequences

- The auto-routing worker gets public routes with user authentication. It needs the token
  secret, a decision-signing secret shared with the gateway, and balance reads.
- The benchmark worker gets owner-scoped request tables, a case fence shared by every measuring
  path, and the durable accounting receipts the admin console reads.
- Every user prompt on the CLI path goes to Kilo for classification, including routers with only
  local models. A local-only router is not private.
- A dataset change makes rankings mix datasets in custom routers until re-evaluation.
- Client latency reflects one machine. Organization members on other hardware see the uploader's
  ranking.
- An owner's benchmark spend follows the models they measured: a shared model request bills one
  attached account, and the pool that joins later may see only platform-covered requests.

## Alternatives considered

- **Gateway proxies to user endpoints.** It cannot reach local models and stores user secrets
  server-side.
- **Classification in the CLI.** It loses the measured System One classifier.
- **Grading in the CLI.** It publishes the golden answers.
- **Exact identity for custom routers.** A dataset change removes client entries from routing
  until an eval of several hours completes.
- **CLI version in the engine identity.** Every CLI release makes every client row stale.
