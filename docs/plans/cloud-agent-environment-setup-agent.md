# Cloud Agent Environment Setup Agent

Date: 2026-11-03
Status: Proposed plan. Nothing is implemented yet.

## Goal

The user chooses one or more repositories and writes what they need in plain
language. For example: "set up Kilo-Org/cloud so the Cloud Agent can use the
local dev stack". After they submit, a Cloud Agent session starts on those
repositories. The agent:

1. Works out a setup script, variables, secrets, sandbox size and, later,
   network policy that meet the requirement.
2. Writes them into a **draft** repository environment through scoped tools.
   It never touches environments it was not given.
3. Tests the draft in a fresh sandbox, through the same preparation path real
   sessions use, and repeats steps 1–3 until the draft passes.
4. Reports a summary with evidence. The user can then publish the draft as a
   new or updated environment.

The user never writes the script, variables or sandbox size by hand. They only
supply secrets the agent cannot invent, and they confirm publication.

## What exists today

| Area | Current state | Source |
|---|---|---|
| Environment record | `cloud_agent_environments`: name, V1 repo identity or V2 `repositories` jsonb, `commands text[]` (at most 1 script, 16,000 chars), `configuration_revision`, `sandbox_allocation`. Owned by a user or by an organization. | `packages/db/src/schema.ts:8390` |
| Variables / secrets | `cloud_agent_environment_vars` (`is_secret`, RSA+AES envelope). Secrets are write-only through the API. | `packages/db/src/schema.ts:8516` |
| Domain service | `createEnvironment`, `updateEnvironment`, `loadEnvironmentForSession`, `selectEnvironmentForSession`, `ENVIRONMENT_LIMITS`, reserved keys | `packages/cloud-agent-profile/src/environment-*.ts` |
| API | `cloudEnvironments.{list,listAll,get,create,update,delete,build,buildStatus,buildLogs,cancelBuild}`. Owners/admins manage; members read. | `apps/web/src/routers/cloud-environments-router.ts` |
| UI | `EnvironmentDialog` (overview / scripts / variables), `RepositoryEnvironmentChip`, settings `EnvironmentsSection` | `apps/web/src/components/cloud-agent-next/` |
| Session application | Preflight resolves the environment for implicit origins. `requestedEnvironment` picks one explicitly. The setup script runs with `bash -e -o pipefail` after clone, at `/workspace/<name>` (one repo) or `/workspace` (several). Timeouts: 5 min inactivity, 8 min hard. Failure → `workspace_setup_failed`. | `services/cloud-agent-next/src/router/handlers/session-creation-preflight.ts`, `wrapper/src/control-plane/repository-preparation.ts:266` |
| Revision on session | `EnvironmentReference.configurationRevision` records the revision a session ran with. | `packages/cloud-agent-profile/src/environment-contracts.ts:183` |
| Clean-room builds | `EnvironmentBuild` DO, builder container, redacted logs. **Organizations in `ENVIRONMENT_SNAPSHOT_ORG_IDS` only.** | `services/cloud-agent-next/src/environment-build/` |
| In-sandbox platform tools | The `kilo-cloud-agent` MCP gets a `delegated-workload` JWT with a `cloudAgentAuthority` claim. Its allowlist covers child-session and folder procedures only. It **cannot read or change environments**. | `packages/worker-utils/src/cloud-agent-authority.ts`, `services/kilo-mcp/src/child-session-tools.ts` |
| Network | **Not an environment field.** `egressMode` / `egressAllowlist` / `egressAudit` are per-session request options and need `cloudflare-containers`. | `packages/worker-utils/src/egress-allowlist.ts:34` |

Consequences for this design:

- **New environments would collide with existing ones.** A new environment row
  that contains a repository immediately takes part in matching. If the
  repository already had exactly one environment, there are now two. Slack,
  webhook and schedule sessions then start with **no** environment (spec
  start rule 16). The agent must therefore work on a draft that matching
  ignores.
- **Clean-room builds are not universally available.** They work only for
  enrolled organizations. Universal verification has to use a normal session
  that names the draft explicitly.
- **The agent needs a new, narrowly scoped authority.** The user-level Kilo MCP
  catalog already exposes `cloudEnvironments.*`, but that grants full user
  power. The sandbox authority must reach only one draft.
- **Network policy needs new work.** Today there is nothing in an environment
  for the agent to edit. See Phase 5.

## User flow

