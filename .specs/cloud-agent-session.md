# Cloud Agent Session

## Role of This Document

The user-visible contract for a Cloud Agent chat, and the oracle for manual
end-to-end testing. Every rule is a fact a tester can observe in the chat
itself, without reading logs. It does not prescribe implementation and it
carries no test mechanics: stack setup, account provisioning, and the mapping
from a rule to a wire event belong to the `test-cloud-agent` skill. Any backend
serving this chat MUST satisfy this surface; the user MUST NOT be able to tell
which implementation they are on beyond the bounded runtime-metadata exception
specified under Sandbox Status. All other runtime and infrastructure privacy
requirements remain in force.

## Status

Draft -- created 2026-08-24, revised 2026-08-27 to define the passive sandbox
status contract alongside shared worktree navigation and durability.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" are to be
interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when,
they appear in all capitals, as shown here.

## Definitions

- **Session**: one chat bound to one repository and one environment.
- **Environment**: the isolated workspace where the agent runs.
- **Worktree**: a group of independent browser chats that share the same
  checked-out repository files while their environment exists.
- **Preparation**: visible setup of that environment -- clone, branch, setup
  commands, restore.
- **Turn**: one user message and the agent work it triggers.
- **Rebuild**: preparation running again because the environment was lost or
  recycled.
- **Read-only session**: a session this viewer cannot drive.

## Overview

The user picks a repository, a model, a mode, and optionally a profile, types a
prompt, and lands in a chat. The prompt is visible immediately. If the
environment needs real work, they watch it prepare under that message, then the
agent streams its work in the same thread. Later turns stay in that chat on that
repository.

## Rules

### Start

1. The user MUST connect a git provider and select a repository before a session
   can start.
2. Paid use MUST require a balance of at least $1. Below that, the user MAY
   start only with a free or bring-your-own-key model.
3. Submitting the first prompt MUST open the chat with that prompt already
   visible.
4. A first prompt that is exactly a known slash command MUST run as that
   command, not as free text.
5. An over-long prompt, or an attachment still uploading, MUST block submission.

### Preparation

1. While the environment is created or rebuilt, the user MUST see live
   preparation under the triggering message: the current step, and the running
   setup command's output.
2. Steps the user MUST be able to see when they run: cloning the repository,
   checking out the branch, restoring a previous workspace, running setup
   commands.
3. Preparation that only acquired and booted an environment -- warm reuse, no
   real provisioning -- MUST NOT leave a completed preparation row.
4. Running and failed preparation MUST always be visible. Failed preparation
   MUST show an error and a way to open details.
5. Setup commands MUST run on the first prepare and again on every rebuild. A
   failing or timed-out setup command MUST fail preparation and the turn.
6. Follow-up turns MUST NOT show preparation unless the environment was
   rebuilt.
7. Preparation output MUST NOT reveal tokens or secret values.
8. The composer MUST stay disabled until the environment is ready, and MUST say
   which state it is waiting on.

### Turn

1. The agent MUST stream text, reasoning, and tool calls in the same chat.
2. While the agent works, the user MUST see what it is currently doing.
3. Auto-commit MUST be visible while it runs and when it lands: the commit, or
   the failure. A skipped commit MUST show nothing.
4. Delegated sub-agent work MUST be openable from the message that spawned it.
5. Spend so far MUST be visible once non-zero. Context usage MUST be visible
   once known.
6. Stop MUST end the current turn, tell the user the session was stopped, and
   re-enable the composer.
7. After a turn the user MUST be able to send another message in the same
   session. The repository MUST remain the one chosen at start.
8. The user MAY change model and mode for later turns. When a profile or agent
   pins the model, the picker MUST be disabled and MUST say why.

### Composer

1. The composer MUST offer the session's slash commands. Text that is not a
   known command MUST send as a prompt.
2. Attachments MUST be offered only when the session can carry them.
3. A question or a permission request MUST replace the composer until the user
   answers. Permissions MUST offer allow once, always allow, and deny.
