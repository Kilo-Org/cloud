# Cloud Agent Environment Setup Agent

Date: 2026-11-03
Status: Proposed plan, revised after product review. Nothing is implemented yet.
Depends on: #9155 (multi-repository environments, merged) and #8899 (environment
network controls, open).

## Goal

The user chooses one or more repositories and writes what they need in plain
language. For example: "set up Kilo-Org/cloud so the Cloud Agent can use the
local dev stack". After they submit, a Cloud Agent session starts on those
repositories. The agent:

1. Works out the setup script, variables, secrets, sandbox size and network
   access that meet the requirement.
2. Writes them into a **draft** repository environment through scoped tools. It
   never touches environments it was not given.
3. Tests the draft in a fresh sandbox, using the same preparation path that real
   sessions use, and repeats until the draft passes.
4. **Publishes automatically** once the draft passes. "Passes" is a server-checked
   gate. The agent's own claim is not enough.

The user does not write the script, variables, sandbox size or network policy.
They only enter secrets the agent cannot create itself. If they dislike the
result, they revert it in one click.

## Product decisions

| Question | Decision |
|---|---|
| Publication | Automatic when the completion gate passes. The previous configuration is kept, so the user can revert in one click. |
| Setup larger than 16,000 characters | The agent MAY open a PR that adds a setup script to the repository. The environment's script then calls that file. See §8. |
| Network | Uses the environment network controls from #8899. Only the user changes the policy (None / Limited / Full, plus extra hosts, and request overrides). The agent records a **minimum network** the environment needs. When the policy is restricted, the user must approve every host the agent adds. See §10. |
| Network of setup and test sessions | They follow the same resolution as any session: organization settings and defaults (once they exist), then the environment's policy, then the platform default. The setup feature never grants a broader policy. |
| Who approves secrets and network requests | Anyone allowed to manage the environment: the personal owner, or an organization owner or admin (`ORGANIZATION_MANAGE_ROLES`, the same check as `create` and `update`). Only these roles can start a run, so the person who started it can approve its requests; no second approver is needed. Other members and billing managers see requests read-only. The role is checked again at approval time. |
| Dropping the minimum for one session | Not supported for now. A follow-up shows a **suggestion** the user can adopt (§10). |
| Where secrets go | Only in the existing environment editor's Variables page, opened from a request notice in the chat. The chat itself never shows input fields. The start form also accepts secrets up front. See "Secrets". |
| Snapshot builds | Enabled for every owner, including personal accounts (`ENVIRONMENT_SNAPSHOT_ORG_IDS="*"` on main). Every publish triggers a snapshot build. A build only runs the setup and does not run smoke checks, so the gate stays the child-session test. |
| Usage attribution | No special handling. Setup and test sessions are ordinary Cloud Agent sessions, billed to the same owner like any other session. |

## What exists today

