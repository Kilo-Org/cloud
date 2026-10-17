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

- `kilo-auto/efficient` and `kilo-auto/frontier` are platform-owned. Owners cannot set a pool or a
  mode on them. Organization model policy (`deniedModelIds`) still filters their candidates.
- A **custom router** is owned by a user or an organization. Its owner sets a name, a slug, a
  base dataset, a mode, a default member, and a pool of at most 20 models. The pool can contain
  gateway models and client models.
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
  The gateway resolves the target with gateway candidates only.

## Router definition

Custom router definitions live in PostgreSQL, table `auto_routing_custom_routers`:

| Column | Meaning |
|---|---|
| `id` | UUID primary key. |
| `owned_by_user_id` / `owned_by_organization_id` | Exactly one is set. |
| `slug`, `name` | Unique slug per owner; display name. |
| `base_router` | `efficient` or `frontier`. Selects the dataset, thresholds, and switch settings. |
| `mode` | `cost_per_accuracy` or `best_accuracy`. The only owner knob. |
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

The serving worker reads definitions through its existing Hyperdrive binding with an isolate
cache. The web app owns create, update, and delete.

## Measurements

The benchmark worker stays the only writer of measurements and routing tables.

| Entry | Who runs the eval | Who pays inference | Stored as |
|---|---|---|---|
| Gateway model that the platform key can serve | Platform container | Platform | Global `benchmark_profiles`, keyed by base router |
| Any other entry, including Kilo-stored direct-BYOK IDs | Owner's CLI | Owner | Owner-scoped client profiles |

- Platform-paid admission is limited to 20 new models per base router per owner per rolling 24
  hours. Ready and pending models do not count. A save over the limit gets `quota_exceeded`
  (HTTP 429) with `retryAt`, and every other validation runs before admission.
- The frontier base gets an owner queue, as the efficient base has today.
- Client profiles are keyed by (owner, base router, entry key, variant, engine identity,
  repetitions). They are never shared with another owner or promoted to the platform.
- Only router editors upload client results. For an organization, the editor roles are the
  organization owner, admin, and billing manager.
- Client latency comes from the uploader's machine.
- The engine identity stays `router:vN:datasetHash`. The CLI version is deliberately not part of
  it: the platform container also tracks the latest CLI without changing identity, and a CLI
  release must not force hours of client re-evals. A change that invalidates results increments
  `BENCHMARK_ENGINE_VERSION`.

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
a model outside the pool.

The `kilo-auto-frontier-routing` flag gates only the platform frontier table. A custom router with
a frontier base serves its own pool and does not read that table, so the flag does not apply.

### Null decisions

A null decision uses the default member. If this client cannot serve the default member, it uses
the first pool entry that this client can serve. If no entry is available, the request fails
with `custom_router_unavailable`. A custom router never routes outside its pool.

## Rollout and cutover

1. Ship custom routers behind the PostHog flag `kilo-auto-custom-routers`. The flag gates router
   creation, the `/models` listing, and the web editor. A router can exist only for a flagged
   owner, so the gateway and the workers need no flag check.
2. At graduation, one deploy does the cutover:
   - Each saved owner pool becomes a custom router with slug `efficient`, base `efficient`, the
     owner's configured mode, and the first pool entry as the default member.
   - Owner settings that have a mode and no pool are dropped.
   - A converted router keeps only its own owner's mode. The old per-field inheritance (an
     organization mode over a member's personal pool) does not carry over.
   - An owner whose existing `efficient` router holds other entries, or who is at the router cap,
     is reported to the operator and not converted.
   - Efficient stops reading owner settings. The owner settings routes and UI are removed. ADR
     0003 becomes Superseded.
   - Owners whose pool was converted get a notice with the new model ID.
   - The flag is removed; custom routers are available to every owner.
3. A follow-up deploy, after the conversion has run, deletes the owner settings Durable Object.

## Invariants

1. The benchmark worker is the only writer of measurements and tables (ADR 0002 invariant 1).
2. A custom router never routes outside its pool, including on a null decision.
3. Golden answers and checks never leave the benchmark worker.
4. Client measurements are owner-scoped and never affect another owner's routing.
5. Platform routers require exact engine identity; custom routers serve the newest measurement
   and flag it stale.
6. The platform pays only for inference that the platform key serves. The owner pays for client
   inference, judged grading of client outputs, and classification.

## Consequences

- The auto-routing worker gets public routes with user authentication. It needs the token
  secret, a decision-signing secret shared with the gateway, and balance reads.
- The benchmark worker gets owner-scoped tables and a second owner queue.
- Every user prompt on the CLI path goes to Kilo for classification, including routers with only
  local models. A local-only router is not private.
- A dataset change makes rankings mix datasets in custom routers until re-evaluation.
- Client latency reflects one machine. Organization members on other hardware see the uploader's
  ranking.

## Alternatives considered

- **Gateway proxies to user endpoints.** It cannot reach local models and stores user secrets
  server-side.
- **Classification in the CLI.** It loses the measured System One classifier.
- **Grading in the CLI.** It publishes the golden answers.
- **Exact identity for custom routers.** A dataset change removes client entries from routing
  until an eval of several hours completes.
- **CLI version in the engine identity.** Every CLI release makes every client row stale.