4. Several open questions or permissions MUST be presented one at a time,
   oldest first.
5. A suggestion MUST NOT take the composer.

### Workspace

1. The user MUST be able to open a terminal on the environment as a tab beside
   the chat, and close it. A read-only session MUST NOT offer terminals.
2. A pull request the session opened MUST be visible with its current state.

### Shared Worktrees

1. Eligible browser chats for the same worktree MUST appear as exactly one
   selectable row in the sidebar, without nested chat rows. Its label MUST use
   the user-set worktree name, otherwise the first surviving chat's non-default
   title, otherwise the repository and branch. This fallback MUST NOT depend on
   which chats are visible in the current search or recent-session page.
   Selecting the worktree MUST open its latest chat. The row MUST remain visibly
   selected while any sibling is active and MUST reflect busy, question, or
   permission activity across all its chats. Its timestamp and overflow menu
   MUST share the session-row action slot. Associated pull-request information
   MUST use the existing session indicator and refresh behavior.
2. Each open chat in the selected worktree MUST appear as a distinct tab in the
   main chat header. Each tab MUST reflect its chat's live title, status, and
   progress, with only an **X** close action and no overflow menu. Double-clicking
   or double-tapping a tab MUST rename it inline; keyboard rename MUST remain
   available. Selecting a tab MUST open that chat's own address and transcript.
   The header MUST offer a split **+** / downward-chevron control: **+** opens a
   new chat, and the chevron offers **New chat** and eligible **New terminal**
   actions. Creation controls and the session list MUST remain accessible when
   tabs overflow, without a vertical scrollbar in the tab strip.
3. The worktree-row action **New chat**, the header action **New chat**, and an
   eligible chat's exact trimmed `/new` command MUST immediately open a new
   empty chat in the same worktree without stopping, waiting for, or adding a
   message to an already-running chat. The composer MUST suggest `/new` while
   typing. Header and worktree-row actions MUST add a tab; `/new` MUST replace
   the current tab in the same position only after creation succeeds, preserving
   the previous chat.
4. A failed new-chat action MUST keep the current chat and tab open, restore its
   composer, and show a retryable error. Attachments MUST NOT be discarded.
5. Grouped chats MUST see the same uncommitted files and Git changes while their
   shared environment exists. They MAY run simultaneously; concurrent file or
   Git changes are visible shared-state races.
6. Each chat MUST keep its own streamed output, transcript, questions,
   permissions, stop control, and recovery. Stopping or answering one chat MUST
   NOT affect another chat in the worktree.
7. Grouped chats MUST support platform-managed auto-commit and push after
   successful turns, enabled by default for new worktrees and honoring explicit
   opt-out. New sibling chats MUST inherit the source chat's auto-commit setting.
   Platform-managed commit and push operations MUST be serialized per worktree.
   Each commit captures the shared checkout and MAY include sibling-chat edits.
   Rebuilt worktrees MUST restore their pushed working branch rather than restart
   from the repository's default branch. An agent MAY still perform explicit Git
   operations during its chat.
8. Deleting one chat MUST leave its siblings usable. Deleting the final chat
   MUST remove the worktree group from the session list.
9. Existing ungrouped and legacy chats MUST remain individual sidebar rows and
   retain their current behavior. Worktree grouping MUST NOT change
   native-mobile chat behavior.
10. Closing a chat tab MUST NOT delete its saved session, discard its transcript,
    or stop its running work. Closed-tab preferences and tab order MUST survive
    refresh and remain scoped to the current user and personal or organization
    context.
11. The selected worktree MUST offer a **Sessions** list inside the split control's
    chevron menu, containing only closed chats and excluding already-open tabs.
    Most recently closed chats MUST appear first, including after refresh;
    session creation or activity timestamps MUST NOT determine this order.
    Selecting a closed chat MUST reopen it and remove it from that list. Closing
    the last chat MUST retain the selected worktree and access to its saved
    sessions and new-chat action; existing terminal tabs MUST remain usable.