| Area | Current state | Source |
|---|---|---|
| Environment record | `cloud_agent_environments` has: name, a V1 repo identity or V2 `repositories` jsonb, `commands text[]` (at most 1 script of 16,000 chars), `configuration_revision`, `sandbox_allocation`. Owned by a user or by an organization. | `packages/db/src/schema.ts:8390` |
| Variables / secrets | `cloud_agent_environment_vars` (`is_secret`, RSA+AES envelope). The API never returns secret values. | `packages/db/src/schema.ts:8516` |
| Network (#8899) | `egress_mode` (`null`, `unrestricted`, or `allowlist`) and `egress_allowlist text[]`. UI labels: None (allowlist, no extra hosts), Limited (allowlist plus hosts), Full. The server-owned baseline of Kilo, Git and repository host always applies. Preflight applies the saved allowlist only when the request names no policy. Scoped children inherit the parent's **recorded** policy and fail closed. | PR #8899 |
| Domain service | `createEnvironment`, `updateEnvironment`, `loadEnvironmentForSession`, `selectEnvironmentForSession`, `ENVIRONMENT_LIMITS`, reserved keys | `packages/cloud-agent-profile/src/environment-*.ts` |
| API | `cloudEnvironments.{list,listAll,get,create,update,delete,build,buildStatus,buildLogs,cancelBuild}`. Owners and admins can manage; members can only read. | `apps/web/src/routers/cloud-environments-router.ts` |
| UI | `EnvironmentDialog` (overview / scripts / variables / network), `RepositoryEnvironmentChip`, settings `EnvironmentsSection` | `apps/web/src/components/cloud-agent-next/` |
| How a session uses an environment | Preflight picks the environment for implicit origins. `requestedEnvironment` picks one explicitly. The setup script runs with `bash -e -o pipefail` after clone, in `/workspace/<name>` (one repo) or `/workspace` (several). Timeouts are 5 min without output and 8 min total. A failure is reported as `workspace_setup_failed`. | `session-creation-preflight.ts`, `wrapper/src/control-plane/repository-preparation.ts:266` |
| Revision on session | `EnvironmentReference.configurationRevision` records which revision a session ran with. | `packages/cloud-agent-profile/src/environment-contracts.ts:183` |
| Snapshot builds | The **Build** button in the environment editor (`EnvironmentBuildPanel`). It runs the saved setup in a fresh builder container and saves a disk snapshot, so later sessions start faster. Enabled for every owner, personal accounts included (`ENVIRONMENT_SNAPSHOT_ORG_IDS="*"`). | `services/cloud-agent-next/src/environment-build/`, `wrangler.jsonc` |
| Organization network settings | None exist on main. Today a session's network comes from the request or the environment (#8899). | — |
| Secret exposure at runtime | Environment secrets are decrypted into the environment of every session that uses the environment. The agent in those sessions can read them (`env`). Output redaction (`redactsNamedSecrets`) masks known values on a best-effort basis; it is not a guarantee. | `services/cloud-agent-next/docs/control-plane.md:629` |
| Platform tools inside the sandbox | The `kilo-cloud-agent` MCP receives a `delegated-workload` JWT with a `cloudAgentAuthority` claim. Its allowlist covers only child-session and folder procedures, so it **cannot read or change environments**. | `packages/worker-utils/src/cloud-agent-authority.ts`, `services/kilo-mcp/src/child-session-tools.ts` |
| Egress audit | Opt-in, bounded audit of the hosts a sandbox contacted. Requires `cloudflare-containers`. | #7608, `packages/worker-utils/src/egress-audit.ts` |

What this means for the design:

- **The agent must work on a draft.** A new active row that contains a repository
  takes part in environment matching immediately. If the repository had exactly
  one environment, it now has two. Slack, webhook and scheduled sessions then
  start with **no** environment (spec start rule 16). Editing an existing
  environment in place would also give every session the unverified changes.
- **Snapshot builds are not the test.** They are available to everyone, but they
  only prove that setup exits 0. A normal child session that names the draft
  runs setup, the network policy and the agent's smoke checks.
- **The agent needs a new, narrow authority.** Today's user-level MCP catalog
  exposes all of `cloudEnvironments.*`, which is the user's full power. The
  sandbox authority must reach only one draft.
- **Test children need the draft's network policy, not the parent's.**
  Under #8899 a scoped child inherits its parent's recorded network policy. A
  test child must instead use the draft's policy, and every part of that policy
  must be set or approved by the user (§6, §10).
- **A secret request is new; secret exposure is not.** Secrets in an environment
  already reach every session that uses it. What the agent changes is that it
  *asks* for credentials. That is a phishing-shaped interaction, and repository
  content can steer it through prompt injection. The design has to make the
  request look and behave like platform UI, not like the agent asking for a
  password ("Secrets").

## User flow

1. **Entry points:**
   - "Set up with agent" in the environment editor, for a new or an existing
     environment.
   - "Set up automatically" on the repository environment chip in the
     new-session form.
2. **Form:**
   - Repositories: the existing `EnvironmentRepositoriesField`, prefilled.
   - Requirements: a required free-form textarea, at most 8,000 characters.
   - Model and variant: the existing picker, preselected with the same default
     as the new-session form. Normal balance rules apply. This is the only
     agent choice:
     - The mode is fixed to `code`.
     - The agent's behavior comes from the built-in `environment-setup` skill
       and prompt.
     - No profile or custom agent is selectable, so the session's tools and
       instructions stay predictable.
     - The test sessions use the same model (§6).
   - Optional name.
   - Optional **Secrets**: the same `KEY=value` editor as the environment
     editor's Variables page, for credentials the user already knows are needed.
3. **Submit.** The server creates a draft and a setup run, then starts the setup
   session. The user lands in that Cloud Agent chat. The requirement is the
   visible first message, and preparation and agent work stream as usual.
4. **While the agent works,** a setup-run card in the chat header shows:
   - The status.
   - Pending requests: secrets and network hosts the agent asked for, each with
     a button that opens the environment editor (no inputs on the card).
   - The difference between the draft and the current environment.
   - The latest test: which revision, whether preparation passed and how long
     setup took, the agent's smoke checks, and a link to the test chat.
   - If the agent opened one, the setup PR.
5. **Publication.** When the gate passes, the draft is published automatically
   (§7) and the card shows **Published**. A **Revert** button restores the
   previous configuration. A new environment has no earlier version, so its
   button is **Delete** instead. A snapshot build starts automatically. The
   Published card lists any secrets and network hosts the run added.
6. **Talking to the agent.** The user can message the agent at any time to answer
   its `question` prompts or to redirect it. **Ask agent to change…** is just a
   chat follow-up. A change after publish opens a new run that refines the
   environment.

### Secrets

#### What is and is not protected

- **Protected:** secret values never pass through chat, prompts, tool results,
  commits or logs. No setup tool returns a value. Values are stored encrypted,
  exactly like secrets entered in the editor today.
- **Not protected, and the UI must say so:** once saved, a secret is available
  as an environment variable to every session that uses the environment. That
  includes the agent's test sessions and, after publication, every future
  session, including other organization members' sessions. Any agent in those
  sessions can read it. Output redaction is best-effort. This is how
  environment secrets work today; the setup agent does not change it.
- **The new risk is the request itself.** An agent asking for credentials looks
  like phishing. Repository content or the requirement text can also steer the
  agent (prompt injection) into asking for a high-value credential with a
  plausible reason. If that secret later reaches a session with open network
  access, it can be exfiltrated.

#### Design

Secrets enter in three ways.

1. **The start form's Secrets field.** It is the standard `KEY=value` editor,
   for keys the user knows up front.
2. **A request from the agent.** The agent calls `request_environment_secrets`
   with, for each key:
   - the key name;
   - a reason;
   - **references**: where the repository uses the key, as
     `{repository, path, line}`, for example `apps/web/.env.example:42`.

   **The chat never shows an input field.** It shows a platform notice in
   distinct system styling, never rendered from agent markdown: "The setup
   agent requested 2 secrets for environment *cloud (draft)*", with an **Add
   secrets** button. The button opens the **existing environment editor** on
   its Variables page for the draft. The requested keys are listed there as
   pending entries, each with:
   - the agent's reason, labelled "Reason given by the agent";
   - links to each reference at the commit being set up. For GitHub, the server
     checks that the key name actually appears at that path. If it does not,
     the entry says "Not found in the repository";
   - fixed platform copy: "Stored encrypted in *environment name*. Every session
     that uses this environment can read it, including other members' sessions
     in *organization*. Prefer a test or restricted key."
   - a high-privilege warning when the name matches patterns such as
     `AWS_SECRET_ACCESS_KEY`, `*_ADMIN*`, `*PROD*`, `GITHUB_TOKEN`,
     `*_SERVICE_ROLE*`, or when the requirement text does not mention the key's
     integration.

   **Skip — not needed** is always available, and the run never waits on the
   user without an end (Failure UX). Saving or skipping:
   - writes the encrypted values into the draft, using the editor's existing
     storage and the existing `cloudEnvironments.update` permission checks;
   - marks each request `provided` or `skipped`;
   - sends the agent a follow-up that names the keys and their states but
     contains no values.
3. **Values the agent generates itself,** such as a random local
   `NEXTAUTH_SECRET`. The agent writes them through `update_environment_draft`.
   They are stored as secrets and never echoed back. The Published card lists
   them as "Generated by the agent".

**Limits:**
- At most 10 keys per request and 20 per run.
- Keys follow the existing key rules and reserved names.
- The agent cannot request a key that already holds a value in the draft. To
  replace one, it explains why in chat and the user edits it in the editor.

**Why this should earn trust:**
- Values are typed only into the screen where users already manage environment
  secrets, never into something that looks like chat.
- The user sees where the key will be stored and who can read it.
- The user sees the evidence for the request (the key in the repository's own
  files) and can always skip.
- The agent itself is shown as untrusted: its reason is labelled as the agent's,
  and its references are checked.

**Follow-up:** warn when a user pastes something that looks like a secret into
the chat composer during a setup run, and point them to the editor.

When a draft refines an existing environment, the draft starts with that
environment's secrets. The encrypted envelopes are copied server-side without
being decrypted. The user only enters keys that are new.

Published secrets are ordinary environment secrets. They appear as
`KEY=<unchanged>` in the editor and can be replaced or deleted there as usual.

## Architecture

```
Web UI ──setupRuns.start──▶ web tRPC
                               │ 1. create draft env (+ copy target) + setup run
                               │ 2. prepareSession(requestedEnvironment=draft,
                               │      environmentSetupRunId, runtimeSkills=[env-setup])
                               ▼
                       cloud-agent-next setup session (isolated sandbox)
                               │ wrapper injects kilo-cloud-agent MCP; grant carries
                               │   cloudAgentAuthority.environmentSetup = {runId, environmentId}
                               ▼
                  kilo-mcp environment-setup tools ──call──▶ web tRPC setupRuns.agent.*
                               │                               (re-check role, run, draft)
                               │ verify_environment_draft ──▶ child session
                               │      (draft env + draft network policy, egress audit,
                               │       no setup/spawn authority)
                               ▼
                       complete_environment_setup ──▶ gate ──▶ auto-publish
                                                         └─▶ waiting_for_merge (setup PR)
```

### 1. Data model (`packages/db`)

Follow `packages/db/AGENTS.md` and the `database-migrations` skill. The
migration comes after #8899's `0331`.

**`cloud_agent_environments`:**

- `status text not null default 'active'`, with a check
  `in ('active','draft')`.
- `draft_for_environment_id uuid null`, a foreign key to
  `cloud_agent_environments` with `on delete cascade`. It names the target that
  publication replaces. Null means the draft becomes a new environment.
- `egress_required_hosts text[] null`: the minimum network this environment
  needs (§10).
  - It uses the same hostname validation as `egress_allowlist`.
  - Like `egress_allowlist`, it is a build input.
  - The setup agent adds to it directly only under Full. Under a restricted
    policy, hosts enter only after the user approves them. The editor shows the
    list read-only, with a "Clear" action.
- The V1 partial unique indexes need a `where status = 'active'` predicate, so
  that a V1-era repository can still get a draft.

**New table `cloud_agent_environment_setup_runs`:**

| Column | Type / content |
|---|---|
| `id` | `uuid` primary key |
| Owner columns | Same as `cloud_agent_environments`, with the XOR check |
| `created_by_user_id` | |
| `draft_environment_id` | Foreign key, cascade |
| `target_environment_id` | Nullable foreign key, `set null` |
| `requirements` | `text` |
| `model`, `variant` | `text` |
| `cloud_agent_session_id` | `text` (`workspace_*`) |
| `status` | `text`, one of `starting`, `running`, `needs_secrets`, `needs_approval`, `verifying`, `waiting_for_merge`, `published`, `publish_conflict`, `failed`, `cancelled`, `reverted` |
| `requested_secrets` | `jsonb`: `[{key, reason, references: [{repository, path, line, verified?}], state: 'pending'\|'provided'\|'skipped'}]`. Never contains values. |
| `network_requests` | `jsonb`: `[{kind: 'host', host, reason, evidence: {deniedCount, firstSeenAt, childSessionId}, state: 'pending'\|'approved'\|'declined'}]`. Used only when the user's policy is restricted (§10). |
| `setup_pull_request` | `jsonb`: `{platform, repository, number, url, branch, state}` or null |
| `last_verification` | `jsonb`: `{childSessionId, configurationRevision, preparation: 'pending'\|'succeeded'\|'failed', failureReason?, setupDurationMs, egressMode, observedHosts?, checks: [{name, passed, evidence}], reportedAt}` |
| `verification_count` | `int` |
| `previous_configuration` | `jsonb`: commands, plaintext vars, **secret envelopes**, allocation, network fields, repositories and revision of the target at publish time. Revert uses it. |
| `published_revision` | `int` |
| `summary`, `failure_reason` | `text` |
| `created_at`, `updated_at`, `completed_at` | |

Partial unique indexes allow one non-terminal run per draft and one per target.
`previous_configuration` holds only envelopes. Its retention follows the run
row, and it is deleted with the target environment.

### 2. Domain service (`packages/cloud-agent-profile`)

- **Matching ignores drafts.**
  - `selectEnvironmentForSession`, `listEnvironmentsForOwner` and the
    repository-match queries skip `status = 'draft'`.
  - The one exception is an explicit `environmentId` that names a draft, passed
    with `allowDraft: { setupRunId }` while the run is not terminal.
- **`createDraftEnvironment({owner, repositories, name, targetEnvironmentId?, initialSecrets?})`.**
  For a target, it copies the commands, plaintext vars, secret envelopes,
  repositories, allocation, `egress_mode`, `egress_allowlist` and
  `egress_required_hosts`.
- **`publishDraftEnvironment({draftId, expectedTargetRevision})`.** It runs in
  one transaction.
  - **New environment:**
    - Re-run the `create` checks: allocation offered, multi-repository needs an
      isolated sandbox, network validation.
    - Flip the draft to `active`.
  - **Existing target:**
    - Check the target's revision against the one recorded when the draft was
      forked.
    - Store the target's current config in `previous_configuration`.
    - Apply the draft through `updateEnvironment` semantics. This bumps
      `configuration_revision`.
    - Delete the draft.
  - **If the target changed** after the fork, for example because a user edited
    it meanwhile: no publish. The run becomes `publish_conflict`, and the card
    shows a three-way difference with **Publish anyway** or **Discard**.
    Automatic publication never overwrites a concurrent human edit.
- **`revertSetupRun({runId})`.**
  - For a published refinement, re-apply `previous_configuration`. This creates
    a new revision, not a rollback of the revision number.
  - For a new environment, delete it.
  - Refuse if the environment changed after publish, unless forced.
- **Draft updates reuse `updateEnvironment`.** Existing limits, reserved keys,
  secret encryption and network validation all apply.
- **Cleanup.** The existing web cron infrastructure deletes drafts of terminal,
  unpublished runs after 14 days.

### 3. Web API (`apps/web/src/routers/cloud-environments-router.ts`)

A new `setupRuns` sub-router, behind the release toggle
`cloud-agent-environment-setup-agent` (`isReleaseToggleEnabled`).

**User procedures.** These need the manage role, the same as `create` and
`update`.

| Procedure | Purpose |
|---|---|
| `setupRuns.start` | **Input:** `{organizationId?, repositories, requirements, model, variant?, name?, targetEnvironmentId?, secrets?, operationKey}`.<br>**Checks before creating anything:** repository access (`assertEnvironmentRepositoriesAccess`), that an isolated sandbox is offered, the balance, and the toggle.<br>**Then:** creates the draft and the run, and starts the session (§4).<br>**Returns:** `{runId, cloudAgentSessionId}`. Idempotent on `operationKey`. |
| `setupRuns.get` / `setupRuns.listForEnvironment` | Run state, the draft view (keys only for secrets), and the difference from the target. Also derives failure from the session's terminal state (see Failure UX). |
| `setupRuns.provideSecrets` | `{runId, secrets: [{key, value}], skipped?: string[]}`. Called by the environment editor's Variables page when it is opened for a draft with pending requests. Writes encrypted values to the draft and sends the agent a follow-up without values. |
| `setupRuns.resolveNetworkRequests` | `{runId, approved: string[], declined: string[]}`. Called from the editor's Network page. Needs the manage role, like every user procedure in this table; it is checked again on each call. Approved hosts are added to the draft's `egress_required_hosts`, and the agent gets a follow-up. |
| `setupRuns.publish` | Manual publish, used for `publish_conflict`, `waiting_for_merge` (publish before merge) or `failed`. Needs `force: true` when the draft is unverified. |
| `setupRuns.revert` | §2 `revertSetupRun`. |
| `setupRuns.cancel` | Interrupts the setup session and its test children through the existing interrupt path, and marks the run `cancelled`. The draft is kept until cleanup. |

**Agent procedures.** These can only be reached with an environment-setup
authority (§5). Each call re-checks three things: the user still has the manage
role, the run is not terminal, and the draft id equals the authority's.

| Procedure | Purpose |
|---|---|
| `setupRuns.agent.getDraft` | Returns everything the agent needs to plan:<br>• the requirements (marked as user data);<br>• the repositories, their sandbox paths and the setup working directory;<br>• commands and plaintext vars, plus the keys of secrets;<br>• the allocation and the allocations offered with their sizes;<br>• network: the user's mode and allowlist, the required hosts, the baseline description, and whether the owner's sandbox can enforce allowlists or audit;<br>• limits (`ENVIRONMENT_LIMITS`, timeouts, reserved keys);<br>• the revision, the last test result and the setup PR. |
| `setupRuns.agent.updateDraft` | `{expectedRevision, script?, plainVars?, secrets?: [{key, value} \| {key, delete:true}], sandboxAllocation?, requiredHosts?}`. Returns the new revision. **Network rule, enforced by the server:** the agent never changes `egressMode` or `egressAllowlist`. `requiredHosts` is accepted directly only when the user's policy is Full or unset. Under a restricted policy it is rejected with "use `request_network_hosts`" (§10). |
| `setupRuns.agent.requestSecrets` | `{secrets: [{key, reason, references}]}`. Validates the limits, verifies the references where possible, and sets the status to `needs_secrets`. |
| `setupRuns.agent.requestNetworkHosts` | `{hosts: [{host, reason, childSessionId}]}`. Only under a restricted policy. The server attaches evidence from that child's egress audit: the host must appear there as `denied`, otherwise the request is rejected. Sets the status to `needs_approval`. A request to change the policy itself (for example "this needs Full access") goes through `fail` or a chat message, never a tool. |
| `setupRuns.agent.recordVerification` | `{childSessionId}`, then `{checks}`. See §6. |
| `setupRuns.agent.recordSetupPullRequest` | `{platform, repository, number, branch}`. The server checks that the PR exists, belongs to a draft repository and targets its default branch (§8). |
| `setupRuns.agent.complete` | `{summary}`. Gated, and then publishes automatically (§7). |
| `setupRuns.agent.fail` | `{reason}`. Ends the run quickly with a specific reason when the requirement cannot be met. |

Regenerate the MCP catalog (`apps/web/src/scripts/mcp-catalog/`) so the user
procedures appear for user-connected MCP clients. Leave `agent.*` out of the
general catalog.

### 4. Starting the setup session (`services/cloud-agent-next`)

- **Session creation.** `setupRuns.start` calls the existing
  `cloudAgentNext.prepareSession` (or its organization variant) with:
  - the first draft repository as the launch repository;
  - `requestedEnvironment: {id: draftId}` and `requireEnvironmentChoice: true`;
  - `mode: 'code'`, the chosen model, and
    `runtimeSkills: [environment-setup skill]` (§9);
  - the prompt (§9), `autoInitiate: true`, and `autoCommit: false`. Any PR is
    opened explicitly by the agent (§8);
  - a server-only `environmentSetupRunId`.
- **Network of the setup session.**
  - The setup session itself runs with `egressAudit: true` when the owner's
    sandbox supports it.
  - Its egress policy is resolved **exactly like any other session**:
    organization settings and defaults (none exist on main yet; they apply once
    they do), then the draft's policy (copied from the target, or unset for a
    new environment), then the platform default. The setup feature adds no
    exception and never widens the policy.
  - Under a restricted policy, the audit's `denied` records show the agent what
    is missing. It asks for those hosts through `request_network_hosts` (§10).
    Its own policy stays fixed for the life of the session; approved hosts take
    effect in its test children.
  - If organization settings forbid something the requirement needs (for
    example a registry outside the organization's allowed hosts), the agent
    calls `fail_environment_setup` with that specific reason. It does not try
    to work around it.
- **Preflight.**
  - Remove any `environmentSetupRunId` the client sent.
  - Accept it only from the authenticated web path, then check it against the
    database: the run exists, belongs to this user or organization, is not
    terminal, and its draft equals `requestedEnvironment.id`.
  - Pass `allowDraft` to `loadEnvironmentForSession`.
- **Metadata.** Persist `environmentSetup: {runId, environmentId}` in the grouped
  `SessionMetadata` (v2), with `allowSubagentSessions = true`.
- **Grant.** `issueCloudAgentMcpGrant`
  (`services/cloud-agent-next/src/cloud-agent-authority.ts:159`) adds the
  `environmentSetup` claim. Children never inherit it.
- **Sandbox.** The session must be isolated, because multi-repository runs and
  the MCP grant both need it. It uses the draft's allocation or an isolated
  default. If none is offered, `start` fails with that reason before creating
  anything.

### 5. Scoped authority and MCP tools

**Authority** (`packages/worker-utils/src/cloud-agent-authority.ts`):

- **Claim.** Add an optional `environmentSetup: { runId: uuid, environmentId: uuid }`
  to `CloudAgentAuthoritySchema`. The version becomes `2`; accept 1 and 2 during
  rollout.
- **Allowed procedures.** `cloudAgentAuthorityProcedures` adds the
  `cloudEnvironments.setupRuns.agent.*` procedures only when the claim is
  present. Each procedure pins `runId` to the claim, the same way
  `organizationId` is pinned today.
- **Spawning test children.** `scopedPrepareSessionSchema` gains an optional
  `requestedEnvironment: {id}` and an optional `verificationOf: {runId}`. Both
  are allowed only when they equal the claim. Only `verify_environment_draft`
  uses them.
- **Tests.** Cover pinning, rejecting another environment id, rejecting
  `agent.*` without the claim, and version compatibility.

**kilo-mcp** (`services/kilo-mcp/src/environment-setup-tools.ts`):

- Registered next to `child-session-tools.ts` when the claim is present.
- Tools:
  - `get_environment_draft`
  - `update_environment_draft`
  - `request_environment_secrets`
  - `request_network_hosts`
  - `verify_environment_draft`: spawns the test child (§6) with
    `callbackTarget: session:parent`, then records it.
  - `report_verification_checks`
  - `record_setup_pull_request`
  - `complete_environment_setup`
  - `fail_environment_setup`
- Each tool description carries the constraints that matter, so the agent
  behaves correctly even without the skill.

### 6. Verification model

There are two levels. The UI never overstates what was proven.

1. **Inner loop, in the setup sandbox.**
   - The setup sandbox already has the repositories at the real paths.
   - The agent runs the candidate script exactly as the wrapper would:
     `bash -e -o pipefail -c "$SCRIPT"` from the setup working directory.
   - It iterates quickly, but the sandbox becomes dirty, so this proves nothing
     about a fresh start.
2. **Clean test, in a child session.**
   - `verify_environment_draft` spawns a child on the draft at its current
     revision. Real preparation runs: clone, variables and secrets, the setup
     script with its real timeouts and redaction, and the network policy.
   - **Network for the child.** Preflight checks `verificationOf` against the
     parent's `environmentSetup` metadata. It then resolves the child's policy
     like any session on the draft: organization settings and defaults, then
     the draft's effective policy (the user policy plus `egress_required_hosts`,
     §10), instead of inheriting the parent's recorded policy.
     - This is safe because every part of the draft's policy was set or approved
       by the user. The agent cannot change the mode or allowlist, and under a
       restricted policy it cannot add required hosts without approval.
     - If the draft's policy cannot be loaded or validated, preflight fails
       closed, as #8899 does for inherited policies.
     - When supported, the child also runs with `egressAudit: true`.
   - The child's prompt asks it to run the agent's smoke checks and reply in a
     fixed structured format.
   - The child uses the run's model and variant. The server sets them, and
     `verify_environment_draft` takes no model argument.
   - **Facts the platform verifies** (read from the child session's state, not
     from the agent): whether preparation succeeded; the admitted
     `EnvironmentReference.configurationRevision`; the setup duration; the safe
     failure reason (for example `workspace_setup_failed` or
     `setup_command_timeout`); the egress mode applied; and the hosts the audit
     observed.
   - **Facts the agent reports:** the smoke-check results and their evidence,
     labelled as agent-reported in the UI.
   - If `getSession` and `getMessageResult` do not already expose the
     preparation outcome, revision and audit summary, add a small
     cloud-agent-next read for them (`getSessionPreparationOutcome`).

