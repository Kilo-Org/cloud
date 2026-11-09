# Plan: Cloud Agent workspace snapshot recovery and command policy

Status: agreed direction, ready for implementation planning
Incident: `workspace_8e194414-12b2-4f8e-9cfd-db194e4346ee` / `ses_e5237974effcexDpA9cMjvLcu6`,
turn `msg_1aff7b5bb0003Dv6AokGP0Mef7`, failed 2026-11-06T08:33:26.801Z.
A second occurrence was observed the same morning in a `Kilo-Org/cloud` workspace
(screenshot: tail restore, "Setup command 1 failed, exit 1, 0s", then
"Previous snapshot startup failed. Retrying without a snapshot.").

## 1. Goal

A session must never become permanently broken because of how its workspace
starts. A workspace is a continuation: if it has a workspace snapshot, resume
from it. Build work happens only in environment builds. Session-level command
failures are reported, not fatal.

## 2. What happened (verified against the code)

1. The workspace tail snapshot restored and was confirmed
   (`src/control-plane/sandbox/sandbox-do.ts:4573-4589`).
2. The tail path ran the environment's **start** command
   (`wrapper/src/control-plane/prepare.ts:753-760`). It reuses the `setup` step,
   the `setup_command_failed` subtype (`wrapper/src/control-plane/repository-preparation.ts:301-308`)
   and the hard-coded "Running setup commands" / "Setup command N" labels
   (`src/control-plane/session/session-do.ts:3287-3290`, `:3318`). It looked like a
   build command failure, but on a tail restore only `startCommands` can run, and
   `startCommands` come only from the environment's Start field
   (`packages/cloud-agent-profile/src/profile-session-config.ts:455`).
3. The start command failed because of the repository's own build script.
   `.kilo/cloud-agent-setup.sh` installs a global pnpm shim (lines ~284-302) that
   exits 1 when the dev memory cgroup is missing (lines ~293-297). The tail
   snapshot restores the shim and `.wrangler/kilo-startup/env`, but not the
   cgroup (kernel state) or daemons. Every `pnpm` call inside the repo fails after
   a resume, including the agent's own.
4. Any `workspace_setup_failed` on a snapshot start is recorded as a snapshot
   preparation failure and stops the allocation (`sandbox-do.ts:4926-4978`,
   triggered from `session.failed` at `:5448-5458`).
5. `previousSnapshotStartFailed` (`src/control-plane/sandbox/environment-snapshot-launch.ts:84-90`)
   is one global flag. It is read at `sandbox-do.ts:2400` (create deadline),
   `:4739` (tail skip) and `:4814` (environment skip, sets `skipRepository`). The
   next allocation therefore skipped both the tail and the environment snapshot and
   started from the base image. That ran the full list: environment build
   commands, then start commands (`prepare.ts:803-819`).
6. The descriptor was not deleted by the failed restored allocation (it failed
   1.38 s after hello; the first heartbeat is sent after 45 s, `wrapper/src/control-plane/connection.ts:298`).
   It was deleted by the **image fallback allocation's** first heartbeat while it
   cloned: `heartbeat.active` is true during preparation (`wrapper/src/control-plane/main.ts:208`)
   and the Sandbox DO deletes the descriptor on it (`sandbox-do.ts:5360-5361`).
   From then on every cold start re-clones and re-runs setup. This is why the
   session stays broken.
7. Other delete paths: warm `runPrepare` (`sandbox-do.ts:2502-2503`), `prompt`
   (`:2926`), `answer`/`abort` (`:3370`), `terminal` (`:1448`), `abort` (`:1060`),
   `release` (`:1082`), image fallback after a provider snapshot failure (`:4591`)
   and restore retry (`:4992`). All go through `invalidateWorkspaceSnapshot`
   (`src/control-plane/sandbox/workspace-snapshot.ts`), which deletes the
   descriptor and bumps `invalidationGeneration`.
8. Diagnostics: the command output is already durable in the Session DO
   preparation steps (`session-do.ts:3338-3346`); the wrapper log upload can be
   lost when the DO stops the allocation right after the failure. The command text
   is not sent; the UI only shows "Setup command N".

## 3. Decisions

### 3.1 Workspace snapshot lifecycle

1. The Sandbox DO never deletes a workspace snapshot descriptor on its own.
   Only these remove it:
   - a newer successful capture replaces it;
   - the workspace is deleted;
   - the user explicitly removes it ("Start fresh").