12. The user MUST be able to rename a worktree independently of its chats.
    A custom name MUST survive refresh and new sibling creation without changing
    chat titles or activity timestamps. Later chat-title changes MUST NOT
    override a custom worktree name.
13. Deleting a worktree MUST require confirmation and remove all its chats,
    descendants, saved content, terminals, checkout files, and associated runtime
    state. It MUST preserve other worktrees and destroy a physical sandbox only
    when that sandbox is exclusively owned by the deleted worktree. Ownership
    and current personal or organization access MUST be checked server-side.
    Incomplete cleanup MUST remain recoverable, MUST NOT report success, and
    MUST NOT permit late creation or ingestion to resurrect the worktree.

### Sandbox Status

1. Eligible owned control-plane Cloud Agent web chats MUST show a compact,
   icon-only sandbox lifecycle control in the header. A fixed box icon MUST
   identify the sandbox, with a small bottom-right static badge for its state.
   Badge shapes and accessible labels MUST distinguish states without relying
   only on color or a loading spinner. Details MUST be available through
   hover, keyboard focus, and touch/click, with visible focus and Escape
   dismissal. Sandbox lifecycle MUST remain distinct from agent progress and
   compute-billing phase; observing it MUST NOT change the composer, terminal,
   or turn behavior.
2. The public snapshot MUST contain only `status`, `provider`, `observedAt`,
   `detailCode`, `inactivityTimeoutMs`, `estimatedSleepAt`, and an OPTIONAL
   `runtime` object. Status MUST be one of `active`, `sleeping`, `starting`,
   `stopping`, `error`, `unreachable`, or `unknown`. Provider MUST be exactly
   `Cloudflare`, `Vercel`, or `Unknown`, derived from authoritative stored
   provider information rather than an arbitrary provider string. When present,
   `runtime` MUST contain only nullable `sandboxType`, `kiloCliVersion`,
   `wrapperVersion`, `startedAt`, and `stoppedAt` fields. Sandbox types MUST be
   bounded to shared, isolated-small, isolated-standard, code-review,
   devcontainer, or unknown. Versions MUST be bounded, validated values reported
   by the relevant runtime, not inferred from the current deployment. Runtime
   identifiers, owner identifiers, infrastructure addresses or regions,
   credentials, and raw backend errors MUST NOT appear in status responses or
   details. Unknown response fields MUST NOT survive validation. Validation
   errors MUST NOT be forwarded as raw backend diagnostics.
3. Detail codes MUST be bounded and consistent with status. The safe meanings
   are:

   | Status | Detail code | Meaning |
   |---|---|---|
   | `active` | `sandbox_ready` | The sandbox is active. |
   | `sleeping` | `sandbox_stopped` | The sandbox is sleeping; a message can resume it. |
   | `starting` | `sandbox_starting` | The sandbox is starting. |
   | `stopping` | `sandbox_stopping` | The sandbox is stopping. |
   | `error` | `sandbox_failed` | The sandbox encountered an error; a message can retry. |
   | `unreachable` | `connection_unavailable` | The sandbox connection is unavailable; its current state cannot be confirmed. |
   | `unknown` | `insufficient_evidence` | There is not enough information to confirm the current state. |
   | `unknown` | `status_unavailable` | Sandbox status is temporarily unavailable; this does not mean the sandbox failed. |

   Loading a snapshot MUST use the static `unknown` presentation, never
   authoritative `starting`. Failure of the observation service MUST use
   `status_unavailable`, not
   `sandbox_failed`, and MUST remain non-blocking. Failed, paused, unauthorized,
   or stale observations MUST NOT retain current-looking active status or a
   sleep estimate. A snapshot from another session or personal/organization
   context MUST NOT be displayed.
