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
status contract alongside shared worktree navigation and durability; revised
2026-09-11 to add the continuity contract for long-lived, recoverable chats;
revised 2026-10-07 to add the optional repository environment; revised
2026-10-21 to apply the repository environment automatically and move the
sandbox size into it; revised 2026-10-22 to simplify environment editing and
show profile conflicts before saving; revised 2026-10-29 to allow several
repositories in one environment; revised 2026-10-31 to define worktree-owned
shared runtime and MCP configuration; revised 2026-11-04 to state that one
sandbox serves one workspace; revised 2026-11-04 to add environment start
commands and skip setup in a workspace started from an environment snapshot.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" are to be
interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when,
they appear in all capitals, as shown here.

## Definitions

- **Session**: one chat bound to one repository and one environment.
- **Environment**: the isolated workspace where the agent runs.
- **Sandbox**: the compute that hosts one Environment. One sandbox serves one
  workspace only: the sibling chats of that workspace share it, and no other
  workspace uses it.
- **Repository environment**: an optional saved setup for one or several
  repositories -- setup commands, start commands, plaintext variables, secrets,
  and a sandbox size -- distinct from the sandbox Environment. A repository MAY belong to
  several environments of one owner.
- **Multi-repository environment** (V2): a repository environment that lists its
  repositories. Multi-repository environments are available to all personal and
  organization accounts, subject to existing environment management permissions.
  The editor creates every new environment as V2, also with one repository. An environment
  without a list (V1) belongs to one repository and behaves as before.
- **Environment snapshot**: a prepared copy of a repository environment's
  default branch after its saved setup, built from the base image on request
  or for a session, that later sessions of that environment start from.
- **Start commands**: a repository environment's workspace start script. It
  runs each time a workspace starts -- after setup, or alone when the workspace
  starts from a snapshot -- and not when a chat joins a running workspace. It
  is not a build input: a build never runs it, and changing it does not change
  the configuration revision.
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
6. A session started from Cloud Agent web, Slack, GitHub, Linear, Discord,
   a webhook, or a schedule MUST use the owner's repository environment
   for the chosen repository when one exists. With one match, the user does not
   select it. Code
   review and security sessions MUST NOT use it. A repository without one
   launches unchanged. Its setup commands MUST run as preparation steps and
   MUST NOT reveal secret values. When several environments contain the
   repository, rules 14 to 16 decide.
7. While a repository environment applies, profile setup commands run as
   session setup commands beside the environment's commands (Preparation rule 5).
   Profile variables, and variables and commands sent with the request, still
   apply over the environment.
8. The new-session form MUST show the chosen repository's environment beside
   the repository. Organization owners and admins, and personal owners, MAY
   create, edit, or delete it. Other organization members, including billing
   managers, MAY only see it. The API MUST enforce these permissions. The form
   MUST NOT offer a sandbox choice.
9. A session MUST start on the environment's sandbox size when the owner can
   use it. Otherwise the repository override applies, then the owner default,
   then the platform default. A request that names a sandbox wins over all of
   them.
10. Saving an environment with a new sandbox size MUST fail when the owner
    cannot use that size for the repository. A saved size that later becomes
    unavailable MUST NOT block other edits to the environment.
11. The environment editor MUST identify the applicable profiles whose setup
    commands will not run, including when the environment has no setup script.
    When a profile overrides an environment variable, the editor MUST identify
    the winning profile and variable name without revealing its value.
12. New or replaced variables entered in the environment editor MUST be saved
    as secrets. Untouched plaintext values and saved secrets MUST be retained.
    The editor MUST NOT show saved secret values. A saved secret appears as
    `KEY=<unchanged>` in the editor. Keeping this marker retains the value;
    replacing it changes the value; deleting its line removes the variable.
    The marker MUST NOT be saved as the secret value.
13. The environment editor MUST offer one setup script. New or edited setup
    MUST save at most one script. Existing multi-script setups MUST remain
    intact when the user changes only variables or the sandbox size.
    Setup scripts MUST run with Bash and stop on an unhandled command or
    pipeline failure without requiring `set -e` in the script. A failed script
    MUST stop preparation and show the failure. Each script MAY contain up to
    16,000 characters.
14. A repository matches every environment that contains it. When exactly one
    matches, it MUST apply with no choice.