**Completion gate,** checked by the server inside `agent.complete`:

- `last_verification.configurationRevision` equals the draft's current revision.
- Preparation succeeded.
- Every smoke check reported as passed.
- No secret request or network request is still `pending`.
- The test ran under the policy that sessions will get after publication: the
  same mode, allowlist and required hosts.
- `verification_count ≤ MAX_VERIFICATIONS` (default 6).

If any condition fails, the call is rejected and names the unmet condition.
The agent therefore cannot publish unverified changes.

**Duration guard.** Setup longer than 5 minutes still passes, but the card warns
that setup runs on every prepare and rebuild. The skill tells the agent to
cache or trim first.

### 7. Automatic publication

After the gate passes, `agent.complete` calls `publishDraftEnvironment` in the
same request.

- **Success.** The status becomes `published`. `published_revision` is recorded,
  `previous_configuration` is stored, and the agent's summary is shown. A
  snapshot build is requested for every owner with
  `expectedRevision = published_revision`. Its result appears on the card but
  never changes the run status.
- **The target changed meanwhile.** The status becomes `publish_conflict`, and
  the card offers **Publish anyway** or **Discard**. A concurrent human edit is
  never overwritten automatically.
- **The setup depends on an unmerged setup PR.** The status becomes
  `waiting_for_merge` (§8).