1. **Entry points:**
   - "Set up with agent" in the environment editor, for a new or an existing
     environment.
   - "Set up automatically" on the repository environment chip in the
     new-session form.
2. **Form:**
   - Repositories, using the existing `EnvironmentRepositoriesField` and
     prefilled when possible.
   - A free-form requirements textarea (required, ≤ 8,000 chars).
   - A model, using the existing model picker; the normal balance rules apply.
   - Optional environment name.
   - For an existing environment, "refine current setup" is implied.
3. **Submit:** the server creates a draft environment and a setup run, then
   starts the setup session. The user lands in that Cloud Agent chat. The
   requirement is the visible first message, and preparation and agent work
   stream as usual.
4. **Setup run panel.** A collapsible card in the chat header and in the
   environment editor shows:
   - Status: `running`, `needs_secrets`, `verifying`, `ready`, `failed`,
     `published`, `cancelled`.
   - Requested secrets, as a write-only form, each with the agent's
     explanation.
   - A diff of the draft against the current environment: script, variable
     keys, plaintext values, secret keys, sandbox size and egress.
   - The latest verification: revision, preparation result and duration,
     agent-reported checks, and a link to the verification chat.
   - **Publish**, **Discard** and **Ask agent to change…**. The last one is just
     a chat follow-up.
5. **After publish:**
   - The environment applies to sessions as usual.
   - For snapshot-enrolled organizations, a build is offered, or started
     automatically if the user chose that.

The user can talk to the agent at any time. For example, they can answer its
`question` prompts ("Do you need the Stripe test keys?") or redirect it. Secret
values never go through chat. The agent asks for them with a tool, and the user
enters them in the panel.

## Architecture

```
Web UI ──startSetupRun──▶ web tRPC (cloudEnvironments.setupRuns.*)
                               │ 1. create draft env + setup run
                               │ 2. prepareSession(requestedEnvironment=draft,
                               │      environmentSetupRunId, runtimeSkills=[env-setup])
                               ▼
                       cloud-agent-next session (isolated sandbox)
                               │ wrapper injects kilo-cloud-agent MCP with grant
                               │   cloudAgentAuthority.environmentSetup = {runId, environmentId}
                               ▼
                  kilo-mcp environment-setup tools ──call──▶ web tRPC (scoped procedures)
                               │                               │ re-check owner/manage role,
                               │                               │ run state, draft id
                               │ verify_environment ──▶ child session
                               │      (requestedEnvironment=draft, no setup/spawn authority)
                               ▼
                       complete_environment_setup ──▶ run = ready (server-gated)
User ──Publish──▶ web tRPC publishes draft → target environment (new or existing)
```

### 1. Data model (`packages/db`)

Follow `packages/db/AGENTS.md` and the `database-migrations` skill.

**`cloud_agent_environments`:**
- Add `status text not null default 'active'` with a check `in ('active','draft')`.
- Add `draft_for_environment_id uuid null`, FK to `cloud_agent_environments`
  with `on delete cascade`. It names the existing environment the draft will
  replace on publish. Null means the draft becomes a new environment.
- Exclude drafts from the V1 partial unique indexes, which need a
  `where status = 'active'` predicate. Otherwise a V1-era repository cannot
  get a draft.

**New table `cloud_agent_environment_setup_runs`:**
- `id uuid pk`
- Owner columns copied from the environment pattern, with the XOR check
- `created_by_user_id`
- `draft_environment_id` (FK, cascade)
- `target_environment_id` (nullable FK, `set null`)
- `requirements text`
- `model text`
- `cloud_agent_session_id text` (`workspace_*`)
- `status text`
  (`starting|running|needs_secrets|verifying|ready|failed|published|cancelled`)
- `requested_secrets jsonb`: `[{key, reason, satisfied}]`; never values
- `last_verification jsonb`:
  `{childSessionId, configurationRevision, preparation: 'succeeded'|'failed'|'pending', durationMs, checks: [{name, passed, evidence}], reportedAt}`
- `summary text`
- `failure_reason text`
- `verification_count int`
- `created_at`, `updated_at`, `completed_at`
- Partial unique index: one non-terminal run per `draft_environment_id`, and
  one per `target_environment_id`.

The run table is the product state. The draft environment row is the
configuration that real preparation consumes. It is a normal environment row,
so the verification path needs no new loader.

### 2. Domain service changes (`packages/cloud-agent-profile`)