15. When several match, the new-session form in the web UI MUST require a valid
    choice and MUST NOT start the session without one. The form MUST
    remember the last choice per repository and personal/organization scope and
    restore it only while it still matches the repository. A request that
    marks the choice as required and names no environment MUST fail with a
    conflict that names the matching environments. A request that names an
    environment that does not contain the repository MUST fail.
16. When several match and the request does not mark the choice as required, the
    session MUST start with no environment. This covers the mobile app, the
    extension, fork and review-fix routes, continuing in Cloud Agent, and every
    automatic origin. On an origin that applies no environment, a request that
    names one is ignored, but a request that lists additional repositories MUST
    fail.
17. A session on a multi-repository environment MUST ignore the repository's
    profile binding while applying the effective default profile. A profile the
    user selects explicitly MUST replace the default. The new-session form MUST
    show the same profiles that will apply.
18. A session on a multi-repository environment MUST run in an isolated sandbox.
    One repository MUST run at `/workspace/<name>`. Several MUST each be cloned
    at `/workspace/<name>`, and the agent and setup MUST start at `/workspace`.
    Setup MUST run once. Each additional repository MAY have its own branch;
    otherwise it MUST use the session's generated branch.
19. Saving a multi-repository environment with a Vercel sandbox MUST fail, and
    so MUST a session request for one. A saved default of that kind (repository
    or owner) MUST be skipped, and the session MUST start on another sandbox.
20. A new session MUST NOT start on a sandbox that another workspace uses. The
    picker MUST NOT offer a shared sandbox. A request for the retired shared
    sandbox MUST fail with a specific message, and a saved shared default MUST
    be skipped so that the session starts on another sandbox.
21. A user's Cloud Agent settings MAY override the model of a built-in agent,
    including `explore` and `compaction`, and MAY hide a built-in primary agent
    other than `code`. These preferences MUST belong to the user, MUST apply to
    every session that user starts including organization sessions, and MUST
    NOT be settable by a session request.

### Stacked Worktrees

1. The user MAY create a stacked workspace from an existing worktree's sidebar
   or chat-header menu. The composer MUST identify the parent branch, keep its
   repository locked, and allow removing the stack target to start normally.
2. A stacked worktree MUST have its own branch and sandbox. Its first checkout
   MUST start at the remote parent commit resolved when the workspace was
   prepared. Sibling chats MUST retain the same stack and base.
3. A parent outside the user's personal or organization scope, a different
   repository, or a parent being deleted MUST NOT be accepted. An unpushed base
   MUST fail before creating the workspace with a specific reason. A base
   rewritten during startup MUST fail with a retryable base-changed reason.
4. The Changes panel MUST compare a layer with its base branch, not with its own
   branch. When the base no longer exists, it MUST compare with the repository's
   default branch and identify that fallback.
5. A worktree MUST rewrite or push only its own branch. Auto-commit MUST NOT
   force-push. A remote history change MUST retain local commits and offer Sync.
6. Sync and Restack MUST require a user action and MUST refuse while any chat in
   the worktree is running or the working tree has uncommitted changes. Restack
   MUST use a force-with-lease pinned to the expected remote head. Waking an idle
   sandbox MUST be visible as operation progress.
7. Restack stack MUST visit layers bottom-up, in their own sandboxes, and stop
   on the first refusal or conflict. A conflicting rebase MUST be aborted before
   the agent receives the exact operation, command, files, and expected result
   as a resolving turn. No unrelated branch may be rewritten.
8. Deleting a parent worktree MUST preserve its branch and its children's base
   branches. The confirmation MUST warn when stacked children exist. Children
   MUST remain usable after the parent worktree is deleted.
9. A stack MUST appear as one sidebar unit with an individually navigable row
   and PR state for each layer. A collapsed stack MUST summarize its layer count
   and most urgent status.
10. Sidebar layout preferences MUST belong to the individual user in the
    selected scope, including within organizations. All members MAY change their
    own workspace order and smart folders. Single sessions MUST remain sorted
    by actual activity, and PR verification or other metadata writes MUST NOT
    move them or workspaces in activity order.