- **Undo.** **Revert** stays available until the environment is changed again.

### 8. Setup scripts committed to the repository

The agent opens a PR only when it needs to: the logic does not fit in 16,000
characters, or the repository clearly should own the script. Typical cases are
a multi-step stack bootstrap like `.kilo/cloud-agent-setup.sh`, or a script that
other developers also run locally.

1. **Create the PR.**
   - The agent commits the script on a branch named
     `kilo/environment-setup-<shortRunId>` and opens a PR against the default
     branch. It uses the session's normal Git credentials and the usual PR flow.
   - It then calls `record_setup_pull_request`.
   - The draft's environment script stays a thin caller, such as
     `bash .kilo/cloud-agent-setup.sh`.
2. **Test against the PR branch.**
   - Test children use the PR branch for that repository: `upstreamBranch` for
     the launch repository, or `requestedEnvironment.repositories[].branch` for
     the others.
   - The gate records which branch was tested.
3. **Publish only after merge.**
   - Publishing before the merge would break every session on the default
     branch, because the file would not exist there yet. So a gate-passing run
     with an open setup PR becomes `waiting_for_merge`.
   - **Detecting the merge.** For GitHub, the existing PR webhook handling
     publishes automatically on merge, provided the merged head equals the
     tested commit. If the PR was changed after testing, the run asks the agent
     to verify again. For GitLab and Bitbucket, the card re-checks on load and
     offers **Check again**.
   - **Publish now.** The user can publish before the merge. The card warns that
     sessions on the default branch will fail setup until the merge.
