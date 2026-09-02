# Kilo Isolate Review Worker

Experimental standard GitHub pull-request reviewer. Each review executes in one
Durable Object with a filesystem-only `@cloudflare/computer` workspace and a
`@cloudflare/think` parent. Repository access is read-only; only guarded parent
GitHub tools may publish. Web prepares saved settings and canonical policy, but
candidate execution uses no container, shell or Kilo CLI.

Design and current limits: [`DESIGN.md`](DESIGN.md). Historical fixture/pilot
evidence: [`E2E.md`](E2E.md); current runner usage is below.

```sh
pnpm --filter kilo-isolate-review-worker typecheck
pnpm --filter kilo-isolate-review-worker lint
pnpm --filter kilo-isolate-review-worker test
```

## Organization-allowlisted queued rollout

Normal webhook, manual provider-output, retrigger, completion-drain and cron paths
share `dispatchReservedReview`. New attempts use isolate only for standard GitHub
App reviews belonging to an organization exactly listed in PostHog flag
`code-review-isolate-organizations`: the flag must be boolean `true` and its entire
payload must validate as `{organizationIds: string[]}` containing UUIDs. Missing,
false, nonboolean, malformed or unavailable data selects legacy. GitLab, Bitbucket,
personal/missing-organization contexts, council, GitHub Lite and local dashboard
output remain legacy. Unsupported contexts do not need flag evaluation.

Selection is persisted per attempt before outbound execution. An active attempt
never migrates when the flag changes. Queued isolate uses `runId = attemptId` and a
separate Durable Object namespace prefix. Admission requires backend authentication,
a one-hour purpose-bound execution bearer and canonical authority for the exact
organization/integration, snapshot and fence generation. Status/cancel use separate
operation-scoped authentication, not refreshed inference credentials. An ambiguous
admission never falls back to legacy or creates another logical execution.

Both backends use the same `cloud_agent_code_reviews` queue. Publication state is
stored on the existing attempt in `publication_state`; a pending review's
`blocked_by_attempt_id` records its dependency. There are no separate publication
or blocked-successor tables, and internal publication state is not returned by
public attempt listings.

An isolate-owned fence protects the normalized GitHub repository/PR across review
rows and backend changes. Cancellation, canonical terminal status, timeouts and
reservation expiry cannot release unresolved provider writes. Release requires
Worker quiescence plus completion or definitive suppression of candidate-owned web
publication. Exact-target summary/history/guidance/usage work shares that barrier;
canonical authorization permits reuse of a validated legacy summary without
weakening direct experimental ownership rules. Queued analysis is full, not an
automatically selected incremental continuation.

Blocked successors release their queue reservation and retain a persisted blocker.
Release wakes them; bounded cron recovery also finds them beyond the ordinary
pending window. Unrelated PRs can proceed. Tombstones, notification retries and
unresolved operations survive eviction and transcript/credential cleanup. Released
fences and historical legacy reviews never permanently assign a backend to a PR.

**Scoped guarantee:** these barriers cover new isolate-owned work, not physical
quiescence of existing legacy publishers. Legacy cancellation can report success
when interruption fails; legacy completion can dispatch the next review before its
summary update finishes. Those pre-existing races are deferred and are not treated
as isolate safety evidence. No historical-review clearance or global drain is
required, and no legacy execution/provider instrumentation is added.

Local proof is application integration with real PostgreSQL, selector, dispatcher,
preparation and authenticated callbacks, plus separate local Worker/DO contract
tests. Provider/model/transport boundaries are faked and unexpected fetches rejected;
this is not deployed E2E or live review-quality evidence. Focused checks include:

```sh
USE_PRODUCTION_DB=false pnpm --filter web test --runInBand --runTestsByPath src/lib/code-reviews/queued-isolate-entrypoints.test.ts src/lib/code-reviews/queued-isolate-lifecycle.test.ts
pnpm --filter kilo-isolate-review-worker test
pnpm --filter kilo-code-review-worker test
pnpm --filter web lint
pnpm --filter web typecheck
```