11. A Cloud Agent permitted to launch child sessions MUST be able to orchestrate
    stacked workspaces through its scoped launch tool when the user requests a
    PR stack. Every new launch MUST use a fresh UUID `operationKey` and create a
    registered workspace. The response MUST return its `worktreeId`, including
    on an identical retry. The orchestrator MAY launch worker A independently,
    then launch B with `stackOnWorktreeId` set to A's returned ID after A pushes.
    The stack parent MAY be another owned worktree in the same personal or
    organization scope. Completion callbacks MUST target the launching
    orchestrator independently of the stack parent. The server MUST resolve the
    parent repository, branch, and pushed commit with the UI ownership checks.
    The agent MUST NOT select the resolved commit, override its lineage, or
    combine stacking with `upstreamBranch`. Each layer MUST receive its PR base
    instruction and may push only its own branch.

### Preparation

1. While the environment is created or rebuilt, the user MUST see live
   preparation under the triggering message: the current step, and the running
   setup command's output.
2. Steps the user MUST be able to see when they run: cloning the repository,
   using a prepared repository, checking out the branch, restoring a previous
   workspace, running setup commands.
3. Preparation that only acquired and booted an environment -- warm reuse, no
   real provisioning -- MUST NOT leave a completed preparation row.
4. Running and failed preparation MUST always be visible. Failed preparation,
   its triggering failed message, and its safe error MUST remain visible, with
   a way to open details.
 5. The environment's build commands MUST run only in an environment build.
    Session setup commands (request-supplied and profile) and the environment's
    start commands MUST run on a fresh start and on an environment snapshot start.
    Neither MUST run when restoring a private workspace tail snapshot or when a
    chat joins a workspace that is already running. A failing or timed-out
    session setup or start command MUST NOT fail preparation or the turn: the
    user MUST see a row naming the command kind, number, command text and exit
    code or timeout, with a way to open its output, and the agent MUST receive a
    short note about it with the first message after that preparation.
6. Follow-up turns MUST NOT show preparation unless the environment was
   rebuilt.
7. Preparation output MUST NOT reveal tokens or secret values.
8. A writable Cloud Agent chat with a resolved queue-capable transport MUST allow
   editing and queueing follow-up messages while preparation or finalization
   runs, and MUST show the current phase. Temporary submission unavailability
   MUST NOT disable its textarea or discard its draft or focus. Initial loading,
   unresolved transports, and read-only chats MUST NOT permit submission.
   After preparation failure settles the turn, the composer MUST be restored
   when the session is writable and its
   transport permits sending. A later submission MUST use fresh message and
   preparation-attempt identities.

### Environment snapshots

1. Only an environment build MAY create a reusable environment snapshot.
   Private workspace tail snapshots MUST follow the separate workspace snapshot
   rules below and MUST NOT be published as environment snapshots.
2. A session whose repository environment has build commands MUST start from
   that environment's published snapshot when the owner, repository, sandbox
   image and runtime match and the snapshot revision is not newer than the
   session's configuration revision. For a multi-repository environment, the
   environment, owner and the same list of repositories MUST match instead of
   one repository. A snapshot from the previous image MAY remain eligible for
   at most 24 hours after capture while a replacement build runs; the runtime
   ABI MUST still match. A missing, building, failed or backed-off environment
   or an unavailable lookup MUST fail with a specific reason and a way to open
   the environment build, never start from the base image. When no environment
   snapshot can serve the start at all -- a sandbox provider that cannot restore
   one, or a retired sandbox type whose workspace path the snapshot does not
   cover -- rebuilding cannot help: the start MUST fail at once with that
   reason, without a way to open the environment build, and MUST NOT start from
   the base image. An environment without build commands MUST
   start from the base image. The lookup MUST NOT delay the
   start by more than 15 seconds and MUST NOT wait for a build.
3. Build commands are the environment's setup commands and run only in its
   build. Session setup commands are the request-supplied and profile setup
   commands. A workspace that starts from an environment snapshot, at any
   revision, or from the base image MUST run the session setup commands, then
   the start commands, as Preparation rule 5 describes. Changed build commands
   take effect after the next build. Cached files MAY retain earlier values,
   including secrets.
4. When a session starts from an older snapshot revision, preparation MUST
   show the snapshot revision, the session's revision, and the actual
   replacement build status, including a skipped build or backoff.