4. **A closed, unmerged PR** sets the run to `failed` with reason
   `setup_pr_closed`.

### 9. Agent instructions

**Prompt** (`apps/web/src/lib/cloud-agent/environment-setup-prompt.ts`). It is
built on the server and is short and factual:

- The user's requirement, quoted verbatim and marked as user data.
- The repositories, their paths and the setup working directory.
- The workflow: inspect, then draft, run locally, `update_environment_draft`,
  `verify_environment_draft`, fix, and finally `complete_environment_setup` or
  `fail_environment_setup`.
- Hard rules:
  - Never print secret values, and never put secrets in scripts or commits.
  - Ask for credentials the user owns through `request_environment_secrets`.
  - Open a setup PR only under §8.
  - Do not commit anything else.

**Runtime skill `environment-setup`.** It is delivered through `runtimeSkills`,
with its source in
`apps/web/src/lib/cloud-agent/skills/environment-setup/SKILL.md`. It covers:

- **Where to look:**
  - `AGENTS.md`, `DEVELOPMENT.md` and `README*`.
  - Existing setup scripts: `.kilo/cloud-agent-setup.sh` and other `*setup*.sh`.
  - Environment definitions: `.devcontainer/`, `docker-compose*.yml`,
    `Makefile` and `package.json` scripts.
  - Tool versions: `.tool-versions`, `.nvmrc` and `flake.nix`.
  - Example env files (`.env*.example`) and CI workflows.