Use only a human-confirmed disposable PostgreSQL project. Preserve its pinned
container through `--no-recreate` startup and subsequent checks. Fresh-bootstrap
verification sends SQL with explicit `psql -X -A -t -v ON_ERROR_STOP=1 -c` arguments,
asserts database absence before creation, presence before/after migration, and
absence after cleanup on that same container. Do not rerun `pnpm test:db` or
`pnpm drizzle:verify-bootstrap` after pinning: those wrappers can resynchronize or
recreate infrastructure. No deployment or live flag change is implied by local proof.

## Local development

This worker is not part of core. Start it with the local stack so inference
hits this worktree's Next.js `/api/openrouter` proxy:

```sh
KILO_PORT_OFFSET=auto pnpm dev:start isolate-review auto-routing
pnpm dev:status --json
```

Reuse an existing stack if it already includes these services. The isolate
selection includes the Git token service; `auto-routing` supports
`kilo-auto/efficient`. `dev:start` writes `KILO_GATEWAY_URL` from
`.dev.vars.example` to the offset Next.js port. Mint a token for a funded user
that already exists locally without printing it. Ensure `.env.local` sets
`NODE_ENV=development`: the seed loader overrides shell values, and a
production-tagged bearer will be rejected by the development Worker.

```sh
export KILO_TOKEN="$(NODE_ENV=development pnpm -s dev:seed app:api-token \
  you@example.com --expires-days=1 --json | jq -er .token)"
```

For real GitHub requests, leave `GITHUB_API_URL` and `GIT_CLONE_URL_TEMPLATE`
blank in `.dev.vars`; fixture routing must not remain enabled.

### Prepared development APIs

Use the existing human bearer at `$WEB_URL/api/trpc/<procedure>`. Personal
procedures use the `personalReviewAgent` prefix; organization equivalents use
`organizations.reviewAgent` and require `organizationId` in every input:

| Method | Procedure suffix | Input |
|---|---|---|
| POST | `createIsolateReview` | Strict high-level request below |
| GET | `getIsolateReview` | `{runId}` |
| GET | `getIsolateReviewTranscript` | `{runId}` |

```sh
curl --fail-with-body -sS \
  -X POST "$WEB_URL/api/trpc/personalReviewAgent.createIsolateReview" \
  -H "Authorization: Bearer $KILO_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://github.com/OWNER/REPO/pull/123","modelSlug":"kilo-auto/efficient","dryRun":true}'
```

These are non-batched tRPC requests: plain JSON POST bodies, JSON-encoded `input`
query parameters for GET, and responses under `.result.data`. Creation returns
`{runId, preparation, inference}`, not credentials or the rendered prompt.
It prepares **and starts**; dry-run prevents publication, not inference charges.

All three candidate procedures require `NODE_ENV=development`, **absent**
`VERCEL_ENV` (even an empty value is rejected), and a configured
`ISOLATE_REVIEW_WORKER_URL`. They do **not** depend on `DEBUG_SHOW_DEV_UI`.
Personal execution uses the requesting human; organization execution uses an
already-existing unblocked Code Reviewer bot and organization billing scope.
Organization creation retains member/subscription mutation gates; reads require
membership and recheck execution-user/organization ownership. No bot, canonical
review row, production analytics attempt or Cloud fix link is created.
Web mints a one-hour purpose-bound `isolate-review` token with reviewer attribution
for the execution user; it never returns that token to the caller.

Allowed creation fields are `url` (canonical GitHub PR URL, up to 2,048 characters),
optional `modelSlug` (1–512), nullable `thinkingEffort` (model variant key, up to
50 letters), additive `instructions` (up to 4,000 characters), `expectedHeadSha`
(full lowercase 40-hex admission assertion), `previousRunId` (UUID), `reviewMode`
(`full` by default or `incremental`), and `dryRun` (default true). Unknown fields
are rejected: no raw prompt, credentials, caller-
selected user/installation identity or council configuration. Organization scope
comes only from the authorized organization procedure.

