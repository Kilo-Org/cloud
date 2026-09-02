# Isolate Review — Design

A standalone standard GitHub reviewer executing in one V8 Durable Object per run:
no container, shell, `kilo serve`, `code-review-infra` execution or live stream.
Web owns authenticated settings/context preparation; the Worker owns read-only
repository investigation and guarded parent-only GitHub publication.

This file is the durable record: **what it is, why it is shaped this way, and
which pieces must not be "simplified".** The code is the source of truth for
*how*; when this file disagrees with the code, the code wins and this file gets
corrected.

---

## 1. Why this exists

The control uses a Linux/CLI execution stack:

```
webhook/manual API → Next.js → code-review-infra → cloud-agent-next
                  → review container → wrapper → kilo serve → Git/gh
```

Standard review investigation is already read-only: inspect code and discussion,
then publish findings, without edits or test execution. The candidate uses Think
and Computer rather than importing the Node/Bun CLI, shell tools or its filesystem
runtime into a Worker. The historical small-repository pilot established basic
feasibility, not universal repository/model coverage or comparative superiority.
Unsupported evidence fails explicitly; there is no sandbox fallback.

---

## 2. Shape

```
POST /reviews                      → 202 { runId }
GET  /reviews/:runId               → { runId, status, headSha?, finalText?,
                                        error?, published?, publishedAt? }
GET  /reviews/:runId/messages      → { runId, messages, toolCalls }
```

```
Authenticated human
  → dev-only web candidate API         owner, saved settings, canonical prompt
      → Hono POST /reviews             execution auth, strict validation, runId
          → ReviewIsolate DO           one Think parent; maxSteps 40
              Drizzle application state + Computer SQLite VFS
              exact-head shallow checkout at /workspace
              catalog-selected native/compatible adapter → Kilo gateway
              read / grep / list / find + scoped GitHub read tools
              parent-only submit_review / upsert_summary / activate_skill / task
```