2. Admitted work (prompt, answer, abort, terminal, preparation, active heartbeat,
   release) only bumps the capture generation. It does not delete.
3. Capture publication keeps rejecting a capture whose generation changed while
   it ran (`captureIdleWorkspaceSnapshot`, `workspace_mutated`). Reason: a capture
   that overlaps new work can record a torn disk (half-written files, a leftover
   `.git/index.lock`, partial `node_modules`). Rejecting keeps the previous
   consistent snapshot and costs one later capture. "Publish anyway and override
   later" is rejected because a crash before the next capture would restore the
   torn disk.
4. Session deletion (`release`) keeps the workspace snapshot: it belongs to the
   workspace. Authorization is still reconciled from current routes on restore
   (tail rule 11). Spec tail rule 7 must be reworded accordingly.
5. An idle stop already follows a capture: the alarm captures after 60 s of
   idle (`sandbox-do.ts:5833-5837`), long before the 10-minute interactive idle
   stop. The restore can still be older than the user's last state when the
   allocation stopped without going idle (crash, OOM, eviction) or the single
   idle capture attempt failed or was rejected. No system row is shown for this.

### 3.2 Startup order

| Workspace state | Start from | On failure |
|---|---|---|
| Workspace snapshot descriptor exists | The workspace snapshot only | Transient provider error: retry the same snapshot within the preparation deadline. Permanent (artifact expired after the 30-day TTL, image mismatch, wrapper provenance check fails at `prepare.ts:680-703`): fail with a specific reason and offer "Start fresh", which names what is discarded ("changes since <capture time>"). Never fall back to another source. |
| No workspace snapshot, environment with build commands | The environment snapshot only | Not built, building, failed or in backoff: fail with that reason and a link to the build. Snapshot start fails: retry, then fail with "Rebuild environment". No base image fallback. |
| No workspace snapshot, environment without build commands, or no environment | Base image | Ordinary preparation. |

Consequences:

- `previousSnapshotStartFailed`, `skipRepository`, and the image relaunch after a
  provider snapshot failure (`sandbox-do.ts:4511-4572`) go away for both snapshot
  kinds.
- The create deadline at `sandbox-do.ts:2400` is chosen from the selected source,
  not from a global flag.
- A command failure is never a snapshot failure.

### 3.3 Command policy

| Kind | Source | Runs | Failure |
|---|---|---|---|
| Build commands | Environment setup commands | Environment build only | Fatal for the build; the previous snapshot is kept (environment rule 8) |
| Session setup | Request-supplied and profile setup commands | Fresh start and environment snapshot start. **Not** on a workspace snapshot restore | Non-fatal: system row plus agent note, continue |
| Start commands | Environment start commands | Fresh start and environment snapshot start. **Not** on a workspace snapshot restore | Non-fatal: system row plus agent note, continue |
| (none) | Workspace snapshot restore | No commands | Only snapshot start failures apply (3.2) |

Accepted trade-off: after a workspace snapshot resume, nothing from the start
commands is running (no dev server, no daemons). The agent can start them if
needed. Previews that rely on start-command processes are down until then.

Commands keep their timeouts (5 min inactivity, 8 min hard,
`repository-preparation.ts:26-27`). A timeout is handled as a non-fatal failure
for session setup and start commands.

### 3.4 Telling the user and the agent

- **User:** a chat system row for each failed session setup or start command:
  kind, index, command text, exit code or timeout, and a link to the stored
  output in the preparation drawer. This is a new row type.
- **Agent:** a short note in the server-owned prompt `context` field
  (`src/shared/control-plane-protocol.ts:716`, max 2000 chars), set by the Sandbox
  DO on the first prompt after that preparation. Example: "Start command 2
  (`pnpm dev:start`) exited 1. Last output: …". v1 sends it as a hidden synthetic
  part (`wrapper/src/kilo-api.ts:420`); v2 prepends it to the prompt text
  (`wrapper/src/control-plane/kilo2-harness.ts:224`). The Cloud history keeps the
  user's original message.

### 3.5 Preparation UI and diagnostics

- The setup events carry `kind` (`build | session_setup | start`) and the
  command text, passed through the same `redact` as the output
  (`repository-preparation.ts:273-276`). `recordSetupEvent` uses them for the
  phase title ("Running start commands", "Running session setup") and the label
  ("Start command 1 · `pnpm dev:start`").