- **Matching:**
  - `selectEnvironmentForSession`, `listEnvironmentsForOwner` and the
    repository-match queries ignore `status = 'draft'` rows.
  - They make one exception: an explicit `environmentId` that names a draft.
    That draft resolves only when the caller passes
    `allowDraft: { setupRunId }` and the run is non-terminal. Preflight sets
    `allowDraft` only from server-attached metadata (see §4). A user cannot
    start ordinary sessions on someone's draft by guessing its id.
- **`createDraftEnvironment({owner, repositories, name, targetEnvironmentId?})`:**
  - For an existing target, copy the target's commands, plaintext vars,
    secret **envelopes** (no decryption), repositories and allocation into the
    draft.
  - So "refine my environment" starts from the current configuration, and
    verification can use the user's existing secrets.
- **`publishDraftEnvironment({draftId, expectedTargetRevision?})`:**
  - **New environment:** flip `status` to `active` and clear the draft fields.
    Run the same allocation and multi-repository checks as `create`.
  - **Existing target:** in one transaction, apply the draft's commands, vars
    and envelopes, allocation and repositories to the target through
    `updateEnvironment` semantics. This bumps `configuration_revision`. Then
    delete the draft.
  - If the target's revision changed after the draft was forked, fail with
    `CONFLICT`. The UI shows the three-way difference and lets the user
    publish anyway.
- **Draft updates reuse `updateEnvironment`.** All existing limits, reserved
  keys and secret encryption apply unchanged.
- **Cleanup:** drafts of terminal runs older than 14 days are deleted by the
  existing web cron infrastructure. Run rows stay for audit.

### 3. Web API (`apps/web/src/routers/cloud-environments-router.ts`)

Add a `setupRuns` sub-router. All of it is behind the release toggle
`cloud-agent-environment-setup-agent` (`isReleaseToggleEnabled`).

**User procedures.** These require the manage role, like `create` / `update`:

| Procedure | Purpose |
|---|---|
| `setupRuns.start` | Input: `{organizationId?, repositories, requirements, model, variant?, name?, targetEnvironmentId?}`. Validates repository access up front (`assertEnvironmentRepositoriesAccess`), so a missing integration fails before any sandbox starts. It also checks the isolated-sandbox requirement. It creates the draft and the run, then calls `prepareSession` + initiate (§4). Returns `{runId, cloudAgentSessionId}`. Idempotent on an `operationKey`. |
| `setupRuns.get` / `setupRuns.listForEnvironment` | Return the run state, the draft view (same shape as `get`, secret keys only), and the diff against the target. |
| `setupRuns.provideSecrets` | `{runId, secrets: [{key, value}]}`. Writes encrypted values into the draft, marks the requests satisfied, and sends a short system follow-up to the setup session: "Secrets X, Y are now set; re-run verification." The message has no values. |
| `setupRuns.publish` | `{runId, expectedTargetRevision?}`. Allowed in `ready`. In `failed`, only with an explicit `force: true` and a warning that the draft is unverified. |
| `setupRuns.cancel` | Interrupts the setup session and its verification children through the existing interrupt path, then marks the run `cancelled`. The draft is kept until cleanup so the user can still inspect it. |

**Agent procedures.** These are reachable only with an environment-setup
authority (§5). On every call they re-check that the token's user still has
the manage role for the owner, that the run is non-terminal, and that the
draft id equals the authority's. This follows the "check current authority on
every operation" rule in `services/cloud-agent-next/AGENTS.md`.

| Procedure | Purpose |
|---|---|
| `setupRuns.agent.getDraft` | Returns: requirements, repositories and their sandbox paths, the setup working directory, commands, plaintext vars, secret keys, allocation, sandbox allocations offered to this owner (with sizes), limits (`ENVIRONMENT_LIMITS`, timeouts, reserved keys), revision, and the last verification. |
| `setupRuns.agent.updateDraft` | `{expectedRevision, script?, plainVars?, secrets?: [{key, value} \| {key, delete:true}], sandboxAllocation?, egress?}`. Secrets are write-only, which lets the agent store values it generated itself, such as a local `NEXTAUTH_SECRET`. Returns the new revision. Any update clears `last_verification` freshness (§6). |
| `setupRuns.agent.requestSecrets` | `{secrets: [{key, reason}]}`. Sets status `needs_secrets` and records the requests. |
| `setupRuns.agent.recordVerification` | `{childSessionId, checks}`. See §6. |
| `setupRuns.agent.complete` | `{summary}`. Server-gated (§6). |
| `setupRuns.agent.fail` | `{reason}`. For when the requirement cannot be met, for example when it needs a host capability the sandbox lacks. The run fails fast with a specific reason instead of the agent spinning. |

