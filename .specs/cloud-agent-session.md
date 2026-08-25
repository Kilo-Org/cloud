# Cloud Agent Session

## Role of This Document

The user-visible contract for a Cloud Agent chat, and the oracle for manual
end-to-end testing. Every rule is a fact a tester can observe in the chat
itself, without reading logs. It does not prescribe implementation and it
carries no test mechanics: stack setup, account provisioning, and the mapping
from a rule to a wire event belong to the `test-cloud-agent` skill. Any backend
serving this chat MUST satisfy this surface; the user MUST NOT be able to tell
which implementation they are on.

## Status

Draft -- created 2026-08-24, revised 2026-08-24 after an audit against the
implementation.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" are to be
interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when,
they appear in all capitals, as shown here.

## Definitions

- **Session**: one chat bound to one repository and one environment.
- **Environment**: the isolated workspace where the agent runs.
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

### Persistence

1. Refresh MUST restore the transcript, the preparation history that was shown,
   delivery failures, and any still-open question or permission.
2. Refresh MUST NOT start a new turn.
3. If the environment dies, the next prompt MUST recover in the same chat. The
   user MUST NOT be forced to start a new session.

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

The Cloud pages around the chat (sessions list, MCP Gateway, triggers,
webhooks), profile and organization administration, the mobile app, and the CLI.
Also out of scope, and deliberately so: which sandbox provider runs the
environment, the shape of session ids, and the streaming wire protocol. A tester
MUST NOT be able to tell those apart from the chat.

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