5. If a snapshot start fails transiently, the session MUST retry the same
   snapshot within the preparation deadline. A permanent failure, or a repeated
   one, MUST fail with a specific reason that asks to rebuild the environment
   and MUST NOT start from the base image.
6. A snapshot MUST NOT contain git or build credentials, reflogs, or a Kilo
   home.
7. Organization managers and personal owners MAY build, refresh, or cancel a
   build and read its redacted log. Members MAY read the build status only. A
   build MUST use saved settings only; the UI MUST require saving first.
8. A build whose revision changes before publication MUST NOT publish. A
   failed refresh MUST NOT remove the previous snapshot. Deleting the
   environment MUST cancel its builds.
9. Automatic builds started by sessions MUST back off after repeated failures
   of one revision. A manual build MUST stay available during backoff.

### Workspace tail snapshots

1. `WORKSPACE_SNAPSHOT_ORG_IDS` and `WORKSPACE_SNAPSHOT_USER_IDS` MUST use explicit
   enrolled IDs. Empty or unset is off. `*` MUST NOT enable snapshots.
2. Only a trusted registered `worktree_*` workspace MAY capture or restore a tail
   snapshot. Standalone sessions MUST NOT capture or restore one.
3. A snapshot MUST belong to one workspace, user, organization, sandbox binding,
   and canonical directory. The source allocation is provenance, not session ownership.
   Only isolated native Cloudflare Containers with interactive origins qualify.
   A sandbox serves one workspace only. Other providers retain ordinary recovery.
4. All sibling sessions in that workspace MUST share one current snapshot.
   A sibling joining or leaving MUST NOT permanently disable future capture.
5. Capture MAY run once after one minute of aggregate workspace inactivity.
   Preparation, native child executions, terminals and admitted filesystem mutations MUST
   fence capture. Provider capture MUST run outside the Sandbox DO queue and MUST NOT delay Stop.
6. Publication MUST reject changed allocation, connection, workspace binding, preparation,
   membership, activity or mutation generation. New admitted work MUST fence pending
   publication before dispatch and MUST NOT delete the current snapshot. A capture failure
   MUST NOT retry repeatedly within the idle period.
7. Session deletion MUST keep the workspace snapshot and allow another idle capture for
   survivors. Only a newer capture, workspace deletion or the user's explicit "Start fresh"
   MAY remove it. Workspace deletion MUST invalidate selection and pending publication before
   resource teardown. Restored disks MUST NOT restore deleted-session authorization or
   recreate a deleted workspace.
8. When a private workspace snapshot exists, cold startup MUST use it as the only source.
   Selection MUST validate ownership, enrollment, provider, startup mode, the exact base
   image and the 30-day lifetime from durable Sandbox DO metadata. A compatible downloaded
   runtime release MAY update the restored disk.
9. Only a confirmed provider restore MAY supply frame-only workspace provenance.
   Every authorized sibling, including later joins, MUST receive it.
   Registration MUST reject supplied restore provenance. Older peers use ordinary recovery.
10. The wrapper MUST validate workspace identity, directory and source allocation stamp.
    It MUST preserve branches, local commits, index, dirty, untracked and ignored files,
    HOME and native databases. It MUST NOT replay checkout, setup, environment adoption
    or older file recovery over a valid tail snapshot.
11. A snapshot MUST contain only the disk. Restore MUST apply the current credentials and
    runtime configuration from the route, as a fresh start does, and reconcile current
    authorization before exposing native sessions. Existing native sessions are reused.
    Missing sessions use history recovery without replacing workspace files.
    New chats MUST attach without resetting files.
12. A transient provider failure MUST retry the same snapshot within the preparation deadline.
    An expired, missing or incompatible snapshot, an incompatible peer, a permanent or repeated
    provider failure, or a failed restore step MUST fail with a specific reason, keep the
    snapshot and queued message identity, and MUST NOT fall back to another source. That
    failure MUST offer "Start fresh", which names the changes since the capture time that it
    discards. A failure that may be transient MUST also say that a new message retries. Diagnostics MUST identify workspace, requesting session, allocation, capture
    time, selected source and failure reason. Logs MUST NOT contain snapshot handles,
    credentials or file contents.