Regenerate the MCP catalog (`apps/web/src/scripts/mcp-catalog/`) so the user
procedures appear for user-connected MCP clients. The `agent.*` procedures are
excluded from the general catalog.

### 4. Starting the setup session (`services/cloud-agent-next`)

- **Session creation.** `setupRuns.start` calls the existing
  `cloudAgentNext.prepareSession` / organization variant with:
  - The launch repository: the first repository in the draft.
  - `requestedEnvironment: {id: draftId}` and `requireEnvironmentChoice: true`.
  - `mode: 'code'` and the chosen model.
  - `runtimeSkills: [environment-setup skill]` (§7).
  - The prompt (§7), with `autoInitiate: true` and `autoCommit: false`.
  - New server-only field `environmentSetupRunId`.
- **Preflight:**
  - Strip any client-supplied `environmentSetupRunId`. Strip it the same way
    `environment` and `environmentSandboxAllocation` are stripped today.
  - Accept it only on the authenticated web→worker path that `setupRuns.start`
    uses. Concretely: a field the web router sets after its own authorization,
    carried like `kilocodeOrganizationId` and verified against the DB in
    preflight (run exists, owned by this user/org, non-terminal, draft matches
    `requestedEnvironment.id`).
  - Pass `allowDraft` to `loadEnvironmentForSession`.
- **Metadata.** Persist `environmentSetup: {runId, environmentId}` in grouped
  `SessionMetadata` (v2). The setup session also keeps
  `allowSubagentSessions = true`, because verification uses child sessions.
- **Grant.** Extend `issueCloudAgentMcpGrant`
  (`services/cloud-agent-next/src/cloud-agent-authority.ts:159`) to add the
  `environmentSetup` claim when the metadata has it. Child sessions never
  inherit `environmentSetup`. Children of a setup session also get
  `allowSubagentSessions = false`, which already holds for all children.
- **Sandbox.** The setup session must run in an isolated sandbox. It needs one
  for multi-repository work and for the MCP grant. Use the draft's allocation,
  else an isolated default. If no isolated allocation is offered to the owner,
  `start` fails with that reason before creating anything.

### 5. Scoped authority and MCP tools

**Authority claim** (`packages/worker-utils/src/cloud-agent-authority.ts`):
- Add an optional
  `environmentSetup: { runId: uuid, environmentId: uuid }` to
  `CloudAgentAuthoritySchema`, bumping to `version: 2` and accepting 1 and 2
  during rollout.
- `cloudAgentAuthorityProcedures` returns the `cloudEnvironments.setupRuns.agent.*`
  procedures only when the claim is present. Each has a strict input schema
  whose `runId` is pinned to the claim value, the same way `organizationId` is
  pinned today.
- `scopedPrepareSessionSchema` gains an optional
  `requestedEnvironment: {id}`. `validateCloudAgentAuthorityRequest` allows it
  only when it equals `authority.environmentSetup.environmentId`. This is how
  the agent starts verification children on the draft and nothing else.
- Add unit tests next to `cloud-agent-authority.test.ts`:
  - Pinning.
  - Rejecting another environment id.
  - Rejecting `agent.*` procedures without the claim.
  - Version compatibility.

**kilo-mcp** (`services/kilo-mcp/src/`):
- Add `environment-setup-tools.ts`, registered alongside `child-session-tools.ts`
  when the authority has `environmentSetup`.
- Tools:
  - `get_environment_draft`
  - `update_environment_draft`
  - `request_environment_secrets`
  - `verify_environment_draft`: wraps `prepareSession` with
    `requestedEnvironment` = draft, a fixed verification prompt template, and
    `callbackTarget: session:parent`, then calls `recordVerification` with the
    child id.
  - `report_verification_checks`
  - `complete_environment_setup`
  - `fail_environment_setup`
- Each tool description carries the essential constraints, so the agent
  behaves correctly even without the skill.

### 6. Verification model

Verification has two levels, kept apart so the UI never overstates what was
proven.