- **The preparation contract:**
  - One Bash script of at most 16,000 characters, run with `-e -o pipefail` in
    the setup working directory.
  - It runs on every prepare and rebuild, and also on top of snapshots, so it
    must be **idempotent and fast**.
  - Timeouts are 5 min without output and 8 min total.
  - The variable limits and reserved keys apply.
- **Prefer what the repository already has.** If the repository ships a setup
  script, call it rather than copying it. When neither inline nor existing
  scripts are enough, use §8.
- **Sandbox size.** Pick the smallest offered allocation that passes. Docker
  inside the sandbox and full stacks usually need a larger one.
- **Variables and secrets.** Store generated local-only values as secrets
  yourself. Request real third-party credentials from the user, with a reason
  for each.
- **Network.**
  - Derive hosts from the egress audit of the setup session and the test
    children, for example package registries, container registries and
    toolchain downloads. Exclude the server-owned baseline.
  - Under Full or no policy, record them directly as `requiredHosts`. Under a
    restricted policy, ask with `request_network_hosts`, citing the child whose
    audit denied them.
  - Keep the list minimal and justified.
  - You cannot change the user's policy. If the requirement truly needs a
    broader one, say so in chat or fail with that reason.
  - The clean test must pass under the policy sessions will actually get.
- **Smoke checks.** Define concrete checks that prove the requirement, not just
  "the script exited 0". Examples: `pnpm dev:status`, a health check with curl,
  one focused test.
- **When to stop.** Call `fail_environment_setup` with a specific reason when
  the requirement needs something the sandbox cannot provide: privileged kernel
  features, unreachable private networks, or missing integration access.