4. Observation MUST be passive, including first access after reconstruction
   and repeated polling. It MUST NOT wake, start, probe, extend, keep alive,
   bill, or otherwise mutate a sandbox. It MUST NOT trigger recovery, repair
   lifecycle records, change alarms, request wrapper frames, or initialize
   operational work indirectly. It MAY use validated stored state and evidence
   already received on the current connection. Existing session authorization,
   exact organization isolation, and billing rules MUST remain unchanged;
   reading status MUST NOT require credits or admit paid work.
5. Status observation MUST accept only valid control-plane `workspace_`
   references. Legacy `agent_`, unresolved, demo, remote, unrelated, and
   read-only sessions MUST NOT show the indicator or request its status.
   Legacy and malformed references MUST be rejected before any legacy runtime
   lookup. This does not change the Read-only rules for historical sessions.
6. For control-plane `workspace_` sessions, confirmed stopped, creating,
   stopping, failed, and unknown physical states correspond to `sleeping`,
   `starting`, `stopping`, `error`, and `unknown`. A missing physical record MUST
   yield `unknown`, not synthetic `sleeping`. Running requires fresh readiness
   from the unique current open, handshaken connection to establish `active`;
   explicit current not-ready evidence means `starting`, while a disconnected
   or expired connection means `unreachable`. Historical readiness or provider
   instance identity alone MUST NOT establish current readiness.
7. `observedAt` MUST be the snapshot creation time in Unix epoch milliseconds,
   not a claim that the sandbox was probed. Timestamps MUST be finite,
   nonnegative whole milliseconds within the representable date range. The
   applicable `inactivityTimeoutMs` MUST be a finite positive whole-millisecond
   duration, or `null` when unknown. It MUST describe the real inactivity policy,
   not wrapper retention or a provider's maximum lifetime. The current policy
   is 5 minutes for control-plane idle stop; a policy MUST NOT be guessed for an
   unsupported provider or session.
8. `estimatedSleepAt` MUST be `null` unless an active sandbox has a known
   inactivity policy, a valid future idle-stop deadline, and coherent fresh
   sandbox-wide idle evidence. Busy, finalizing, stalled, incomplete, stale, or
   mismatched activity evidence MUST suppress the estimate. A stored deadline
   alone is insufficient. Supported estimates MUST be presented as approximate
   remaining minutes, rounded up and conditional on continued inactivity, never
   exact promises. The popup MUST reveal the estimate only after two minutes of
   the confirmed idle window, derived from the returned deadline and inactivity
   policy. This display delay MUST NOT change
   the actual idle-stop policy. The toolbar MUST show `Sleeping soon` in the
   final 60 seconds of a supported deadline. Expiry of an estimate MUST NOT
   locally invent `sleeping`; new authoritative evidence is required.
9. Details MUST group the current text status, runtime information, and known
   lifecycle timing. Runtime information MUST identify the provider and bounded
   sandbox type using plain-language labels. The click/touch popup MUST include
   a Debug section, collapsed by default, with labeled control-plane mode and
   reported CLI/wrapper versions. The hover tooltip MUST remain noninteractive
   and omit Debug. Compact runtime codes MUST NOT be shown. Missing versions
   MUST display Unknown rather than guessed values. Debug MUST NOT contain a
   unique sandbox or provider identifier.
   Known physical start/stop dates MUST use local display times; unknown dates
   MUST be omitted. Creation requests, wrapper readiness, chat creation, and
   billing intervals MUST NOT substitute for physical lifecycle dates. Retained
   runtime metadata MUST be isolated to its allocation and MUST NOT carry into a
   replacement. Status observation MUST NOT collect or persist new metadata.

### Persistence

1. Refresh MUST restore the transcript, the preparation history that was shown,
   delivery failures, and any still-open question or permission.
2. Refresh MUST NOT start a new turn.
3. If the environment dies, the next prompt MUST recover in the same chat. The
   user MUST NOT be forced to start a new session.
4. Recovery MUST preserve each worktree chat, its transcript, and its grouping.
   Uncommitted files are not guaranteed to survive replacement of the shared
   physical environment.