1. **The agent's inner loop, in its own sandbox:**
   - The setup session already has the repositories cloned at the real paths.
   - The agent runs the candidate script exactly as the wrapper would, with
     `bash -e -o pipefail -c "$SCRIPT"` from the setup working directory.
   - It checks the result (services healthy, tests runnable, and so on) and
     iterates quickly.
   - This sandbox becomes dirty, so it proves nothing about a fresh start.
2. **Clean-room verification, in a child session:**
   - `verify_environment_draft` spawns a child on the draft at its current
     revision. Real preparation runs: clone, variables and secrets, and the
     setup script with the real timeouts and redaction.
   - The child's prompt asks it to run the agent-supplied smoke checks and
     reply in a fixed structured format.
   - **Platform-verified facts** are read from the child's session state, not
     from the agent:
     - Preparation succeeded or failed.
     - The admitted `EnvironmentReference.configurationRevision`.
     - The setup duration.
     - The safe failure reason, such as `workspace_setup_failed` /
       `setup_command_timeout`.
   - **Agent-reported facts:** the smoke-check results and evidence, recorded
     through `report_verification_checks` and labelled as reported in the UI.
   - Add a small cloud-agent-next read on the web side
     (`getSessionPreparationOutcome`) if the existing `getSession` /
     `getMessageResult` responses do not already expose the preparation
     outcome and admitted revision.

**Completion gate (server-side in `agent.complete`):**
- `last_verification.configurationRevision == draft.configuration_revision`.
- Preparation `succeeded`.
- All requested secrets are satisfied.
- `verification_count ≤ MAX_VERIFICATIONS` (default 6).
- Otherwise the call is rejected with the specific unmet condition, so the
  agent cannot report success on unverified changes.

**Duration guard.** If verified setup takes more than 5 minutes, the run is
still `ready`. The panel warns that setup runs on every prepare and rebuild,
and the skill tells the agent to cache or trim first.

**Snapshot builds (optional).** For snapshot-enrolled organizations,
`verify_environment_draft` may additionally trigger a builder run. Builds use
saved settings, which the draft is. This is an extra signal, not the gate.
Draft builds must not publish a snapshot. Either the build path rejects drafts,
or the snapshot is keyed to the draft id and discarded on publish. Decide this
during Phase 4. The simplest choice is to reject drafts and build only after
publish.

### 7. Agent instructions

**Prompt.** Built server-side in `apps/web/src/lib/cloud-agent/environment-setup-prompt.ts`.
It is short and factual:
- The user's requirements, quoted verbatim and marked as user data.
- The repositories with their paths, and the setup working directory.
- The workflow: inspect → draft → run locally → `update_environment_draft` →
  `verify_environment_draft` → fix → `complete_environment_setup` /
  `fail_environment_setup`.
- Hard rules:
  - Do not commit, push or open PRs unless the requirement explicitly asks.
  - Never print secret values.
  - Never put secrets in the script.
  - Ask for user-owned credentials with `request_environment_secrets`.

**Runtime skill `environment-setup`.** Delivered through the existing
`runtimeSkills` session option. Source at
`apps/web/src/lib/cloud-agent/skills/environment-setup/SKILL.md`. Contents:

- **Where to look:** `AGENTS.md`, `DEVELOPMENT.md`, `README*`,
  `.kilo/cloud-agent-setup.sh` and other `*setup*.sh`, `.devcontainer/`,
  `docker-compose*.yml`, `Makefile`, `package.json` scripts,
  `.tool-versions` / `.nvmrc` / `flake.nix`, `.env*.example`, CI workflows.
  These are the best record of a working setup.
- **Preparation contract:**
  - One Bash script, at most 16,000 characters.
  - It runs with `-e -o pipefail` at the given working directory.
  - It runs on every prepare and rebuild, including on top of a snapshot, so
    it must be **idempotent and fast**.
  - Timeouts: 5 min inactivity, 8 min hard.
  - Variable limits and reserved keys: `HOME`, `SESSION_*`, `XDG_*`, `KILO*`,
    `OPENCODE*`.
  - Every new variable is stored as a secret unless set as plaintext through
    `plainVars`.
- **Prefer the repository's own setup.** If the repository already ships a
  setup script, prefer a thin environment script that calls it, such as
  `bash .kilo/cloud-agent-setup.sh`, over copying its logic. If the logic does
  not fit in 16,000 characters and the repository has no script, say so in
  the summary and suggest committing one.
- **Sandbox size:** pick the smallest offered allocation that passes.
  Docker-in-sandbox and full stacks usually need a larger one.