- New subtypes `start_command_failed` / `start_command_timeout` (or a non-fatal
  warning record, since these no longer fail preparation).
- The wrapper includes bounded failure fields in its report (kind, index, exit
  code, termination reason, elapsed). The Sandbox DO logs them with the existing
  warning at `sandbox-do.ts:5440-5447`. No command text or output in logpush
  (tail rule 12, security baseline); the output stays in the Session DO.
- Command text is shown to everyone who can see the session's preparation,
  like the output already is.

### 3.6 Repository build script (separate change, in progress)

A child Cloud Agent session is fixing `.kilo/cloud-agent-setup.sh`:

- the pnpm shim recreates the missing dev cgroup when the delegated parent
  exists, instead of exiting 1;
- without the delegated parent it warns and runs the real pnpm;
- optionally a fast, idempotent resume path that recreates the cgroup and starts
  Docker and dnsmasq without installs;
- `.kilo/skills/cloud-agent-sandbox/SKILL.md` updated for the tail-snapshot case.

General lesson for environment authors: a workspace snapshot restores files, not
kernel state or processes. Scripts must not leave on-disk shims that hard-fail
when runtime state from the original run is missing.

## 4. Implementation outline

### Phase 1: stop losing the workspace (Worker)

1. `workspace-snapshot.ts`: split `invalidateWorkspaceSnapshot` into a
   generation bump only; keep `deleteWorkspaceSnapshot` for workspace deletion
   and the user action. Add `workspace_snapshot_fenced` diagnostics; keep
   `workspace_snapshot_descriptor_removed` for real deletions.
2. `sandbox-do.ts`: switch every call site listed in 2.7 to the bump. Remove the
   deletes at `:4591` and `:4992`.
3. Startup: in `workspaceSnapshotLaunch` (`:4698`), select the tail whenever a
   compatible descriptor exists, independent of the previous launch record. If a
   descriptor exists but is incompatible (image or runtime mismatch, expired),
   fail with a specific reason; do not fall through to the environment snapshot or
   the image. Remove `previousSnapshotStartFailed` from `:2400`, `:4739`, `:4814`.
4. `retryRepositoryPreparation` (`:4926`): never treat a command failure as a
   snapshot failure. Keep the guard that refuses to recreate while a sibling route
   is ready (`:4945`).
5. Provider snapshot start failure: retry the same artifact within the deadline;
   classify permanent failures; fail the route with a specific reason instead of
   relaunching from the image.
6. User action "Remove workspace snapshot / Start fresh": tRPC mutation through
   the Session DO to the Sandbox DO, which calls `deleteWorkspaceSnapshot` and
   lets the next start use the environment snapshot or image. Show it on the
   failure state of a snapshot start.

### Phase 2: command policy (wrapper and Worker)

1. `prepare.ts:751-760`: remove start commands from the tail path.
2. `prepare.ts:803-819`: split the list into session setup and start commands.
   Build commands are already skipped on an environment snapshot start
   (`environmentSetupCommandCount`). Run session setup and start commands as
   non-fatal: collect failures, report them, continue preparation.
3. Report non-fatal command failures to the Sandbox DO (new frame or a field on
   `session.ready`).
4. Sandbox DO stores pending notes per route and attaches them to the next
   prompt's `context`.
5. Session DO: system row for each failed command; setup event `kind` and
   command text in labels; new phase keys.
6. Consumers of the public preparing steps: `src/shared/protocol.ts:142`,
   `apps/web/src/components/cloud-agent-next/preparation-phases.ts`, mobile
   `preparation-copy.ts` and i18n, `packages/cloud-agent-sdk/src/service-state.ts`,
   `src/kilo-facade/cloud-agent-extension-events.ts`.
7. Remove `startCommandsForWrapper` and `WrapperStartCommandsUnsupportedError`
   (`src/control-plane/sandbox/start-commands.ts`) and send start commands only on
   non-tail starts.
8. Run profile setup commands beside an environment as session setup: remove
   the drop at `packages/cloud-agent-profile/src/profile-session-config.ts:441-445`
   ("The repository environment owns setup"). A profile command that was also
   moved into the environment now runs twice; it is non-fatal, and the user can
   remove the duplicate from the profile.

### Phase 3: environment required when it has build commands

1. When the admitted environment has build commands and no compatible published
   snapshot exists, fail preparation with "Environment not built" / "Environment
   is building" / "Environment build failed" and a link to the build.