### 10. Network: user policy plus environment minimum

Builds on #8899's `egress_mode` and `egress_allowlist`.

**Concepts:**

- **User policy.** This is #8899 unchanged: None, Limited (plus extra hosts) or
  Full. It is owned by the user, who can edit it in the editor. Explicit session
  requests can still override it, as #8899 preserves.
- **Organization settings and defaults.** None exist on main yet. Once they do,
  they sit above the user policy, for the setup session and test children as
  for every other session.
- **Required hosts (minimum).** `egress_required_hosts` lists the hosts the
  environment needs in order to work. The editor shows it read-only with its
  justification. How hosts get there depends on the user policy:
  - **Full or unset:** the agent records them directly. They have no effect
    until the user restricts the policy. When the user switches to None or
    Limited, the editor shows the list prominently so the change is visible.
  - **None or Limited:** every host is a **network request**. The agent cites
    a test child whose audit shows the host as `denied`, and the server
    attaches that evidence. The chat shows a platform notice with a **Review
    hosts** button that opens the editor's Network page. There, each host shows
    the agent's reason (labelled as the agent's), the evidence, and
    Approve / Decline. Only approved hosts enter the draft.

  Without this rule, an agent could widen the network of every future session
  through automatic publication, without any user action.

**Effective allowlist.** When the resolved mode is `allowlist`, whether it comes
from the environment or from a request, the allowlist is:

`server baseline ∪ egress_required_hosts ∪ user/request allowlist`

Full stays unrestricted. A request can widen the policy or narrow the user's
part. It cannot drop the environment's minimum, because then the environment's
own setup would fail. The user can still remove the minimum by clearing
required hosts in the editor, which is an explicit, visible choice.

**Changes on top of #8899:**

- The column, the contract types and the editor's read-only "Required by this
  environment" list with **Clear**.
- The preflight merge adds required hosts to every allowlist-mode session that
  uses the environment, both from a saved policy and from a request override.
- Update the spec rules.
- For None mode, the UI copy changes to "Kilo, Git, the repository host, and
  hosts this environment requires".

**Sandboxes that cannot enforce allowlists.** The minimum is stored but has no
effect. `getDraft` tells the agent, and the agent still records it for
documentation.

**Follow-up: suggestions instead of overrides.** For now, no session request
can drop the minimum. Later, the platform shows suggestions the user can adopt
with one click, for example:
- A required host that no session has contacted in the last N sessions (from
  audit) gets a "Remove unused host" suggestion.
- A user who starts a session with a narrower override that excludes required
  hosts gets an offer of a saved variant of the environment without them, such
  as an offline environment.

Suggestions never apply themselves. Adopting one is an ordinary environment
edit.

## Worked example: Kilo-Org/cloud + local dev stack

1. **Start.** The user picks `Kilo-Org/cloud` and writes "set it up to use the
   local dev stack for the Cloud Agent". `start` creates the draft and the setup
   session. The repository is cloned at `/workspace/cloud`.
2. **Inspect.** The agent reads `AGENTS.md` and finds
   `.kilo/cloud-agent-setup.sh` and the `cloud-agent-sandbox` skill. These cover
   the memory cgroup, Docker, pnpm, `.env.local`, the test DB, the seeded fake
   user and the sandbox images.
3. **Inner loop.**
   - The script `bash .kilo/cloud-agent-setup.sh` already exists, so no PR is
     needed.
   - Running it locally shows that Docker needs a larger allocation, so the
     agent picks one from `getDraft`.
   - No secrets are requested, because local development uses generated or
     fake values.
4. **Required hosts.** The audit shows `registry.npmjs.org`,
   `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com`
   and others. The user's policy is Full, so the agent records them directly
   as `requiredHosts`. Under Limited, the same hosts would be network requests
   for the user to approve in the editor before the clean test.
5. **First clean test.** Setup passes in 6m10s. The checks pass:
   `pnpm dev:status --json` reports all services healthy, and the fake login
   endpoint returns 200. The card shows a duration warning.
6. **Second clean test.** The agent puts the image pre-pulls behind an
   idempotence check and tests again. Setup now takes 4m40s.
7. **Publish.** `complete`, then the gate passes and the environment is
   published automatically. Later `Kilo-Org/cloud` sessions use it. If the user
   later switches the environment to None, the required hosts keep setup
   working.

## Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| 0 | **Docs.** Add a spec section "Environment setup agent" to `.specs/cloud-agent-session.md` covering: drafts excluded from matching, permissions, secrets, the gate, automatic publication and revert, the setup PR, and required hosts. Update `services/cloud-agent-next/docs/control-plane.md` for the `environmentSetup` metadata, the grant and the test child's network policy. | Spec reviewed; #8899 merged |
| 1 | **Data and domain.** DB migration (draft status, required hosts, setup-run table). Domain service (create draft, publish, revert, matching exclusion, `allowDraft`). Cleanup job. | Unit tests: drafts never match implicitly; publish new and existing; revision conflict; envelope copy without decryption; revert |
| 2 | **Authority and tools.** Authority v2 claim, scoped procedures, the `agent.*` web procedures, kilo-mcp tools, and grant issuance from session metadata. | Authority unit tests; kilo-mcp tests; router tests for the role re-check, the pinned run id and rejection of terminal runs |
| 3 | **Start flow and UI.** `setupRuns.start/get/provideSecrets/cancel/publish/revert`, the prompt builder, the runtime skill, preflight acceptance, the start dialog, the run card, the chat request notices, the editor's pending-secret entries (reason, references, storage and audience copy, high-privilege warning, GitHub reference check), and the toggle. | Local stack E2E with the fake LLM (`cloud-agent-local-testing` skill): start, draft update, secrets entered in the editor, skip, publish, revert. A design review of the secret request with a few users before GA. |
| 4 | **Clean tests and automatic publication.** Test children with the draft's network policy and audit, the preparation-outcome read, the gate, automatic publication, the duration warning, and the test cap. | E2E: a failing script records `workspace_setup_failed` with its revision; a fixed script publishes; `complete` is rejected on a stale revision; a concurrent edit gives `publish_conflict` |
| 5 | **Required hosts.** Column, preflight merge and editor display. Derivation from audit. Network requests with audit evidence and approval in the editor. | Spec and tests; a clean test in allowlist mode on `cloudflare-containers`; `updateDraft` rejects `requiredHosts` under a restricted policy; a request without a matching `denied` audit record is rejected |
| 6 | **Setup PR flow.** Record the PR, test on the PR branch, `waiting_for_merge`, publish on GitHub merge, `setup_pr_closed`. | E2E with a fixture repository; the merge webhook publishes only when the head matches the tested commit |
| 7 | **Extras.** A snapshot build after every publish. A "Fix with agent" entry on `workspace_setup_failed`, prefilled with the failure. Rollout: internal organization first, then GA. | Toggle rollout |
| 8 | **Follow-ups.** Minimum-network suggestions (§10). A warning when a secret-like value is pasted into chat. Organization network settings, once they exist, picked up by normal resolution. | Separate plans |