- **Variables:**
  - Generated local-only values may be set as secrets by the agent.
  - Real third-party credentials must be requested from the user.
- **Verification checks:**
  - Define concrete smoke checks that prove the user's requirement, not just
    "the script exited 0".
  - Examples: `pnpm dev:status`, a health curl, one focused test.
- **When to stop:** call `fail_environment_setup` with a specific reason when
  the requirement needs something the sandbox cannot provide (privileged
  kernel features, unreachable private networks, missing integration access).

### 8. UI (`apps/web/src/components/cloud-agent-next/`)

Follow `DESIGN.md` and the `kilo-design-cloud` skill.

- `EnvironmentSetupAgentDialog.tsx`: the start form, reusing
  `EnvironmentRepositoriesField` and the model picker.
- Entry buttons in `EnvironmentDialog.tsx` (overview page),
  `RepositoryEnvironmentChip.tsx` and `settings/EnvironmentsSection.tsx`.
  They are hidden for members without the manage role and when the toggle is
  off.
- `EnvironmentSetupRunPanel.tsx`: status, secrets form, diff, verification and
  actions. It is shown in the setup chat (keyed by session metadata
  `environmentSetup.runId`) and in the environment editor.
- Hook `useEnvironmentSetupRun.ts` wraps the `setupRuns.*` procedures.
- Lists show drafts as "Draft (setup in progress)" under their target, or as
  their own entry for new environments. Drafts never appear in the new-session
  environment choice.

### 9. Network / egress (Phase 5)

Environments have no network settings today. Steps:

1. Add `egress_mode` / `egress_allowlist` to `cloud_agent_environments`,
   reusing `egressPolicySchema`.
2. Add them to `EnvironmentSessionLayer`.
3. Merge them in preflight. An explicit request value wins, consistent with
   the existing precedence, unless product decides an environment allowlist
   is a floor. **Open question.**
4. Add them to the editor.
5. Add `egress` to `updateDraft` / `getDraft`.
6. Run verification children with `egressAudit: true`. The agent can then
   derive an allowlist from observed hosts and re-verify in `allowlist` mode.

Allowlist and audit need `cloudflare-containers`, so the tool reports when the
owner's sandbox cannot enforce them. This phase also requires updates to the
spec and egress documentation.

## Worked example: Kilo-Org/cloud + local dev stack

1. **Start.** The user picks `Kilo-Org/cloud` and writes "set it up to use the
   local dev stack for the Cloud Agent". `start` creates a draft and the setup
   session; the repository is cloned at `/workspace/cloud`.
2. **Inspect.** The agent reads `AGENTS.md` and finds
   `.kilo/cloud-agent-setup.sh` and the `cloud-agent-sandbox` skill (memory
   cgroup, Docker, pnpm, `.env.local`, test DB, seeded fake user, sandbox
   images).
3. **Draft and test locally.** The draft script is
   `bash .kilo/cloud-agent-setup.sh`. The agent runs it locally, sees that
   Docker needs a larger allocation, and picks one from `getDraft`'s offered
   list. It requests no secrets, because local dev uses generated or fake
   values.
4. **First verification.** The child prepares from scratch. Setup passes in
   6m10s. The agent-supplied checks are `pnpm dev:status --json` with all
   services healthy, and the fake login endpoint returning 200. The duration
   warning appears.
5. **Second verification.** The agent moves image pre-pulls behind an
   idempotence check, then verifies again: 4m40s.
6. **Complete.** `complete` succeeds, and the panel shows the diff and
   evidence.
7. **Publish.** The user clicks Publish. Later sessions on `Kilo-Org/cloud`
   prepare with this environment.

## Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| 0 | Spec: new section "Environment setup agent" in `.specs/cloud-agent-session.md` (drafts excluded from matching, permissions, secret handling, completion gate, publish/conflict, failure reasons). Update `services/cloud-agent-next/docs/control-plane.md` for `environmentSetup` metadata/grant. Resolve open questions. | Spec reviewed |
| 1 | DB migration, draft status, setup-run table, domain service (`createDraftEnvironment`, `publishDraftEnvironment`, matching exclusion, `allowDraft`), cleanup job | Unit tests: drafts never match implicitly; publish new/existing; revision conflict; envelope copy without decryption |
| 2 | Authority v2 claim, scoped procedures, `agent.*` web procedures, kilo-mcp tools, grant issuance from session metadata | Authority unit tests; kilo-mcp tests; web router tests for role re-check, pinned run id, terminal-run rejection |
| 3 | `setupRuns.start/get/provideSecrets/cancel/publish`, prompt builder, runtime skill, preflight acceptance of `environmentSetupRunId`, UI dialog + panel, release toggle | Local stack E2E with fake LLM (`cloud-agent-local-testing` skill): start → draft update → publish |
| 4 | Clean-room verification via child sessions, preparation-outcome read, completion gate, duration warning, verification cap | E2E: failing script → `workspace_setup_failed` recorded with revision; fixed script → `ready`; `complete` rejected on stale revision |
| 5 | Environment-level egress + audit-derived allowlist | Spec + tests; verification in allowlist mode on `cloudflare-containers` |
| 6 | Optional post-publish snapshot build for enrolled organizations; "refine" entry from failed sessions (`workspace_setup_failed` → "Fix with agent", prefilled with the failure) | Toggle rollout to internal org, then GA |

## Failure UX

Per the Failure UX rules in the root `AGENTS.md`:

- `start` fails immediately, with a specific reason and nothing created, when:
  - The repository access check fails.
  - No isolated sandbox is offered.
  - The user lacks the manage role.
  - The balance is insufficient.
- **Setup session ends without the agent calling `complete` or `fail`**
  (`no_progress`, `execution_limit`, interruption, model failure): `setupRuns.get`
  derives `failed`, with the session's safe failure reason, from the session's
  terminal message state. The run must not sit in `running`. Store it on first
  observation.
- **A verification child fails preparation:** the outcome is recorded and
  returned to the agent through the parent callback. One failure fails only
  that verification, not the run.
- **Secret wait:** a `needs_secrets` run's agent turn ends. Providing secrets
  sends the follow-up and resumes promptly. A run that waits more than 7 days
  becomes `cancelled`.
- **Verification cap reached:** the run fails with "verification limit
  reached", the last evidence and the draft. The user can publish with
  `force` or ask the agent to continue, which raises the cap once.

## Security

- **The agent's authority is narrow.** It is limited to one draft and one run,
  expires with the grant, and is re-checked against the user's current role on
  every call. It cannot read secret values, touch other environments, publish,
  or delete.
- **Drafts are protected from ordinary sessions.** They resolve only for
  sessions carrying a server-verified `environmentSetupRunId`, or for that
  run's direct children with the draft pinned in the authority.
- **Secret values travel only in the following ways:**
  - From the user through the panel (`provideSecrets`).
  - From the agent through `updateDraft` (write-only).
  - Server-side envelope copies.
  - They are never in prompts, chat, tool results or logs. Use the existing
    redaction (`redactsNamedSecrets`) and `redactSensitiveHeaders` where
    relevant.
- **The requirements text is user data.** The prompt quotes it, and it never
  widens tool authority.
- **Publication stays a user action** in this plan (see the open question on
  auto-publish).

## Testing

- **Unit:**
  - Authority schema and pinning.
  - Domain service: matching exclusion, publish, conflict, envelope copy,
    cleanup.
  - Prompt builder.
  - Run status derivation.
  - Completion gate.
- **Integration (Workers):**
  - Preflight accepts `allowDraft` only with a verified run.
  - Grant includes `environmentSetup` only for the setup session, never for
    children.
- **kilo-mcp:** tool registration by claim, and argument pinning.
- **Web router:** permissions (member denied, billing manager denied),
  toggle-off denied, idempotent `start`.
- **E2E with local stack and fake LLM:** scripted tool calls covering the happy
  path, a failing script, a needs-secrets → provide → verify path, a stale
  revision complete, and cancel.
- **Manual dogfood** on `Kilo-Org/cloud` with the worked example, measuring
  setup duration and verification count.

## Open questions

1. **Auto-publish:** should a `ready` run publish automatically when the user
   ticks "publish when verified" at start? The plan defaults to manual
   publication.
2. **Repository commits:** may the agent open a PR that adds a repository
   setup script, such as `.kilo/cloud-agent-setup.sh`, when the logic exceeds
   16,000 characters? This would be opt-in per run.
3. **Egress precedence:** should an environment allowlist be a floor that a
   request cannot widen, or a default that a request overrides?
4. **Personal accounts and snapshots:** extend snapshot enrollment, or keep
   child-session verification as the only clean-room check for personal
   owners?
5. **Billing:** should verification children be visibly attributed to the
   setup run in usage views?