13. Superseded descriptors MUST remain unselectable. Provider artifacts expire 30 days after
    creation or their last restore; each restore resets this TTL. Snapshots preserve disk,
    not running processes, terminals or memory.

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
9. For legacy `agent_*` turns, seven minutes without real progress MUST fail
   the turn, tell the user it did not complete, re-enable the composer, and
   leave the chat usable. A tool or subagent within its own timeout holds that
   legacy inactivity check until it completes or errors.
   For `workspace_*`, every native Kilo execution MUST be supervised, including
   work started without an accepted Cloud message or an open browser. Twenty
   minutes without real assistant text/reasoning or tool output/state progress
   MUST interrupt the affected session/tree with `no_progress`. Silent running
   tools MUST receive the same bound. Repeated parts, metadata-only changes,
   user messages, retry/busy status and heartbeats MUST NOT reset it. Useful
   descendant progress MUST count for its ancestors, never unrelated roots.
   Requests waiting on the user MUST pause only the no-progress clock when no
   independent work is runnable. Resolving one request MUST NOT clear another.
   A Kilo that stops answering while the sandbox reclaims at its memory cap
   MUST be held instead of restarted, for at most ten minutes; the hold MUST
   pause the no-progress clock and post a non-fatal notice. A turn failed by the
   hang restart that ends an expired hold MUST say that the sandbox ran out of
   memory. A turn failed by another hang restart MUST say that Kilo was not
   responding, unless the restart was for exhausted activity-tracking capacity
   or failed activity observation while Kilo still answered. After two minutes
   of failed observation, a healthy probe plus real progress within 30 seconds
   MUST permit continued recovery for at most two more minutes. Health and
   progress MUST be rechecked during recovery; heartbeats MUST NOT extend it.
   A healthy runtime that still cannot be observed at that bound, or no longer
   has recent real progress, MUST use bounded restart recovery without claiming
   that Kilo was unresponsive. The existing memory hold MUST retain precedence.
   The separate 12-hour execution cap MUST include user waits. Native
   cancellation MUST be bounded and confirmed; unconfirmed cancellation MUST
   use bounded runtime recovery. Accepted Cloud messages MUST settle once;
   autonomous routed failures MUST remain visible without inventing new message
   identities or rewriting earlier outcomes.
   Any working native session or actual wrapper operation MUST keep shared
   compute alive. Entirely waiting or idle sessions MUST permit the existing
   10-minute idle stop and same-chat recovery. UI selection MUST have no effect.
   Reconciliation MUST repair missed events without resetting known clocks;
   missing or failed observations MUST trigger bounded observation recovery,
   not a false inactivity result. A stop during retry MUST still end the turn
   immediately (rule 6).
   The user MUST still be able to Stop or queue another message while the
   wrapper reconnects. If the connection returns, accepted work MUST
   NOT fail because the connection dropped. If no wrapper frame arrives for
   five minutes, the environment MUST stop and every accepted message on it
   MUST fail with a specific connection reason; queued messages MUST wait for a
   new environment in the same chat. Each affected composer MUST become usable;
   already-terminal messages MUST stay unchanged. Do not wait for the 12-hour
   execution cap or physical stop confirmation, and do not claim that Kilo
   stalled or returned an error.

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
3. Open workspace tabs — the workspace terminal and file tabs, their order, and
   the active tab — MUST survive refresh and navigation between worktrees, and
   MUST remain scoped to the current user and personal or organization context.

### Shared Worktrees

1. Eligible browser chats for the same worktree MUST appear as exactly one
   selectable row in the sidebar, without nested chat rows. Its label MUST use
   the user-set worktree name, otherwise the first surviving chat's non-default
   title, otherwise the repository and branch. This fallback MUST NOT depend on
   which chats are visible in the current search or recent-session page.
   Selecting the worktree MUST open its latest open chat; when all its listed
   chats are closed, it MUST open the worktree without reopening any of them.
   The row MUST remain visibly
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
   MUST require explicit confirmation that the workspace and its files will also
   be deleted, then delete the worktree. The server MUST reject that conditional
   workspace deletion if another root chat was created before deletion began.
9. Existing ungrouped and legacy chats MUST remain individual sidebar rows and
   retain their current behavior. Worktree grouping MUST NOT change
   native-mobile chat behavior.