The raw routes above remain diagnostic entry points. Prepared personal and
organization tRPC procedures and settings precedence are specified in
[README](README.md#prepared-development-apis). The candidate creates no canonical
review row, analytics attempt or fake Cloud fix link and never changes production
routing. Execution uses GitHub HTTP/Git, `GIT_TOKEN_SERVICE`, the Kilo gateway and
Hyperdrive-backed token verification, not Cloud Agent/container/session-ingest.

`runId` is a fresh Worker UUID/DO name and Think admission idempotency key, distinct
from Think's `submissionId`. This makes same-DO admission repeatable, **not** the
external creation POST idempotent. Never retry an ambiguous creation POST.

`startReview` persists state and schedules `runClone`; token/catalog/snapshot/clone
work happens asynchronously within the admission budget. There are at most three
orchestration attempts; oversize repositories fail immediately. Terminal callbacks
settle the run and scrub credentials. Status polling also checks deadlines and may
reconcile submission state or reschedule unstarted admission; it is not a new run.

---

## 3. Locked decisions

### Manual runner boundary

Exact runner commands and private input formats are in
[README — Manual comparison runner](README.md#manual-comparison-runner).
`compare-reviews.ts` defaults to offline CLI preflight because the authenticated
candidate API has no preparation-only operation. `--run` starts candidate dry-run;
`--publish-control` and `--candidate-live` separately authorize publication.
The control never receives `dryRun`. Candidate settings are resolved once and
passed as an explicit model/effort pair to the existing manual control API.

The one-pair MVP only uses already-existing disposable PRs. Provider-mode control
requires operator confirmation, empty initial discussion and unchanged read
snapshots; a live pair requires distinct equivalent PRs. Existing evidence PRs
#8/#9/#10 are write-protected. No scheduling, PR creation, service management,
credit changes or POST retries are implemented. Missing dispatch/child/cost proof
remains pending or unmeasured; failed/mismatched arms and their known spend remain
in operational accounting. Offline reports consume a separate human finding ledger,
never prompt-injected answers. New artifact directories/files are 0700/0600.

`run-e2e.ts --prompt-file` accepts private plain text or the canonical prepared
request JSON used by `render-live-prompt.ts`. Fixture identity, settings and adapted
prompt hash must match; prompt bytes and model/effort are preserved without web
imports. Production identity/installation authority is not replayed into fixtures.
The default simple fixture prompt is not canonical parity evidence. `--run` is
required for fixture-server start and billable dry-run inference; artifacts use
new `last-e2e/<uuid>/` directories rather than replacing old results.

| Topic | Decision |
|---|---|
| Location | `services/isolate-review/`. Not inside cloud-agent-next; do not grow `CloudAgentSession`. |
| Agent loop | `@cloudflare/think`. No custom tool loop, no V1 `SessionPrompt`, no V2 `SessionRunner`. |
| Filesystem | `@cloudflare/computer` Workspace, `useThink: true`, **no backends**. No just-bash, no Worker Loader, no container backend. |
| Git | isomorphic-git shallow clone of PR head — `depth: 1`, `singleBranch: true`, `noTags: true`, HTTPS only. |
| Oversized repo | Fail the run. No sandbox fallback. |
| LLM | Catalog-selected Anthropic Messages, OpenAI Responses, OpenRouter or compatible adapter through Kilo gateway (§6); no Cloudflare AI Gateway. |
| System prompt | `soul.txt`, sanitized `anthropic.txt`, frozen-date `<env>`, skill catalog, then prepared-policy notice or raw/default policy. No instruction discovery. |
| Review policy | Prepared: canonical web provider policy plus one runtime adapter. Raw: bundled system policy and request context; `userPrompt` overrides only the user message (§9). |
| Skills | Think `getSkills()` + `activate_skill`. One skill: `github-cloud-review`. No Kilo-named `skill` tool, no skill scripts. |
| Sub-agents | In-process `generateText` inside a `task` tool, same DO, same Workspace. Think's `subAgent`/`agentTool` are **forbidden** (§5.5). |
| Publishing | `dryRun: true` by default (`dryRun !== false`). Live publish is explicit per request. |
| Start path | Prepared web API or raw `POST /reviews`; no production queue, engine selector or webhook dispatch. |
| Live stream | None. Poll `GET /reviews/:runId`. |
| Platforms | GitHub only. |

### Reversals worth knowing

Three decisions flipped during design; only the final state is above, but the
reasoning matters if you are tempted to flip them back:

- **Custom loop → Think.** A hand-rolled loop is weeks of persistence and
  recovery work Think already ships.
- **Workers AI (`env.AI`) → kilo gateway.** Requested: production reviews bill
  and route through kilo gateway, so an isolate-vs-sandbox comparison must too.
- **`glob` → `find`.** There is no `glob` *tool*. Think's workspace tool set is
  `read, write, edit, list, find, grep, delete, bash?`. `glob` is a method on
  `WorkspaceLike`. `find` is the real glob tool: it takes a glob pattern, caps
  at 200 results, and sets `truncated: true`.

---

## 4. Request, auth, and lifetime

Prepared APIs require a human, development `NODE_ENV`, absent `VERCEL_ENV` and
configured Worker URL, independently of `DEBUG_SHOW_DEV_UI`. Personal execution
uses that user; organization execution uses its existing unblocked reviewer bot,
with separate requesting/execution/billing identities. Mutation subscription gates
remain intact; reads reauthorize membership and execution ownership. Web resolves
saved settings once, renders provider policy and mints a one-hour purpose-bound
`isolate-review` bearer with `botId: reviewer`; credentials are not returned.

The strict high-level input accepts only PR URL, optional model/effort, additive
instructions, expected head, previous run and dry-run mode (plus authorized org
scope). Raw `StartReviewRequestSchema` additionally carries repository coordinates,
pinned SHAs, prepared inference/provenance and expected integration/install/app
identity. Raw callers do not inherit saved configuration. `userId`, `kiloToken`
and verified expiry are injected, never body fields; raw live summary IDs still
require `previousRunId` proof. Both paths default to dry-run.

Every raw Worker route requires a timing-safe `x-internal-api-key` check and a
Kilo bearer validated against current token pepper over Hyperdrive. Signed `exp`
and execution-user identity are checked; production-mode auth additionally enforces
token source and a one-hour maximum token lifetime. Errors distinguish 401 invalid
auth, 500 missing configuration and 503 unavailable verification. The bearer is
used only internally for gateway access. GitHub credentials come from the token
service, bound to prepared integration/install/app identity; direct `gitToken` is
restricted to development/test fixtures. Tokens/headers must never enter logs or
artifacts; terminal persistence scrubs all held review credentials.

| Budget | Starts at | Bound |
|---|---|---|
| Admission/clone | Worker acceptance | 5 minutes total, including up to three orchestration attempts |
| Model/tools | Successful clone | 12 minutes |
| Absolute run | Worker acceptance | 17 minutes |
| Stranded credentials | Worker acceptance | Earlier of verified bearer expiry and one hour |
| Retained run/transcript cleanup | Worker acceptance | Destruction scheduled after 24 hours |

All execution deadlines are shortened by verified credential expiry. Persisted
state transitions, publication admission and acknowledgements share one state-only
queue; external I/O is outside it. Cancellation/deadline state is persisted before
aborting execution. Post-await checks prevent late clone/catalog/token results from
reopening the run. Clone transport itself is not physically abortable. No new
write is authorized after terminalization, but an already-issued write may finish;
a matching late acknowledgement can record an ID without reopening execution.
Terminal workspace removal is logical; full VFS/framework data is destroyed at
scheduled DO cleanup.

---

## 5. Load-bearing constraints

Each of these prevents a specific, verified failure. Do not remove one without
reproducing the failure it prevents.

### 5.1 `beforeTurn` must return `instructions` on every turn

```ts
return { instructions: this.getSystemPrompt(), activeTools: [...REVIEW_ACTIVE_TOOLS] };
```

Think's `_systemPromptForTurn` appends a "You are running inside a Think agent"
capability block built from the **merged** tool set, not `activeTools` — so it
advertises `write`, `edit`, `delete`, and `bash` to the model even though they
are denied. Returning `instructions` bypasses that assembly entirely.

**Consequence:** it also bypasses Think's skill catalog injection. That is why
`buildSkillCatalogPrompt()` hand-renders `<available_skills>` from the same
parsed manifest `getSkills()` uses. Registering a skill without appending the
catalog leaves the model unaware it exists.

`beforeTurn` runs on **every** turn, including continuations after eviction.

### 5.2 `activeTools` is a whitelist; `getTools()` shadows but cannot remove

Think merges `{ ...workspaceTools, ...fetchTools, ...getTools(), ...actionTools,
...extensionTools, ...contextTools, ...skillTools, ... }`. `getTools()` can
override a workspace tool *by name* but cannot delete it. So denial is two
layers: `write`/`edit`/`delete` are shadowed with stubs that throw, **and** they
are absent from `REVIEW_ACTIVE_TOOLS`. `workspaceBash = false` removes `bash`.

Adding a capability means adding it to `REVIEW_ACTIVE_TOOLS` too —
`getSkills()` without `'activate_skill'` in the whitelist silently hides the
tool. The one-shot `[turn] tools` log prints `missing`; it must stay `[]`.

### 5.3 Hydrate through Drizzle and serialize state mutations

The constructor calls `createReviewPersistence(ctx.storage)`, runs repository-owned
migrations inside `blockConcurrencyWhile`, then hydrates `runState` through that
persistence facade. Its `get`/`put` names wrap Drizzle query-builder operations on
`reviewApplicationState`; they are **not** DurableObjectStorage KV APIs. Application
state and `task:<id>` checkpoints use this path exclusively. Vendor-owned Computer,
Think and Agent SQLite internals are the scoped experimental exception.

Synchronous model/system hooks need hydrated state after eviction. `#updateState`
serializes reload/update/persist/cache replacement and terminal credential scrubbing;
`#updateActive` also enforces deadlines and terminal fences. Model creation rejects
missing/unresolved state instead of silently selecting another model. The system
prompt is rebuilt from frozen state, not a stale cached string.

### 5.4 Preserve framework alarm ownership

Agent/Think own scheduled work. The current `alarm()` override delegates to
`super.alarm()` and suppresses only the known vendor missing-notification-table
error after successful destruction. It does not replace the framework scheduler.
Deadline payloads include the deadline timestamp so admission/execution alarms do
not collapse into the same idempotent scheduled operation.

### 5.5 Think `subAgent` / `agentTool` are forbidden for reviews

Each Think child is another Durable Object with its own Workspace and its own
storage — which means **another clone**. The `task` tool instead runs a nested
`generateText` in the same isolate against `this.workspace`, so children read
the tree the parent already cloned. Concurrent child reads of one VFS are
expected; children never write.

Generation is in-process, but each step checkpoints validated model messages and
provider continuation metadata through Drizzle. Reusing `task_id` resumes the
stored context/session identity after failure or eviction; it does not continue
the lost in-memory call. Children inherit resolved policy, snapshot and model
settings, cannot publish/activate skills/recurse, and must finish cleanly with
nonempty text. Running/failed children remain in the parent's incomplete-task set
until that task completes; partial text or step exhaustion is not success.

Checkpoints are capped at 1,500,000 bytes including key and JSON. If compaction
would truncate tool evidence, the task is marked context-exhausted and cannot be
reported complete or resumed from that lossy checkpoint. This is bounded recovery,
not unlimited history or cross-DO child execution.

### 5.6 `onProgress.loaded` is not bytes

It is a running counter of objects/files **within a phase**, passed straight
through from isomorphic-git. Never accumulate it, never cap on it. It is
observability only (`lastPhase`). A real mid-clone transport byte cap is
unreachable through Computer's public API — `createGitClient` hardwires its HTTP
client and it is not injectable.

### 5.7 Pin Think exact

`@cloudflare/think` is pinned to `0.16.0` with no caret. The behavior this
service depends on includes a private method (`_systemPromptForTurn`). Bumping
it is a deliberate change that requires re-reading §7.

`@platformatic/vfs` is an optional peer that Computer's git adapter imports
lazily — **omit it and clone fails at runtime, not build time.** `isomorphic-git`
is a caller-installed peer, not a Computer dependency.

---

## 6. The model

### 6.1 Kilo gateway remains authoritative

All adapters target `KILO_GATEWAY_URL` (default
`https://api.kilo.ai/api/openrouter`), retaining Kilo authentication, routing,
organization/BYOK policy and billing. Do not insert a caching Cloudflare AI Gateway
hop or return a bare model string that routes through an `AI` binding. The Worker
returns a constructed `LanguageModel` and never receives provider credentials or
caller-controlled provider URLs through the high-level API.

### 6.2 Catalog-selected native adapters and explicit limitations

`opencode.ai_sdk_provider` selects transport, defaulting to OpenRouter when absent:

| Catalog provider | Installed adapter | Gateway protocol |
|---|---|---|
| `anthropic` | `@ai-sdk/anthropic@4.0.15` | `/messages` |
| `openai` | `@ai-sdk/openai@4.0.15` | Stateless `/responses` |
| `openrouter` | `@openrouter/ai-sdk-provider@3.0.0` | `/chat/completions` with reasoning details |
| `openai-compatible` | `@ai-sdk/openai-compatible@3.0.11` | Compatible `/chat/completions` |

Owner-scoped catalog variants are validated once, not reduced to a universal
low/medium/high enum. Parent and children inherit the same allowlisted reasoning,
verbosity and sampling via `defaultSettingsMiddleware`; output is capped at the
catalog limit or 32,000 tokens. Concrete Qwen sampling follows the pinned defaults
when advertised (temperature 0.55 except North Mini Code, top-p 1); auto aliases
retain router ownership and reject explicit effort/sampling. Raw admission fetches
an authenticated catalog (8 MiB response cap); prepared requests carry validated
inference from the web resolver. Unknown/unauthorized/incompatible pairs fail before
inference. Raw/default Sonnet 4.6 is distinct from the shared web default factory's
current Sonnet 5 and from a user's saved selection.

The reference is packaged CLI **7.4.20** at
`62baedd258fbeb738929767258349f76d7f8a48d`, not an arbitrary local CLI checkout.
Offline fixtures cover JSON/SSE, tool continuations and checkpoint/UI replay with
native signed/redacted Anthropic, encrypted Responses and OpenRouter reasoning.
They also retain known differences rather than claiming byte-for-byte parity:

- Pinned Anthropic 3.0.82 omits explicit disabled thinking; the candidate keeps
  omitted/default and explicit disabled distinct.
- Pinned Responses handling can miss prefixed model capabilities and suppress
  `none` via `forceReasoning:false`. The candidate preserves explicit `none`,
  encrypted continuation and stateless replay, stripping item IDs/references.
- Compatible transport loses `reasoning_details`; it is not native/OpenRouter
  continuation equivalence. OpenRouter promotes those details for continuation.

These are deterministic protocol fixtures, **not live provider/model equivalence**.
Owner/BYOK availability, routing and expensive native trials still require real,
authorized evidence. Auto aliases are end-to-end comparisons, not engine-only ones.

### 6.3 Root, child and request attribution

All requests retain `User-Agent: kilo-isolate-review`, `x-kilocode-feature: code-review`
and optional `X-KiloCode-OrganizationId`. Per-model instances avoid shared mutable
headers during concurrent child execution:

| Header | Parent | New child |
|---|---|---|
| `x-kilocode-mode` | `code` | `general` or `explore` |
| `x-kilocode-taskid`, `x-kilo-session` | `runId` | Persisted child session UUID, reused on resume |
| `x-kilocode-parent-taskid` | Absent | `runId` |
| `x-kilo-request` | Fresh ID per physical inference request | Same per-request rule |

Status exposes `usageSessions`, `taskSessions` and `requestIds`. Tracking exhaustion
refuses new untracked inference. Legacy child checkpoints retain their original
root-only attribution. Query all **known** root/child/retry IDs with repeated
`usage-evidence --session-id`; full SQL totals and bounded diagnostic samples are
separate. Run attribution/settlement remains unproven, market and billed microdollars
stay distinct, and gross input already includes cache tokens. Unattributed user-window
rows are not assigned to the run; gateway/infra cost remains unmeasured.

---

## 7. Framework API contract

These are preview dependencies; installed types and executable fixtures take
precedence over historical API notes. The current integration uses:

| Boundary | Contract |
|---|---|
| Runtime | `Think<Env>` extends Agent; `nodejs_compat`, no Worker Loader/execution backend |
| Turn hooks | `beforeTurn` supplies instructions/active tools/timeouts; `onStepEnd` records clean finish and step count |
| Submission | `submitMessages`/`inspectSubmission` use `ThinkSubmissionInspection`; assistant text comes from `getMessages`, not an inspection `finalText` |
| Settlement | `onSubmissionStatus` plus status-read fallback; framework completion alone is insufficient (§10) |
| Workspace | `useThink: true`, `git: createGitClient()` and a safe read-only wrapper; `find` caps at 200 results with truncation metadata |
| Persistence | Repository Drizzle migrations/state facade; vendor SQLite is exempt only within this experimental service |

Manifest versions: Think `0.16.0` (exact), Computer `^0.2.1`, VFS `^0.4.0`,
isomorphic-git `^1.38.5`, Agent `^0.21.0`, AI SDK `7.0.29`; adapters are in §6.
Ranged dependencies are not exact pins. Computer's clone API offers no injected
HTTP transport or abort signal; wrapper checks cannot imply physical cancellation.

---

## 8. Admission and clone

`MAX_REPO_SIZE_KIB = 32 * 1024` admits at most **32 MiB of GitHub-reported repository
size**, not tip size or measured peak heap. Keep `githubSizeKiB`, `tipFileCount`,
`tipTotalBytes` and `vfsTotalBytes` separate: VFS includes Git metadata. Missing
diagnostics are not zero. Peak use of the 128-MB isolate has not been profiled;
a missing response alone does not establish OOM.

Admission captures and validates distinct `headSha`, `baseTipSha` and `mergeBaseSha`,
checking current head/base around exact-SHA comparison. Checkout tries the captured
head, then the base repository's synthetic `refs/pull/<n>/head`, and always verifies
`HEAD` equals the captured OID. Failure never falls back to a moving branch tip.
Synthetic-ref behavior has offline fixtures; real private-fork acquisition is still
unverified.

The clone is shallow (`depth: 1`, `singleBranch`, `noTags`) at `/workspace`. There is
no shell, full-history clone or LFS materialization; model-visible workspace access
hides `.git` and symlinks. Historical reads use pinned GitHub file APIs (§10).
Abort checks stop fallback/stat work after cancellation, but cannot revoke the
underlying Computer Git transport; lifecycle post-await fences remain mandatory.

---

## 9. Raw and canonical prompts

`buildSystemPrompt` composes `soul.txt`, sanitized read-only `anthropic.txt`, an
`<env>` using the captured model/creation date, the skill catalog, then either the
bundled raw/default `review-policy.md` or a prepared-policy notice. A prepared run
never adds the bundled policy as a competing second policy. Raw `userPrompt`
overrides only the user message; the raw/default system constraints still apply.
A prepared run without its full prompt fails instead of falling back.

Web calls the actual `generateReviewPrompt` with provider mode, full-review context,
saved style/focus/custom instructions, additive manual instructions and optional
base-tip `REVIEW.md`. It applies the eligible analytics appendix and one versioned
isolate adapter mapping CLI examples to typed tools. Summary context is complete,
cleaned and explicitly read-only; no fake review UUID/fix link is generated. Total
prepared prompt length is bounded to 64,000 characters without silent clipping.
Children inherit that resolved policy and trusted snapshot, plus the read-only
review skill and child constraints; no recursive delegation or publication.

Preparation separates semantic settings/context from runtime-specific prompt bytes:

| Hash | Evidence |
|---|---|
| `settings` | Effective semantic settings, excluding explicit/global/repository source label |
| `context` | Captured SHAs, cleaned summary, inline context and repository instructions |
| `canonicalPrompt` | Canonical provider prompt after the candidate analytics decision |
| `adaptedPrompt` | Complete adapted user message |
| `system` | Web runtime adapter only, not the Worker system |
| `workerSystem` | Actual composed Worker system recorded before a turn, with `versions.workerSystem` |

The initial create response cannot attest a Worker system that has not run yet;
status exposes its `systemPromptHash`/`systemPromptVersion` and updated preparation.
Legacy missing hashes remain unknown. Control hash diagnostics describe the actual
post-analytics dispatch payload before infra's skill cue, using persisted attempt
enrollment; the authoritative skill version is separate. Full prompt hashes differ
legitimately for runtime instructions and real control fix links.

No automatic `AGENTS.md`/`CLAUDE.md`/rules/profile-memory/MCP discovery is added.
Repository content, PR descriptions and discussion remain untrusted evidence, not
instructions. The fixture renderer consumes a canonical prepared artifact rather
than reconstructing production templates. `run-e2e` transfers prompt/model/effort,
not the preparation manifest, so even artifact-backed fixture execution has raw
provenance/default system policy. It does not prove the high-level prepared path.

---

## 10. Tools

Workspace tools are `read`, `grep`, `list`, `find`. GitHub tools are scoped to the
run's repository/PR and captured head/base-tip/merge-base; all transport and awaited
preflight boundaries consume/check cancellation signals:

| Tool | Exact supported operation |
|---|---|
| `pr_view` | Current metadata and 32-KiB description chunks; verifies head/base, continuation requires body hash |
| `pr_diff` | Selected full/incremental comparison by default; `comparison: "current-pr"` retrieves current PR evidence for publication anchors |
| `pr_file_patch` | Changed-file patch retrieval by path/offset within the selected `review` or `current-pr` comparison |
| `pr_file` | UTF-8 file at `head`, `merge-base`, `base-tip`, trusted `previous`, or authorized `history` commit SHA; range-specific rename handling |
| `pr_history` | Bounded commit pages rooted at captured head, optionally narrowed by path; discovered SHAs grant only read access |
| `pr_commit` | Metadata and optional patch chunks for a captured or history-authorized SHA; only the first 100 changed files |
| `pr_comments` | Inline/issue/review previews, summary discovery and explicit category/page/offset continuation |
| `pr_comment` | Full scoped comment/review context in chunks; body-hash continuation detects edits |
| `submit_review` | Parent-only atomic inline `COMMENT` review with exact empty review-level body |
| `upsert_summary` | Parent-only marked summary proposal or ownership-proven POST/PATCH |

Compare's 300-file ceiling is not evidence of a complete diff. Full-review fallback
PR-file pagination checks head/base before/after and validates the final count (up
to 3,000 changed files). Incremental review instead requires a proven ancestor
previous head and an exact comparison below 300 files; PR-files pagination never
supplies incremental evidence. Web resolves full fallback before prompt hashing
when the baseline, policy/base compatibility or comparison is unsuitable. Worker
admission independently verifies incremental provenance, summary hash and file
count, then persists the selection. Admission revalidation failures stop the run;
analysis never silently changes scope.

The selected analysis diff and current PR publication anchors have separate
range-bound caches under the same retained-patch budget. Previous-head content is
the incremental old side; merge-base content remains the full PR old side, and
`REVIEW.md` always uses base tip. Missing/invalid required analysis patches make
context incomplete; unrelated unavailable full-PR patches do not invalidate an
otherwise complete delta. Every attempted inline target still needs a valid current
PR RIGHT-side anchor. Revision reads cannot clear required patch failures or prove
a reconstructed diff. Clipped valid patches expose retrieval metadata.

History requests are optional, bounded reads: limited or unavailable history is
reported explicitly rather than treated as empty or made into a global required-
context failure. Current head/base-tip/merge-base and an effective previous head
are trusted roots. Only SHAs returned by `pr_history` extend that read authority;
displayed commit parents do not. Request reservations and discovered SHAs are
persisted through the existing Drizzle state queue before HTTP and before evidence
exposure, respectively. Parent/child calls share the limits across tool recreation
and DO eviction. No history response cache or full-history clone is added.

Fixed Worker limits, not peak-memory measurements:

| Boundary | Limit |
|---|---|
| GitHub response transport, checked while reading | 2 MiB before JSON parsing |
| One paginated traversal | 8 MiB, 50 pages, 5,000 records |
| Retained patch cache | 2 MiB |
| `pr_diff` projection budget | 256 KiB, up to 300 file previews per call |
| Discussion previews | 512 bytes per body; 128 KiB per category; default up to 500 inline records and 100 issue/review records |
| Description/comment/patch/file retrieval chunk | 32 KiB, explicit continuation |
| File-at-revision decoded content | 1 MiB, UTF-8 only; no binary, symlink or submodule content |
| Inline publication | 1–100 comments, 64 KiB per body, 256 KiB aggregate |
| Summary body and retained analysis summary | 64 KiB each |
| Optional history HTTP attempts | 20 per run, including retries and historical file reads |
| History pagination and discovered SHAs | 20 commits/page, five pages/query, 100 discovered SHAs/run |
| Commit investigation | First 100 changed files; explicit incompleteness at the cap |

The active root-comment index scans independently of preview limits. Replies,
current/outdated and file-level records are distinguished; exact same-body current
RIGHT-side duplicates are blocked, while semantic duplicate assessment remains
review policy. REST thread `resolution` is **unknown**, not inferred from line
presence. Inline targets must be current valid RIGHT-side diff lines; deletion-only
or unstable findings stay summary-only. Server-owned history/usage/guidance and
candidate operation markers are excluded from model summary context.

Summary discovery never grants mutation authority. A fresh live run requires no
conflicting marked summary before **any** inline publication. For mutation,
`previousRunId` must resolve to the same execution user/org/repo/PR/install/app and a confirmed summary
ID/body hash. Current bot, marker, PR scope and unchanged body are revalidated;
legacy/missing proof, production/human summaries, conflicting summaries and backend-
owned blocks fail closed. Arbitrary summary IDs cannot bypass this proof.

Completed prepared runs additionally retain normalized `summaryContent` with its
own hash, excluding operation markers and backend-owned blocks. This permits
same-scope dry-run baselines within the existing 24-hour lifetime, without a fake
comment ID or publication proof. `summaryBodyHash` still describes confirmed
published bytes and is never replaced by the analysis hash. Missing legacy summary
content selects full review; incomplete/failed runs cannot serve as baselines.

New summary POSTs add `<!-- kilo-isolate-review-summary:<sha256(runId)> -->` so
lost-response reconciliation cannot adopt another run's identical prose. The marker
is not reuse authority; authorized PATCHes use confirmed state/body proof. Durable
fingerprints fence identical replay and reject conflicting operations. Each kind
has at most two write admissions and two read-reconciliation attempts; uncertainty
never authorizes blind reposting. Live writes recheck open/non-draft state and
matching snapshot, then enter the lifecycle authorization fence. GitHub has no
atomic conditional comment update, so the final read/write race cannot be eliminated.

Dry-run makes those reads/validations but sends no POST/PATCH. Proposals carry
`publishable`/`blockedReason`: publication-only restrictions can coexist with complete
analysis, while stale/missing required evidence cannot. `analysisOutcome` records
parent finish/steps and missing context/tasks. Completion requires a clean finish,
valid summary and settled inline decision; zero findings is valid. Live completion
also requires confirmed summary and no rejected/pending/uncertain attempted write.
`publicationOutcome` independently tracks `not_requested`, `proposed`, `pending`,
`uncertain`, `confirmed` or `rejected` for inline review and summary. `published`
means some historical side effect, not full delivery; legacy absent outcomes stay
unknown.

`task` accepts `{description, prompt, subagent_type, task_id?}` with `general` or
`explore`. Children receive all GitHub read tools plus read-only workspace tools,
never mutation/activation/recursion. Six concurrent children and 12 steps per child
invocation are bounded by the parent's 40-step/12-minute execution limits. Drizzle
checkpoints and stable session identity support explicit `task_id` resume (§5.5).
Results expose `{title, metadata, output}` with XML-wrapped result/error, finish/step
and context-exhaustion metadata; unfinished children block parent completion.

---

## 11. Risk register

| Risk | Handling and remaining limit |
|---|---|
| 128-MB isolate/pack inflation | 32-MiB admission gate and bounded reads; no live peak-heap proof (§8) |
| Unintended execution or policy drift | Explicit instructions/tool allowlist, denied mutations, canonical/raw distinction (§5, §9) |
| Mixed or incomplete GitHub context | Pinned SHAs, bounded retrieval and sticky incomplete outcomes, never assumed empty (§10) |
| Wrong summary/late publication | Confirmed prior-run/body proof and serialized terminal/write fence; issued writes may still acknowledge (§4, §10) |
| Eviction/child exhaustion | Drizzle hydration/checkpoints; truncated or unfinished investigations block completion (§5) |
| Credential expiry/leakage | Verified expiry caps execution; scrub terminal state, redact private artifacts, never log credentials |
| Incomplete cost attribution | Stable session/request IDs, full-row SQL totals, explicit unknown/lower-bound accounting (§6) |
| Preview/native protocol drift | Exact Think/adapter versions and offline fixtures, not live equivalence (§6, §7) |

---

## 12. Deferred and evaluation gates

Production routing/queues, canonical review rows/dashboard/checks, summary history/
usage/guidance finalization, real Cloud fix links, public cancel/retry/list APIs,
automatic baseline discovery, GitLab/Bitbucket and council are not implemented.
Explicit prepared incremental review and bounded on-demand history are implemented (§10).
Server-side purpose tokens, child checkpoints and usage correlation **are** present;
fully attributed settled billing and infrastructure measurement are not.

No full-history clone, LFS materialization, symlink/submodule support, automatic
rules/profile-memory/MCP loading, recursive publishing children or higher resource
limits are claimed.
Think child DOs, workspace RPC proxies, shell/container/Worker Loader execution and
importing the CLI/web runtime into the Worker remain outside this design.

Historical pilot and PR #8/#9/#10 evidence remains unchanged. Current runner/report
and native protocol work is offline proof only: no new matched real control pair,
quality equivalence or cost superiority is claimed. Private-fork acquisition and
peak heap remain live-unverified; REST resolved-thread status is unknown. Real
paired pilots/repeats, live publication checks, larger cohorts and expensive native
trials remain separately authorized/spend-gated, not an automatic rollout.

---

## 13. Source pointers

- `src/{index,auth,types,review-isolate}.ts` — raw contract, execution identity, deadlines/outcomes
- `src/{persistence,task}.ts`, `src/db/sqlite-schema.ts`, `drizzle/` — application state/checkpoints
- `src/{git,github}.ts` — snapshot acquisition, bounded evidence, origin/replay/publication checks
- `src/{model,prompt}.ts`, `test/unit/model-protocol.test.ts` — adapters, system policy and offline protocol proof
- `apps/web/src/lib/code-reviews/{manual-isolate-reviews,isolate-review-prompt,isolate-review-model}.ts` — prepared API boundary
- `apps/web/src/lib/code-reviews/prompts/generate-prompt.ts` — canonical provider policy/settings rendering
- `apps/web/src/lib/code-reviews/dispatch/dispatch-pending-reviews.ts` — actual post-analytics control diagnostics
- `services/code-review-infra/src/{github-cloud-review-skill,code-review-orchestrator}.ts` — control skill and application point
- `dev/seed/app/usage-evidence.ts`, `scripts/{compare-reviews,review-evidence,run-e2e,render-live-prompt}.ts` — private/manual evidence tooling