2. The environment lookup timeout or unavailability with build commands: retry
   within the 15 s budget, then fail with a specific reason (environment rule 2
   currently requires a base image start).
3. **Base image rollouts:** selection requires an image match
   (`workspace-snapshot.ts` `image_mismatch`, and the environment snapshot
   compatibility). Without action, an image bump makes every environment "not
   built" and every session fails. Either trigger rebuilds automatically on an
   image change and keep the previous snapshot usable until the rebuild
   publishes, or allow the previous image's snapshot within a compatibility
   window. This must ship with Phase 3.

### Phase 4: spec and docs

`.specs/cloud-agent-session.md`:

- Session rule 5: start commands do not run on a workspace snapshot restore;
  session setup and start command failures are reported and do not fail the
  turn.
- Environment rule 2: no base image start for an environment with build
  commands when its snapshot is missing or the lookup is unavailable.
- Environment rule 3: session setup (request and profile) vs build commands.
- Environment rule 5: no base image fallback after a snapshot start failure.
- Tail rule 6: admitted work fences publication; it does not delete.
- Tail rule 7: session deletion keeps the workspace snapshot.
- Tail rule 8 and 12: the workspace snapshot is the only source when present;
  failure ends with a user choice, not an automatic fallback.

`services/cloud-agent-next/docs/control-plane.md`: "Workspace tail snapshots" and
"Setup skip" sections.

## 5. Rollout

No compatibility layer. The Worker deploy selects the wrapper release for new
allocations, and protocol additions are additive, so older wrappers in running
allocations keep working against the new Worker until those allocations stop.

- New subtypes are classified as user-caused and added to the benign list in
  `packages/db/src/schema-types.ts` (near the existing `setup_command_failed`
  entry) and the code-review terminal-reason mapping, so they do not page.
- Existing descriptors stay valid: under the current code any descriptor still
  present was never invalidated.
- Ships behind the existing workspace snapshot enrollment
  (`WORKSPACE_SNAPSHOT_USER_IDS` / `WORKSPACE_SNAPSHOT_ORG_IDS`). Watch:
  `workspace_snapshot_selection`, `workspace_snapshot_restore`, snapshot start
  failures by reason, non-fatal command failures by kind, and "Start fresh" usage.

## 6. Tests

- `workspace-snapshot` unit: bump keeps the descriptor and changes the
  generation; a capture overlapping a bump is rejected and the previous
  descriptor stays; only workspace deletion and the user action delete.
- `sandbox-do` integration (`test/integration/control-plane-workspace-snapshots`):
  - a confirmed tail restore whose start command would fail now prepares
    without running it, and the descriptor survives;
  - an image-start allocation's active heartbeat does not touch the descriptor;
  - a transient provider snapshot failure retries the same tail; a permanent one
    fails with a specific reason and no image relaunch;
  - an environment with build commands and no snapshot fails with
    "Environment not built"; without build commands it starts from the image;
  - session release keeps the descriptor.
- Wrapper unit: tail restore runs no commands; a failing session setup or start
  command is reported as non-fatal with kind, index and exit code, and
  preparation continues; build commands are skipped on an environment snapshot
  start.
- Session DO unit: system row for a failed command; labels use kind and command
  text; next prompt carries the agent note in `context`.
- Local E2E: resume a workspace whose start command fails: the session resumes
  from its snapshot, the turn runs, the failure row and agent note appear only on
  non-tail starts.

## 7. Immediate recovery for the incident session

- Its tail descriptor was deleted at 08:27:27.704 and the provider snapshot ID is
  not logged (by design, tail rule 12). It cannot resume from its tail.
- Its next start goes to the environment snapshot only if the route has an
  admitted isolated environment; otherwise the base image. Check the
  `snapshot_launch` reason (`no_environment` / `not_isolated`).
- Check the Session DO preparation steps for the failed attempt: the start
  command's output should be stored there.

## 8. Resolved details

1. Profile setup commands are session setup and run beside an environment
   (Phase 2, item 8).
2. "Environment not built" keeps today's build admission: the session's
   environment lookup already admits a replacement build
   (`environment-snapshot-launch.ts` `admissionText`). The failure message states
   that build's status.
3. "Start fresh" appears on the failure state of a workspace snapshot start only.
4. No separate capture before idle stop: the 60 s idle capture already runs
   before the idle stop (3.1, item 5).