10. Closing a chat tab MUST NOT delete its saved session, discard its transcript,
    or stop its running work. Closed-tab preferences and tab order MUST survive
    refresh and remain scoped to the current user and personal or organization
    context. A closed chat MUST reopen only when the user opens that chat
    itself, for example from the Sessions list or its own link. Selecting its
    worktree, closing it while the app is still switching to it, going back
    from the closed tab, refreshing or restoring a window, or another window
    still showing the chat MUST NOT reopen it; a window
    showing a chat closed elsewhere MUST move to an open chat or the worktree.
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
    Saved content deletion MUST NOT depend on an available runtime or container.
    The UI MAY report content removal once ingest deletion succeeds, but MUST
    distinguish incomplete runtime cleanup from complete deletion. Incomplete
    cleanup MUST retain its recovery journal and MUST NOT permit late creation
    or ingestion to resurrect the worktree. It MUST NOT be described as automatic
    background cleanup unless a reconciler is scheduled.
14. Chats in one worktree MUST share one runtime and one MCP configuration.
    Runtime and MCP configuration MUST NOT be isolated per chat, and a sibling
    MUST NOT replace the worktree's configuration. Independent worktrees MUST
    remain isolated. The worktree's MCP configuration MUST be established when
    the worktree is created, MAY be restored when its runtime is rehydrated, and
    MUST be reused by later chats.
15. A workspace's delegated Cloud Agent MCP connection MAY create independent
    child sessions and list, inspect, check exact message results, interrupt, or
    send prompt follow-ups to its direct children. Each management operation
    MUST check current canonical-parent authorization and persisted child
    lineage, owner and organization. It MUST NOT manage the parent itself,
    sibling chats or unrelated sessions. Child completion callbacks MUST target
    either a new chat created in the parent's workspace
    (`workspace:new-chat`) or one existing chat in that workspace
    (`workspace:<session-id>`). The server MUST verify that a session target is
    a root or sibling chat with the same owner, organization and workspace, and
    that it is still accessible; it MUST reject a target outside the spawning
    parent's workspace or any target that is a child session. The target chat
    learns its own session id from the `cloud-agent-context` line in its turns.
    A `workspace:new-chat` callback starts the new chat with the child result as
    its first message, and every workspace callback MUST be idempotent for the
    persisted callback message ID. A child completion callback MUST render as a
    distinct child session message that identifies the child session, shows its
    reported result or failure, and links to that session. It MUST NOT render
    the serialized callback envelope as the user's message.

### Watch PR (Observation-Only Pilot)

Implementation status: lifecycle controls and activity are backend/API and MCP
capabilities. Client watch controls and confirmation described below remain
planned; the current client only shows passive PR hover-card observation counts.
Watch PR admission is best-effort: observer errors do not fail the enclosing
webhook. Only successfully persisted state survives; bounded Redis CI receipts
are not a complete recovery mechanism. Exact recovery limits are documented in
`docs/plans/cloud-agent-watch-pr.md`.

1. An eligible verified GitHub PR MUST offer an accessible watch control without
   requiring hover. Enabling a watch MUST require a writable grouped Cloud Agent
   worktree, current repository access, an open same-repository PR, and pilot
   enablement. Arbitrary PR URLs, fork PRs, and legacy ungrouped sessions MUST NOT
   be eligible.
2. The confirmation MUST state that this pilot observes future delivered webhook
   events only. Pre-existing reviews and checks MAY be missing. It MUST clearly
   state that no automatic repair, agent run, edit, or push occurs. Saved repair
   preferences MUST NOT authorize present or future automatic writes, and MUST
   NOT hide observed problems.
3. Watch state and observations MUST survive closing the browser and sleeping
   compute. Waiting MUST NOT start or keep an environment awake or incur agent
   usage charges. Watching MUST NOT promise complete GitHub delivery coverage or
   merge readiness.
4. Details MUST distinguish Watching, Paused, Finished, observed problems, and
   observations needing attention. Empty evidence MAY say **No observed problems**
   only alongside future-event coverage and last-received timing. Pending,
   ambiguous, and truncated evidence MUST NOT be presented as merge readiness.
5. The user MUST be able to Pause, Resume when pilot enablement permits it, Stop
   watching, and inspect recent activity. Pause MUST preserve observations and
   MUST NOT cause automated execution. Stop, confirmed PR closure/merge, expiry,
   and source worktree deletion MUST fence further watch work. A finished watch
   MUST NOT restart from a delayed webhook or PR reopen event.