### Errors

1. A failed send MUST restore the prompt into the composer and say why.
2. A failed turn MUST be marked failed and MUST leave the session usable.
3. A message accepted but not yet delivered MUST show as queued. One that will
   never be delivered MUST show as failed with the reason, and MUST stop
   showing after a successful retry.
4. Insufficient credits MUST tell the user to add at least $1.
5. An unavailable model MUST say so and MUST tell the user to choose another.
6. Any other failure MUST show an actionable or generic retry message, never
   internals.

### Read-only

1. A session the viewer cannot drive MUST show the transcript with no composer,
   and MUST offer a way to continue it.
2. A legacy session MUST be read-only and MUST offer starting a new session.

## Out of Scope

Cloud administration surfaces beyond the existing chat sidebar (MCP Gateway,
triggers, webhooks), profile and organization administration, the mobile app,
and the CLI.
The bounded provider, sandbox type, debug metadata, and known lifecycle dates in
Sandbox Status are a narrow exception to runtime opacity. They do not permit
arbitrary provider names, runtime identifiers, infrastructure addresses,
credentials, or raw errors. Session-id formats and the streaming wire protocol
remain implementation details that MUST NOT be exposed in status details.

## Not Yet Implemented

The following use SHOULD and are not enforced today:

1. The chat SHOULD let the user load history older than the first page.
   (Currently the transcript shows only what the initial load returned.)
2. A read-only session SHOULD offer continuing in Cloud Agent. (Currently it
   offers the CLI and the editor, and says Cloud Agent is coming soon.)
3. Every preparation path SHOULD honour Preparation 5. (The wrapper-driven
   paths fail the turn on a failing setup command; the in-worker preparation
   path currently logs the failure and continues, so the same session can look
   ready with setup half-done.)

## Changelog

### 2026-09-02 -- Structured sandbox details

- Made the toolbar icon-only with a fixed sandbox icon, static status badges,
  and a final-minute sleep warning.
- Grouped details into status, runtime, and timing; kept bounded reported
  versions in a collapsed Debug section instead of a compact runtime code.
- Showed approximate remaining minutes if inactive after two minutes idle,
  without changing the five-minute stop policy. Unknown lifecycle dates remain
  omitted.

### 2026-09-01 -- Shared worktree auto-commit

- Restored automatic commit and push for shared worktrees, enabled by default,
  with explicit opt-out, inherited sibling settings, and serialized per-worktree
  Git finalization. Commits are checkpoints of the shared checkout, not isolated
  changes belonging to one chat.

### 2026-08-26 -- Shared worktree pilot

- Defined selectable worktree sidebar rows, live per-chat header tabs,
  concurrent sibling creation, shared files, independent chat controls,
  disabled auto-commit, and group deletion.
- Defined transcript and group recovery separately from physical filesystem
  durability without changing terminal or permission requirements.

### 2026-08-27 -- Sandbox status contract

- Added a bounded passive lifecycle snapshot and distinct observation-failure
  details for control-plane web sessions only.
- Required supported inactivity policies and explicitly approximate optional
  sleep times.
- Allowed only a bounded human-readable provider label, preserving all other
  runtime, infrastructure, credential, and error privacy guarantees.

### 2026-08-24 -- Audit revision

- Corrected: a failing setup command fails the turn on a rebuild too, not only
  on the first prepare. Recorded that one preparation path does not yet honour
  this.
- Made the warm-reuse rule precise: an attempt whose only steps are environment
  acquisition and boot.
- Added rules for auto-commit, sub-agent sessions, spend and context usage,
  model and mode changes and pinning, slash commands, attachments,
  question/permission queueing, terminals, pull requests, delivery state,
  unavailable-model and generic error wording, secret redaction in preparation
  output, and read-only and legacy sessions.
- Added Out of Scope and Not Yet Implemented.

### 2026-08-24 -- Initial spec

- Condensed from the working `/cloud` chat.