Settings are frozen during preparation:

- Missing/invalid saved configuration uses the shared default factory, currently
  Sonnet 5, balanced style and disabled `REVIEW.md`.
- Without `modelSlug`, an exact, nonempty repository override replaces the global
  **model/effort pair**; otherwise the global pair and existing Sonnet 4.6 fallback
  apply. An explicit model overrides both; omitted/null effort means model default,
  never inherited effort. Standalone effort is rejected.
- Canonical rendering preserves style, ordered focus areas, sanitized saved custom
  instructions and separate additive manual instructions. `REVIEW.md` is read only
  when `disable_review_md === false`, from the captured base-tip SHA, normalized
  with its 10,000-character cap/truncation notice; `@` imports are not expanded.
- Provider-mode policy and eligible analytics instructions apply even in dry-run.
  Council is cleared. Manual analysis defaults to full review; `previousRunId`
  alone retains the existing ownership-proven summary-reuse behavior. Incremental
  analysis requires explicit `reviewMode: "incremental"`. Oversized prepared prompts
  are rejected at 64,000 characters, not silently shortened.

The owner-scoped catalog selects native Anthropic, OpenAI Responses, OpenRouter or
compatible transport and validates the exact variant. Unknown/unavailable or
incompatible settings fail before inference. Auto aliases retain router-owned
effort/sampling. Adapter fixtures and pinned CLI differences are documented in
[DESIGN §6](DESIGN.md#6-the-model), not claimed as live provider equivalence.

### Incremental reviews and on-demand history

Add `"reviewMode":"incremental"` and `"previousRunId":"<completed-run-uuid>"`
to the prepared creation request. A baseline must be a completed prepared review
of the same execution user, organization, repository, PR, installation and app,
within its existing 24-hour retention. Completed dry-runs qualify. Legacy runs
without retained `summaryContent` do not qualify and select full review instead.

Web selects the effective mode before rendering and hashing the prompt. Changed
settings, policy, REVIEW.md or base snapshots, unchanged/rebased heads, unavailable
baselines, and unproven or oversized comparisons select full review with an explicit
`fallbackReason`. Incremental comparison requires an ancestor previous head and
fewer than 300 changed files. Worker admission independently verifies incremental
claims; a later mismatch fails admission rather than silently changing scope.

`reviewSelection` identifies the actual scope. `pr_diff` and `pr_file_patch` default
to that scope; `comparison: "current-pr"` retrieves the full PR evidence used for
inline anchors. Publication always targets current PR RIGHT-side lines at the
captured head. Prior findings require current-code verification, not blind copying.
Analysis context never grants permission to modify an existing GitHub summary.

`pr_history`, `pr_commit`, and `pr_file` with `revision: "history"` retrieve bounded
history on demand. Only captured or history-authorized commit SHAs are accepted;
there is no arbitrary ref access or full-history clone. Request and discovered-SHA
budgets are persisted and shared with children. History limitations are explicit,
not proof of empty history. See [DESIGN §10](DESIGN.md#10-tools) for the limits.
Unprepared requests cannot request incremental mode.

## Manual comparisons

### Manual comparison runner

`scripts/compare-reviews.ts` runs one operator-controlled pair, not a cohort or
scheduler. **Without `--run`, it only validates CLI inputs and writes a private
preflight artifact: no API, GitHub, inference, or service calls.** There is no
preparation-only API: `createIsolateReview` prepares and starts together.

Use an existing private parent directory. Each `--out` must be a **new** directory;
it is created as 0700, with versioned `{version: 1, data: ...}` files at 0600. Existing
evidence is never overwritten. Inputs must be private regular files (0600), not
symlinks. Keep source, prompts, transcripts, labels and reports private.

```sh
pnpm exec tsx services/isolate-review/scripts/compare-reviews.ts --help
pnpm exec tsx services/isolate-review/scripts/compare-reviews.ts \
  --candidate-url "$CANDIDATE_PR" --expected-head-sha "$HEAD_SHA" \
  --web-url "$WEB_URL" --model kilo-auto/efficient \
  --out "$PRIVATE_PARENT/preflight-1"
```

`WEB_URL` must be this worktree's already-running local Next.js origin, using its
reported port. Execution requires an existing `KILO_TOKEN` in the environment and
an already-authenticated `gh` CLI with repository read access. The runner neither
mints credentials nor changes credits, saved settings, services or deployments.
`gh api` is used only for bounded, paginated **GET** snapshots; it never mutates
PRs/comments. Only explicitly opted-in reviewer APIs may publish/reuse summaries.
The runner never creates branches/PRs, deletes comments, retries creation POSTs or
bypasses billing.

Add `--run` and choose another output directory for a candidate **dry-run**.
Dry-run still performs billable inference. Omit `--model` to resolve the saved
repository/global model and effort once in candidate creation; the control then
receives that exact explicit pair. `--thinking-effort KEY` requires `--model`;
omission means model default, not inherited effort. Auto aliases, including
`kilo-auto/efficient`, are labeled **end-to-end**, never engine-only comparisons.
`--instructions-file PRIVATE_TEXT_FILE` supplies only additive instructions;
saved instructions remain server-owned. `--organization-id UUID` switches both
create procedures and candidate reads to `organizations.reviewAgent`.

For quality comparison, candidate dry-run completes first, then the explicit
provider-publishing control runs against the frozen initial state:

```sh
pnpm exec tsx services/isolate-review/scripts/compare-reviews.ts \
  --candidate-url "$FRESH_PR" --control-url "$FRESH_PR" \
  --expected-head-sha "$HEAD_SHA" --web-url "$WEB_URL" \
  --model kilo-auto/efficient --out "$PRIVATE_PARENT/quality-1" \
  --run --publish-control --confirm-provider-mode --confirm-disposable-prs
```

The control has **no `dryRun` option**. `--confirm-provider-mode` attests that the
running server has empty/unset `DEBUG_SHOW_DEV_UI`; values such as `0` or `false`
are nonempty and enable the different public-only `kilo` baseline. The runner
checks shell/root `.env.local` configuration and the actual returned `outputMode`,
but cannot remotely attest server configuration before POST. A mismatch remains
in the operational ledger with its spend; it is not a matched quality result.

For live publication comparison, use **different disposable PR URLs** with the
same head/base, title/body and initially empty discussion, and add the separate
`--candidate-live` flag. Same-PR candidate-live plus control is refused. This MVP
restricts control publication to pristine discussion to avoid overwriting earlier
evidence; neither arm may publish to `na2-org/hi-how-are-you` PRs #8/#9/#10.
Candidate-only live summary reuse accepts `--previous-run-id UUID`; the API/Worker,
not the local artifact, must prove ownership. Freeze PRs and settings manually:
read snapshots are not atomic locks. Polling is every 5 seconds for up to 20 minutes
per arm. Read failures/timeouts stop further starts, not the remote execution.
Never re-run a creation after an uncertain response without reconciling it manually.

Artifacts include requests without credentials, preparation/inference provenance,
creation results, every status observation, transcripts, before/after discussion,
known root/child usage sessions and request IDs, separate server/observed timing,
coverage/termination/publication outcomes, `comparison.json`, and `report.json`.
Export before candidate retention expires. Missing model/tool/publication timings
remain null; combined execution time is not reported as inference-only latency.
Control `completed` does not prove complete publication, and its formatted transcript
can be incomplete. No latency percentiles or statistical claims are computed.

### Offline labels, diagnostics and cost report

```sh
pnpm exec tsx services/isolate-review/scripts/compare-reviews.ts \
  --report "$PAIR_DIR/comparison.json" --ledger "$PRIVATE_PARENT/labels.json" \
  --control-diagnostic "$PRIVATE_PARENT/control-diagnostic.json" \
  --candidate-usage "$PRIVATE_PARENT/candidate-usage.json" \
  --control-usage "$PRIVATE_PARENT/control-usage.json" \
  --out "$PRIVATE_PARENT/report-1"
```

All supplemental inputs are optional raw JSON. `--report` makes no network calls;
labels/diagnostics/usage flags are rejected during execution. The external human
ledger is never placed in a prompt. Its shape is:

```json
{
  "version": 1,
  "pairId": "<comparison.data.pairId>",
  "source": "external-human-ledger",
  "expectedDefects": [{ "id": "defect-1", "severity": "high" }],
  "findings": {
    "candidate": [
      {
        "path": "src/example.ts",
        "currentLine": 4,
        "side": "RIGHT",
        "severity": "high",
        "description": "Human-adjudicated defect description",
        "validity": "valid",
        "novelty": "new",
        "location": "inline",
        "proposed": true,
        "published": false,
        "lineTarget": "correct",
        "expectedDefectId": "defect-1"
      }
    ],
    "control": []
  },
  "summaryAccuracy": { "candidate": "unreviewed", "control": "unreviewed" }
}
```

Other labels: severity `critical/medium/low/unknown`, validity `invalid/unreviewed`,
novelty `duplicate/unknown`, location `summary-only`, side `LEFT` or null,
`published: null` for unknown, lineTarget `incorrect/unreviewed`, summaryAccuracy
`accurate/inaccurate`. Summary-only findings may have null currentLine/side; never
substitute `original_line`. Runtime IDs/display metadata are outside this schema.

A private captured control diagnostic uses `version: 1`,
`source: "private-captured-dispatch-diagnostic"`,
`phase: "post-analytics-appendix"`, plus the exact fields from
`[dispatchReview] Worker dispatch prompt diagnostics`: `reviewId`, `attemptId`,
`promptSha256`, `promptLength`, `model`, `variant`,
`analytics_enabled_at_dispatch`, `packagedCliVersion`. Optional independently
captured `outputMode`, `headSha`, `baseTipSha`, `mergeBaseSha`, `settingsHash`,
`contextHash`, `skillVersion`, `requestIds`, and
`childSessions: [{sessionId, parentSessionId}]` fill specific evidence gaps.
Missing proof stays pending; do not fill it by copying expected values. The hash
is after the analytics appendix but before infra's skill cue; full candidate/control
prompt hashes are not expected to match. Diagnostics are not fetched automatically.

Capture usage separately with the existing read-only helper, for the **execution
user** (the reviewer bot for organization runs), repeating only known session IDs:

```sh
umask 077
pnpm -s dev:seed app:usage-evidence "$EXECUTION_USER_EMAIL" \
  --session-id "$ROOT_SESSION_ID" --session-id "$KNOWN_CHILD_SESSION_ID" \
  --json > "$PRIVATE_PARENT/candidate-usage.json"
```

The control review UUID is **not** its CLI usage session. The runner uses exposed
`cli_session_id` values, including attempts, and only accepts child mappings rooted
in those known sessions. Root-only billing remains incomplete. The usage helper's
full SQL totals, not its bounded samples, feed exact microdollar numerators;
`runAccountingCompleteness: "unproven"` remains unproven even with all query rows.
Model/provider/token/BYOK and missing-metadata diagnostics remain in the private
usage artifact. Gateway/infra costs are unmeasured. Unknown cost is never free;
known spend is a lower bound, not a favorable complete-cost comparison.

All accepted arms, including failures and input mismatches, remain in reliability
and cost accounting. Cost per completed review uses **all** known spend, not only
successful-arm spend; zero denominators are null/unavailable. Valid **new proposed**
and valid **new published** finding denominators are separate. Quality labels stay
visible for failed/mismatched arms, but matched/conditional-completed eligibility
is explicit. Rates use exact `{numeratorMicrodollars, denominator}` fractions.

Offline regression command:

```sh
pnpm exec tsx --test services/isolate-review/scripts/compare-reviews.test.ts
```

### Fixture runner prompt seam

`run-e2e.ts` now defaults to offline preflight too. Explicit `--run` starts its
fixture server and billable candidate dry-run; no real reviewer run is implied by
these unit tests. The optional private `--prompt-file` is plain text, or the
canonical prepared **request** `.json` accepted by `render-live-prompt.ts`:
`owner`, `repo`, `pullNumber`, `headSha`, `model`, `thinkingEffort`, `userPrompt`,
and `preparation` with its version-1 settings/snapshot/hashes. The runner checks
fixture identity, settings and `preparation.hashes.adaptedPrompt`; credentials are
not accepted. It preserves prompt bytes and model/effort without importing web or
modifying the renderer. It does not replay the preparation manifest or production
identity/installation authority: fixture execution remains raw/default system mode,
not a high-level prepared-path proof. The existing opt-in task override is labeled
separately. Plain-text/default fixture prompts use `kilo-auto/efficient`
with default effort and are **not** canonical-policy parity claims. This supersedes
the older implicit-live runner and prompt/artifact usage in `E2E.md` without changing
that document's historical results.

```sh
pnpm exec tsx services/isolate-review/scripts/run-e2e.ts --prompt-file "$PRIVATE_PROMPT"
pnpm exec tsx services/isolate-review/scripts/run-e2e.ts --run --prompt-file "$PRIVATE_PROMPT"
```

Fixture artifacts are versioned JSON in a new
`scripts/last-e2e/<uuid>/` private directory, including `prompt.json`, `status.json`,
`transcript.json`, `writes.json`, `elapsed-ms.json` and `verdict.json`.

### Low-level Worker diagnostics

Raw `POST /reviews` is not the saved-settings API. It defaults to dry-run and
Sonnet 4.6; the Worker resolves the authenticated catalog during admission unless
validated prepared inference is supplied. A raw `userPrompt` replaces the user
message, not the bundled raw/default system policy. Canonical requests require a
complete prompt and `preparation` manifest with matching settings, snapshot and
execution identity; use the high-level API rather than assembling one by hand.

```sh
curl --fail-with-body -sS -X POST "$ISOLATE_URL/reviews" \
  -H "Authorization: Bearer $KILO_TOKEN" \
  -H "x-internal-api-key: $INTERNAL_API_SECRET" \
  -H 'Content-Type: application/json' \
  --data '{"owner":"OWNER","repo":"REPO","pullNumber":123,"headSha":"<current-full-PR-head-SHA>","model":"kilo-auto/efficient","dryRun":true}'
```

The raw schema is strict: `userId`, `kiloToken` and verified expiry are injected
from authentication, never accepted as body fields. The Worker checks the bearer
against the current token pepper and resolves repository-scoped GitHub credentials
through `GIT_TOKEN_SERVICE`, preserving and checking prepared integration/install/app
identity. Direct `gitToken` is a development/test fixture seam only. Raw
`organizationId` means a Kilo-owned organization integration, not merely a GitHub
organization name. Production-mode auth additionally requires the purpose-bound,
at-most-one-hour token; this does not enable production deployment.

Creation returns `202 {runId}`. Poll `GET /reviews/:runId` and retrieve
`GET /reviews/:runId/messages` with the same two headers; both enforce execution-
user ownership. Transcripts retain dry-run `wouldSend` payloads. Status includes:

| Field | Meaning |
|---|---|
| `requestedModel`, `dryRun`, `inference` | Requested model/alias and validated transport/variant; not the resolved auto-routing model distribution. |
| `provenance`, `preparation` | Raw versus canonical preparation, effective settings, identities, snapshot and hashes. |
| `reviewSelection` | Validated full/incremental scope, prior-run provenance and explicit fallback reason. |
| `summaryContent`, `cleanupAt` | Completed analysis summary/body hash and existing retention deadline; neither grants GitHub mutation authority. |
| `systemPromptHash`, `systemPromptVersion` | Actual composed Worker system, also recorded under preparation `hashes.workerSystem`/`versions.workerSystem`; web `hashes.system` covers only its runtime adapter. |
| `createdAt`, `startedAt`, `cloneCompletedAt`, `completedAt` | Acceptance, first admission/clone attempt, successful clone and server terminal transition; distinct phase boundaries. |
| `cloneAttempts`, `cloneMs`, `githubSizeKiB` | Orchestration attempts, latest successful clone duration and GitHub-reported size (32 MiB admission cap). |
| `tipFileCount`, `tipTotalBytes`, `vfsTotalBytes` | Checkout diagnostics; VFS bytes include Git metadata, not a peak-heap measurement. |
| `analysisOutcome`, `terminationReason` | Parent finish/steps, missing context/children, cancellation/deadline or other termination. |
| `publicationOutcome`, `reviewProposal`, `summaryProposal` | Independent inline/summary states and proposal publishability/blocked reasons. |
| `githubReviewId`, `summaryCommentId`, `summaryBodyHash`, `published` | Confirmed identities/body proof and historical evidence of any side effect, not proof of complete delivery. |
| `usageSessions`, `taskSessions`, `requestIds` | Root plus stable child usage IDs/mappings and physical inference request correlation. |

Top-level status remains `pending/cloning/running/completed/error`. Completion
requires a clean parent finish, complete required context/children, a valid summary
proposal and a settled inline decision; zero findings is valid. Live completion
also requires confirmed summary delivery and no rejected/pending/uncertain attempted
publication. Dry-run may complete analysis with proposals explicitly blocked from
publication. Legacy runs without structured outcomes remain unknown, not reclassified.

Admission/clone has 5 minutes including up to three attempts, model/tools 12 minutes
after clone, and the run an absolute 17-minute budget; all are shortened by verified
bearer expiry. Terminal state scrubs credentials; stranded credentials expire by
verified expiry or one hour, whichever is earlier. State/transcript destruction is
scheduled 24 hours after acceptance. Clone transport may outlive logical cancellation,
but cannot restore terminal state or authorize further work. Already-issued writes may acknowledge
late; `published` and known IDs remain truthful without reopening the run.

New children have persisted session IDs and parent/mode headers; only legacy flat
runs retain root-only attribution. Use the repeated-session usage/report workflow
above: SQL totals cover all currently matching rows, while recent samples are
bounded to 100. Neither query completeness nor known IDs proves settled whole-run
accounting.

### Existing Code Reviewer API

The control remains the existing manual API: `personalReviewAgent.createManualReviewJob`
or `organizations.reviewAgent.createManualReviewJob` with `organizationId`.
It needs the existing code-review-infra and Cloud Agent/container stack; isolate-only
setup does not provide that. Reuse suitable services and prefer named selections
when needed: the broad `code-review` group also starts an optional public Bitbucket
tunnel. The direct experimental candidate never starts that stack. Eligible
organization provider-output jobs now follow the queued rollout above; do not
assume this API always selects the legacy control.

Use the same Kilo bearer against the reported Next.js port. These are non-batched
tRPC requests with plain JSON, not a `json` or `0` envelope:

```sh
curl --fail-with-body -sS \
  -X POST "$WEB_URL/api/trpc/personalReviewAgent.createManualReviewJob" \
  -H "Authorization: Bearer $KILO_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "platform": "github",
    "url": "https://github.com/OWNER/REPO/pull/123",
    "modelSlug": "kilo-auto/efficient"
  }'
```

The response is HTTP 200 with `.result.data.reviewId` and
`.result.data.outputMode`. Poll and retrieve output using that review UUID:

```sh
curl --fail-with-body -sS --get \
  "$WEB_URL/api/trpc/codeReviews.get" \
  -H "Authorization: Bearer $KILO_TOKEN" \
  --data-urlencode "input={\"reviewId\":\"$CURRENT_REVIEW_ID\"}"

curl --fail-with-body -sS --get \
  "$WEB_URL/api/trpc/codeReviews.getSessionMessages" \
  -H "Authorization: Bearer $KILO_TOKEN" \
  --data-urlencode "input={\"reviewId\":\"$CURRENT_REVIEW_ID\"}"
```

Status is `.result.data.review.status`. Legacy model usage is correlated with
`.result.data.review.cli_session_id`; queued isolate leaves Cloud Agent/CLI session
IDs null and settles validated root/child usage within its execution identity and
time bounds. The API selects the head itself; verify
`.result.data.review.head_sha` matches the intended request.

**The current API does not accept a dry-run switch.** With nonempty
`DEBUG_SHOW_DEV_UI`, non-production `NODE_ENV`, and empty `VERCEL_ENV`, it uses
`outputMode: "kilo"`: public repositories only, dashboard output, and a simplified
local prompt. Otherwise it uses `outputMode: "provider"` and can publish to the PR
through the connected integration, including for private repositories. Configure
the server before POSTing; a localhost URL is not a no-publication guarantee.

Run the two APIs independently against the same head SHA and explicitly selected
model. Preserve the initial PR comment state: earlier live comments affect
duplicate suppression. Use isolate dry runs for repeat output comparisons.
Matching an auto-routing alias does not guarantee the same resolved model; inspect
usage evidence or pin a concrete model for a controlled quality comparison.
The organization allowlist is an explicit queued rollout, not random A/B assignment.
Direct experimental requests remain independent of it.

### Isolate publication safety

Standard-review output matches the original GitHub publication format: inline
findings are submitted atomically with an empty review-level body, and the
narrative summary is a separate marked issue comment. The tool enforces the empty
body even with a custom prompt. GitHub still shows the submitted-review event,
but no extra narrative review comment is created.

Live publication requires explicit `dryRun: false`, an open, explicitly non-draft
PR, matching head/base snapshot and complete required evidence. Summary ownership
is checked before any inline write. Discovery and a shared bot/summary marker are
read context, not adoption authority. For direct experimental requests,
`previousRunId` must identify a same-execution-
user, organization, repository, PR, installation and app run with a **confirmed**
summary ID/body hash; current bot/marker/PR ownership and unchanged body are rechecked.
An arbitrary `existingSummaryCommentId`, expired/legacy proof, another summary or
server-owned history/usage/guidance blocks cannot authorize a PATCH.

New summary POSTs include `<!-- kilo-isolate-review-summary:<sha256(runId)> -->`
for run-specific reconciliation; that marker alone never grants reuse authority.
Persisted operation fingerprints/body hashes fence replay. Writes and reconciliation
have bounded attempts; ambiguous writes are reconciled by reads, not blindly
reposted. A late confirmation can retain an ID without permitting another write.
Each direct experimental creation POST still creates a separate run: never retry
an uncertain direct creation. Queued admission instead retains the canonical
attempt identity and preparation across retries.

Dry-run performs snapshot, context, inline-target and ownership checks too. A
publication-only restriction can yield a blocked proposal; stale or unavailable
required evidence instead makes analysis incomplete. `pr_file_patch`, `pr_file`
and `pr_comment` expose bounded retrieval, not silent clipping or guaranteed recovery
of missing/invalid patches. Exact tools, budgets and limitations are in
[DESIGN §10](DESIGN.md#10-tools).

Earlier pilot/history evidence is unchanged. The comparison runner/report and native
adapter fixtures establish offline behavior, not new paired real evaluations or
live protocol equivalence. Private-fork acquisition and peak isolate heap remain
live-unverified; REST discussion data does not prove thread resolution. Live cohorts
and native-model trials require separate authorization and spend limits.
Direct/manual experimental entrypoints remain development-only. The sole production
exception is authenticated organization-allowlisted queued GitHub work described
above, not general deployment approval. The gateway default is
`https://api.kilo.ai/api/openrouter`.