6. **Recheck PR lifecycle** MUST be an explicit user action. This pilot's recheck
   MUST state that it verifies PR identity and open/closed/merged lifecycle only,
   not review or check completeness. Refreshing the watch display MUST NOT fetch
   GitHub state. Existing watches MUST remain manageable when new enablement is
   disabled.
7. One PR's control MUST NOT display or mutate a different PR's watch, including
   sibling chats and worktrees reused for another PR. Stale controls MUST fail
   visibly and allow refreshing rather than silently overwriting newer state.

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
   bounded to shared (legacy sessions only), isolated-small,
   isolated-standard, code-review, devcontainer, containers-standard-3,
   containers-standard-4, or unknown.
   Versions MUST be bounded, validated values reported
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
   is 10 minutes for control-plane idle stop; a policy MUST NOT be guessed for an
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
   sandbox type using plain-language labels. Hover, click, and touch MUST show
   the same popup, including a Debug section collapsed by default with labeled
   control-plane mode and reported CLI/wrapper versions. Hover MUST NOT move
   keyboard focus. Moving into the popup MUST keep it open; clicking the trigger
   or interacting inside MUST keep the same view open until dismissed. Compact
   runtime codes MUST NOT be shown. Missing versions
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

### Continuity

A chat MUST behave like a colleague across a working relationship: the user
starts work, takes it across many turns, walks away, comes back, interrupts,
asks questions, and opens more chats -- and the chat stays usable throughout.

1. Any transient failure -- environment loss, wrapper restart, delivery lapse,
   or connection stall -- MUST be recoverable by sending another message in the
   SAME chat. Requiring a new chat to continue the same work is NOT acceptable
   except for a narrow, documented set of genuinely unrecoverable causes.
2. A turn that fails, or is interrupted, MUST leave the chat usable; a
   subsequent message MUST continue in the same chat and, while the environment
   is still warm, in the same environment.
3. An unanswered question MUST NOT pin the environment awake. The idle timeout
   MAY wind the environment down while a question awaits an answer; the user
   MUST be able to return, answer or send another message, and continue after
   the environment is restored.
4. Questions MUST work independently per chat: a question raised in one chat
   MUST be answerable in that chat and MUST NOT be answerable from, or leak
   into, a sibling chat that shares the same worktree.
5. Sustained load -- many turns, several chats at once, high token rates, or
   large streamed tool output -- MUST NOT by itself make a chat unrecoverable.
   A liveness lapse caused by load is a defect to fix, not an expected failure.
6. When the environment winds down while a question or permission awaits an
   answer, the parked turn MUST settle; it MUST NOT remain in progress after the
   environment is gone.

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

Cloud administration surfaces beyond the existing chat sidebar (triggers,
webhooks), profile and organization administration, the mobile app,
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

4. A session on a multi-repository environment has these gaps:
   - A GitHub repository that is reachable only through a connection that is
     restricted to agents is not found.
   - GraphQL requests in the additional repositories use the access of the
     launch repository.
   - A repository on another git platform than the launch repository gets no
     CLI token.
   - A repository that cannot be authorized fails the start with a generic
     message that does not name it. A timeout while authorizing fails as a
     workspace setup failure.
   - The sandbox picker does not know the environment. It can show a Vercel
     default that the session skips.
   - With several repositories, the agent runs at `/workspace` and does not
     load the `AGENTS.md` or skills of each repository.

## Changelog

### 2026-11-04 -- Environment start commands

- Environments have a workspace start script that runs each time a workspace
  starts, after setup or from a snapshot. It is not part of a build, and a chat
  that joins a running workspace does not run it.
- A workspace that starts from an environment snapshot, at any revision, skips
  the environment's setup, but still runs request-supplied setup. Changed
  environment setup commands take effect after the next build.
- Start commands also run after a session disk snapshot restore, because no
  process survives a snapshot.

### 2026-11-04 -- One sandbox per workspace

- One sandbox serves one workspace only. The shared sandbox is retired: new
  sessions cannot request it, and a saved shared default is skipped.
- Stored sessions, settings and triggers that name the shared sandbox still
  load. A session on it does not resume and needs a new session.