## Failure UX

These follow the Failure UX rules in the root `AGENTS.md`.

- **`start` fails immediately,** with a specific reason and nothing created,
  when: repository access is missing; no isolated sandbox is offered; the user
  lacks the manage role; or the balance is too low.
- **The setup session ends without `complete` or `fail`.** This covers
  `no_progress`, `execution_limit`, interruption and model failure.
  `setupRuns.get` derives `failed` from the session's terminal state, with the
  safe reason, and stores it the first time it sees it. A run never sits in
  `running`.
- **A test child fails preparation.** The failure is recorded and reaches the
  agent through the parent callback. It fails only that test, not the run.
- **Waiting for secrets or host approval.** The agent's turn ends. Providing,
  skipping, approving or declining resumes it promptly. After 7 days the run
  becomes `cancelled`.
- **A required host is declined, or organization settings block it.** The agent
  continues without it. If the requirement cannot be met, it fails with the
  specific host and reason.
- **Waiting for the setup PR to merge.** The card explains what is pending.
  After 14 days without a merge, the run asks the user to publish now or cancel.
- **The test cap is reached.** The run fails with "verification limit reached",
  and the last evidence and the draft are kept. The user can publish with
  `force`, or ask the agent to continue, which raises the cap once.
- **Automatic publication fails** because a validation that `create` or
  `update` would enforce no longer holds, such as the allocation no longer
  being offered. The run becomes `failed` with that reason, and the draft is
  kept.

## Security

- **Narrow agent authority.** It covers one draft and one run, expires with the
  grant, and is re-checked against the user's current role on every call. It
  cannot read secret values, touch other environments, revert or delete. It can
  publish only through the server gate.
- **Drafts stay private to the run.** They resolve only for the setup session,
  which carries a server-verified `environmentSetupRunId`, and for its direct
  test children, which have the draft pinned in their authority.
- **Network.**
  - The agent cannot change the mode or allowlist.
  - Under a restricted policy, it cannot add a host without the user's approval
    and matching audit evidence.
  - Every session, including setup and test sessions, follows organization
    settings.
  - Required hosts must be valid exact hostnames. The editor shows each one, so
    the minimum is always visible to the user.
- **Secret requests are untrusted input.** Inputs exist only in the environment
  editor, never in chat. The agent's reason is labelled as the agent's, and its
  references are checked where possible. The UI states who can read the secret,
  warns on high-privilege names, and always allows Skip.
- **Runtime exposure is unchanged and stated.** Saved secrets are readable by
  every session that uses the environment, as today. The plan does not claim
  more.
- **How secret values travel:**
  - from the user, through the start form or the environment editor;
  - from the agent, through `updateDraft` (write-only);
  - between rows, as server-side envelope copies.
  They never appear in prompts, chat, tool results, commits or logs. The
  existing `redactsNamedSecrets` redaction applies.
- **The requirement text is user data.** The prompt quotes it, and it never
  widens tool authority.
- **Setup PRs.** They are opened through the normal PR flow and are reviewable
  like any other PR. Publication waits for the merge.

## Testing

- **Unit:**
  - authority schema and pinning;
  - domain service: matching exclusion, publish, conflict, revert, envelope
    copy, cleanup;
  - preflight merge of required hosts;
  - prompt builder;
  - run status derivation;
  - the gate.
- **Integration (Workers):**
  - `allowDraft` is accepted only with a verified run;
  - the grant contains `environmentSetup` only for the setup session;
  - the test child gets the draft's policy only with a verified
    `verificationOf`, and fails closed when that policy cannot be validated.
- **kilo-mcp:** tools are registered only with the claim, and arguments are
  pinned.
- **Web router:**
  - permissions: a member is denied, and so is a billing manager, including for
    `provideSecrets` and `resolveNetworkRequests`; an admin who loses the role
    mid-run can no longer approve;
  - the request is denied when the toggle is off;
  - `start` is idempotent.
- **E2E (local stack, fake LLM, scripted tool calls):**
  - the happy path with automatic publication;
  - a failing script;
  - needs secrets, then provided in the editor, then a clean test;
  - a secret request with a reference that does not exist shows "Not found in
    the repository";
  - restricted policy: network request, approval, then a clean test under the
    approved allowlist;
  - `complete` with a stale revision;
  - `publish_conflict`;
  - revert;
  - cancel.
- **Manual dogfood:**
  - `Kilo-Org/cloud` with the worked example: measure setup duration and the
    number of tests;
  - a fixture repository whose setup exceeds 16,000 characters, to exercise the
    PR flow.

## Open questions

None. Every value is entered in the environment editor, so high-privilege names
get a warning there and are not blocked (see "Secrets").