### 2026-11-03 -- Environment selection preferences

- Remember the environment choice per repository and personal/organization scope.
- Apply the effective default profile to multi-repository environments unless an
  explicit profile replaces it. Repository bindings remain ignored.

### 2026-11-03 -- Snapshot notice removal

- Removed the snapshot-reuse notice requirement to match the simplified
  environment, profile, and launch screens. Snapshot reuse and cached-file
  retention rules remain unchanged.

### 2026-10-31 -- Worktree-owned runtime and MCP configuration

- Chats in one worktree share the worktree's runtime and MCP configuration; they
  are not isolated from each other per chat.
- Independent worktrees remain isolated. MCP configuration is established when
  the worktree is created or rehydrated and is reused by later chats.

### 2026-10-29 -- Multi-repository environments

- An environment can contain several repositories, and a repository can be in
  several environments. One match applies; several need a choice in the web UI
  and give no environment elsewhere.
- Multi-repository environments ignore the repository binding and the implicit
  default profile, run in an isolated sandbox under `/workspace`, and start only
  from a snapshot of the same repositories.

### 2026-10-22 -- Environment editor and profile transition

- Added focused setup script and variable editors, with readable sandbox sizes.
- New environments use the repository name without a separate name field.
- Added notices for skipped profile commands and overridden variable keys.
- New and replaced variable values are encrypted. Existing configuration stays
  intact until the user changes or removes it.
- Saved variables remain in the editor with explicit retention markers.
- Setup uses Bash with automatic failure handling and supports scripts up to
  16,000 characters.

### 2026-10-21 -- Automatic repository environments

- A repository has at most one environment per owner, and approved origins
  apply it automatically. The user no longer selects one.
- Moved the sandbox size into the environment and removed the sandbox choice
  from the new-session form.
- Profile setup commands do not run while an environment applies, so a setup
  moved into the environment never runs twice.
- Saving a sandbox size that the owner cannot use for the repository fails.
### 2026-10-16 -- Environment snapshots

- Added environment snapshots: built from saved environment settings on the
  base image, consumed by sessions of the same environment and an equal or
  newer revision, with a bounded lookup and one fresh fallback.
- Removed session capture and the "saving the repository" preparation step.

### 2026-10-15 -- Observation-only Watch PR pilot

- Added the flagged observation-only contract, lifecycle controls, future-event
  coverage, and lifecycle-only manual recheck. Automatic repairs remain blocked
  on exclusive runtime admission and revocable publication enforcement; this is
  not the automatic-repair MVP in `docs/plans/cloud-agent-watch-pr.md`.

### 2026-10-07 -- Repository environments

- Added the repository environment definition and a Start rule: an optional
  saved setup for the chosen repository, distinct from the sandbox Environment.
  Omitting it leaves launch unchanged; its setup commands run as preparation
  steps and never reveal secret values.

### 2026-09-26 -- Bounded workspace control recovery

- For `workspace_*` chats, made the wrapper the owner of Kilo progress and
  execution limits. Lost wrapper contact has one five-minute bound from the
  last wrapper frame; then the environment stops, accepted work fails with a
  connection reason, and queued work waits for a new environment in the same
  chat. Design: `services/cloud-agent-next/docs/control-plane.md`.

### 2026-09-21 -- Decoupled turn and sandbox idle bounds

- Raised Turn rule 9 to seven minutes and made the turn inactivity bound a
  distinct value from the control-plane idle stop. Retry and offline status
  remain non-progress.
- Changed the Sandbox status rule 7 policy to 10 minutes for control-plane idle
  stop, so the advertised `inactivityTimeoutMs` and `estimatedSleepAt` match the
  sandbox stop.

### 2026-09-12 -- Bounded turn inactivity

- Added Turn rule 9: a turn with no real agent progress for five minutes fails
  with "Turn did not complete", re-enables the composer, and leaves the session
  usable. Retry and offline status are not progress. Added Continuity rule 6:
  a turn parked on an unanswered question or permission must settle when the
  environment winds down.

### 2026-09-11 -- Session continuity

- Added the Continuity rules: transient failures recover in the same chat, an
  interrupted turn leaves the chat usable, unanswered questions do not pin the
  environment awake, questions stay per-chat, and load must not wedge a chat.

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
