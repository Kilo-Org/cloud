# Mobile Agent Workflow

Use this workflow when the product surface of the work is the mobile app. Start Kilo from `apps/mobile/` so the role agents in `.kilo/agent/` are discovered. The plan may still change cloud services, tRPC routers, shared packages, infrastructure, or a sibling checkout such as `~/Projects/kilocode`: "mobile" is the product, not a directory boundary.

## Ground Rules

These apply to every session and role. Later sections do not repeat them.

- Work only in dedicated worktrees, in every repository the plan touches. Never edit a primary or main checkout.
- The first session is the planner. After plan approval, a fresh session becomes the orchestrator.
- The orchestrator owns product judgment, architecture, loop control, final verification, Git, and the PR. Role agents never dispatch agents, commit, push, or create or update a PR.
- Every reviewer and verifier invocation is a fresh session, so earlier conclusions cannot anchor later passes.
- Choose the simplest maintainable implementation that fully satisfies the accepted requirements. Reuse existing code and contracts. Do not add abstraction or scope without evidence it is required.
- Commit in small, logically scoped commits. Never squash everything into one catch-all commit unless the user asks.

### Models

| Session | Model |
|---|---|
| Role agents (all four) | `kilo/x-ai/grok-4.5`, high reasoning, pinned in their definitions |
| Orchestrator | `kilo/moonshotai/kimi-k3`, high reasoning |
| Planner | `kilo/moonshotai/kimi-k3`, high reasoning, unless the user picks another model |

Never use `kilo/kilo-auto/free` — it is rate-limited. Not even as a fallback: if a call stalls or errors, retry or relaunch on the assigned model. Product-side LLM calls in E2E flows follow "Real LLM responses" below.

### Dispatching Role Agents

Role agents always run inside the Kilo CLI. The four agents in `apps/mobile/.kilo/agent/` (`mobile-plan-reviewer`, `mobile-implementer`, `mobile-reviewer`, `mobile-e2e-verifier`) have `mode: all`, so any harness — kilo or not — can dispatch one directly:

```bash
cd <worktree>/apps/mobile   # .kilo/agent/ must be discoverable from the cwd
kilo run \
  --model kilo/x-ai/grok-4.5 \
  --variant high \
  --agent mobile-plan-reviewer \
  --title "Plan review via role agent" \
  "Please review the attached plan."
```

### Delegation and Escalation

The orchestrator is the expensive model driving cheap role agents. Its output is judgment — handoffs, steering, triage, verification — not diffs.

- When the orchestrator diagnoses a problem, the diagnosis goes into a role handoff with acceptance criteria. The orchestrator does not implement the fix itself, even when it already knows it.
- The orchestrator may edit directly only: merge-conflict resolution, one-line configuration, and the final narrowly scoped repair in the last orchestration step. Everything behavioral goes through an implementer and a fresh reviewer.
- When a loop iteration fails, escalate in order:
  1. Re-dispatch the same role with sharper steering: the diagnosis, the failing evidence, what was already tried, and a narrower goal.
  2. If the steered round also fails, restructure: split the slice or change the approach in the handoff.
  3. Take over directly only when a steered round produced zero new progress. Record every takeover with a one-line justification in the final report.
- Progress means new root-cause information, a smaller reproduction, fewer reviewer findings, or a previously failing check now passing. The same error under the same theory twice is not progress.
- Never loop indefinitely: a steered round with zero new progress requires takeover.

### Real LLM Responses

Any step where an agent or LLM must respond — cloud-agent sessions, chat flows, E2E acceptance states — uses real model calls on `kilo-auto/efficient`, always. If an `efficient` call stalls or errors, retry on `efficient`; never switch models. The fake-llm server and every other form of LLM mocking are prohibited unless a real call cannot produce the required state (for example, forcing a specific provider failure); each use must name the mock and carry a written justification in the handoff and the final report.

### Step Limits

Hard ceilings: `mobile-plan-reviewer` 40, `mobile-implementer` 80, `mobile-reviewer` 50, `mobile-e2e-verifier` 100. Size every handoff below 75% of the role's limit; an implementation slice should fit in roughly 60 planned steps. Never raise a limit to fit an oversized task — split the task.

## Interaction Modes

The planner's first message asks the user exactly one question: is this run `hands on` or `hands off`? The mode governs the planner, the orchestrator, and every later decision.

- `hands on`: ask the user one question at a time until requirements, trade-offs, acceptance criteria, and the plan are unambiguous. Get explicit user approval of the plan before launching the orchestrator. Ask the user when a repair loop or ambiguity cannot be resolved.
- `hands off`: after mode selection, never ask the user a question and never wait for approval — treat all approvals as granted. Interrogate the plan yourself for missing requirements, trade-offs, risks, and acceptance criteria. Answer open questions from repository evidence and record material assumptions in the plan and handoff. Continue through planning, implementation, review, E2E, PR creation and repair, Kilobot review, conflict resolution, and green CI. Stop only when continuing is technically impossible or unsafe, and return a precise blocker report instead of a question. A blocked E2E criterion is a blocker, never something to self-accept.

In both modes the planner resolves every unknown before handoff: with the user in hands-on, from repository evidence with recorded assumptions in hands-off. After launching the orchestrator, the planner switches to monitor mode (below) and does not resume hands-on work.

Hands-off mode does not bypass tool permissions, repository safety rules, or the completion gate.

## Feature State Matrix

Define these four states for every new user-facing feature before implementation begins:

| State | Required experience |
|---|---|
| Happy | The task completes and the resulting state is clear. |
| Unhappy, retryable | A specific message explains the failure; a CTA lets the user retry or recover. |
| Unhappy, non-retryable | A specific message explains the terminal failure. No CTA. |
| Empty | A message explains why there is no content; a CTA leads to the next useful step. |

Rules:

- Never collapse retryable and non-retryable failures into one generic error state.
- For each state the plan defines: the trigger or classification rule, the message intent, the CTA label and outcome (or its required absence), and the automated and E2E coverage.
- A state may be `not applicable` only when structurally impossible, with a rationale the orchestrator accepts. Inconvenient or hard to set up does not qualify.
- Automated tests cover every applicable state's selection logic and CTA presence or absence.
- E2E exercises every applicable state that can be produced safely and deterministically, and explicitly reports any state it could not reproduce.

## Planning

1. Explore requirements in the selected mode. Inspect the affected repositories. Define acceptance criteria, the feature-state matrix, and non-goals.
2. Create the dedicated worktrees.
3. For defect work, run the bug reproduction gate before writing the plan.
4. Write the complete draft plan.
5. Run the plan review gate.
6. Hands-on: get explicit user approval. Hands-off: self-approve.

### Bug Reproduction Gate

For defect work, dispatch a fresh `mobile-e2e-verifier` in repro mode on the unmodified baseline in the dedicated worktree before writing the draft plan. Its assignment: reproduce the reported issue — fix nothing — and return exact reproduction steps, evidence, and a failure classification. It claims iOS with `--phase prewarm`. The claimed device and warmed services carry into the planner handoff as resources to preserve; the final verifier later reclaims the same device with `--phase verify`.

A confirmed reproduction feeds the plan: the steps and classification inform the root-cause hypothesis, and the confirmed repro flow passing becomes an acceptance criterion the final verifier must rerun.

`Cannot reproduce` is a blocker, not a license to fix an unconfirmed bug. Hands-on: return the repro evidence to the user and ask how to proceed. Hands-off: stop with a blocker report containing that evidence — no plan, no orchestrator.

### Plan Review Gate

After the draft plan is complete and before approval, dispatch a fresh `mobile-plan-reviewer`.

- Treat every finding as untrusted advice: the reviewer has less context than the planner and may be wrong. Verify each claim against the request, repository evidence, and applicable instructions.
- Fix only valid findings. Record rejected findings with a short technical rationale; a rejected finding must not reopen without new evidence. Never weaken or expand the plan just to satisfy the reviewer.
- After fixing valid findings, dispatch another fresh reviewer. Repeat until a fresh reviewer returns `No findings.`
- If three consecutive rounds stay stuck on the same issue, the planner resolves it directly, records the resolution, and dispatches one final fresh reviewer that must return `No findings.` This deadlock-breaker is for plan text only — the planner edits its own plan here. Delegated implementation work follows the escalation ladder in Ground Rules.

### Planner Handoff

After approval the planner implements nothing. It writes a sanitized handoff file and launches a fresh orchestrator.

The handoff must contain:

- The selected mode; for hands-off, a direct instruction to never ask the user questions or wait for approval
- The final plan-review result and rationales for rejected findings
- The absolute path of the accepted plan and any approved design
- The dedicated worktree path for every repository in scope, with each worktree's current branch, commit, and working-tree state
- Acceptance criteria, feature-state matrix, execution ledger, non-goals, and unresolved risks
- For defect work: the reported defect, the confirmed reproduction steps and failure classification, and the repro run's resource manifest
- Existing changes and resources that must be preserved
- The completion gate, with a direct instruction to continue until the PR is mergeable and conflict-free with all expected CI checks green on the latest head
- The GitHub comment rule (see GitHub Communication)

Write the handoff to a temporary file outside every repository. Sanitized explicit values only: never secrets, raw environment-file contents, or an attached `.env`, `.env.*`, `.dev.vars`, or equivalent file.

Launch the orchestrator in the current tmux session with a unique, descriptive window name:

```bash
tmux new-window -t <planner-tmux-session> \
  -n <feature>-orchestrator \
  -c <dedicated-worktree>/apps/mobile \
  'kilo run "Execute the approved mobile plan in the attached handoff. Own implementation through the completion gate." --interactive --model kilo/moonshotai/kimi-k3 --variant high --title "<feature> orchestrator" --file <sanitized-handoff-file>'
```

Use `kilo run --interactive` exactly as shown, with the message positional before the flags: `--file` accepts multiple values and would consume a trailing message as a file path, failing with `File not found`. Do not add `--continue` or `--session`; the orchestrator must be a fresh session. Verify the tmux window started, then report the window name, worktree paths, model, and handoff path to the user. The orchestrator deletes the handoff file after ingesting it.

### Planner Monitor Mode

After the handoff the planner stops all hands-on work: no planning, implementation, or product judgment. It has exactly one job — unblock the orchestrator when infrastructure fails.

- Unblock: a wedged or crashed kilo CLI, a dead orchestrator tmux window, a hung service or simulator the orchestrator cannot restart itself.
- Do not intervene: product, logic, design, or review problems. Those are the orchestrator's, handled by its escalation ladder.

Everything the orchestrator does runs in the shared tmux session; inspect its windows and service logs directly. Run one check about every 30 minutes and stay idle between checks. Stop when the orchestrator reaches the completion gate or returns a blocker report.

## Roles

| Agent | Responsibility | Repository edits |
|---|---|---|
| `mobile-plan-reviewer` | Reviews a complete draft plan for ambiguity, unsupported claims, and missing execution detail | Denied |
| `mobile-implementer` | Implements one bounded task from the accepted plan and runs narrow checks | Where the task requires |
| `mobile-reviewer` | Independently reviews the full relevant diff and tests | Denied |
| `mobile-e2e-verifier` | Exercises accepted behavior; in repro mode, reproduces a reported defect on the unmodified baseline | Temporary only |

## Local Tooling

Start and inspect the local stack, simulator, login, and E2E flows per [e2e/AGENTS.md](../e2e/AGENTS.md). Never ask the user to start Metro or backend services. Two helpers cover most runs:

- Seed data: `pnpm dev:seed` with no arguments lists every topic. Use it to resolve or create users, grant credits, and mint tokens (`app:user-id`, `app:create-user`, `app:add-credits`, `app:api-token`) instead of hand-writing SQL or JWTs.
- Remote CLI sessions: for session discovery, mirroring, or mobile-to-CLI messaging, the orchestrator runs `apps/mobile/e2e/remote-cli.sh start [email]` to launch a local kilo CLI as a remote session against this worktree's stack. Use `remote-cli.sh exec <kilo args...>` for one-off CLI commands (`remote`, `session list`, `run`, ...) against the same prepared stack. Role agents reuse the prepared session; they never mint tokens or install the CLI.

Env sync between the app bundle, Metro, and this worktree is validated by `apps/mobile/e2e/preflight.sh` (run by `login.sh`). Trust its failure output instead of re-checking URLs by hand.

## Execution Ledger

Split the accepted plan into the smallest behaviorally meaningful, independently testable slices. Before dispatching anything, record each slice:

- Slice ID, dependencies, priority, and estimated step cost
- Exact writable path set and forbidden path set in every repository
- Shared generated outputs and mutable runtime resources
- Producer-consumer dependencies on contracts, schemas, generated code, or runtime state
- Ownership-safe narrow checks, and checks deferred to the synchronization barrier
- Intended commit boundary

Two slices are parallel-safe only when all of these hold: their write sets do not overlap, neither consumes an unstable output of the other, they share no mutable runtime resource, and neither runs a repository-wide mutating command. File separation is not enough when one slice changes a contract the other consumes. Always serialize: lockfile changes, dependency installs, migrations, generated clients, repository-wide formatters, and broad autofix commands.

## Orchestration

1. Ingest the handoff. Split the work into ledger slices.
2. Dispatch ready independent slices in a wave of at most two or three concurrent `mobile-implementer`s. Each handoff lists the other active slices and their ownership boundaries. While a wave is active, run only ownership-safe narrow checks.
3. When the whole wave has returned, synchronize: inspect each result, ownership adherence, and the combined diff; resolve integration and architecture decisions yourself; run shared mutating commands and shared checks once. If one slice failed, preserve the successful ones.
4. Dispatch one fresh `mobile-reviewer` over the wave diff. Triage findings yourself: route valid findings through a bounded repair wave; record rejected findings with a short rationale. Loop repair wave → fresh reviewer, steering each round per the escalation ladder, until a fresh reviewer reports no valid actionable findings. Running this loop is the orchestrator's primary job, not a preamble to doing the work itself.
5. After checks and review pass, create the commits at the ledger's per-slice boundaries. If a slice exhausts its implementer budget, split it or re-dispatch it with a sharper handoff; take over only per the escalation ladder.
6. When device E2E is likely, prewarm concurrently with implementation: stable services, a claimed and labeled device, a baseline native build (only when unaffected by active slices), the exact Metro URL, and login state. Record a resource manifest for the final verifier. Do not judge acceptance behavior while implementation is still changing.
7. After review passes, perform the final full-diff review yourself, push the reviewed head, create the PR, and assign it to the requesting human — before starting E2E, so CI and Kilobot run concurrently with the E2E run. Do not read or triage any review comment yet (step 9).
8. Dispatch a fresh final `mobile-e2e-verifier` with the resource manifest. Loop triage → repair wave → fresh reviewer → fresh verifier, steering each round per the escalation ladder, until a fresh verifier passes every applicable feature state. You may reproduce a failure once to triage it; the repair itself — with your diagnosis and acceptance criteria attached — goes through the implementer-reviewer loop. Never sit in an edit-run-verify loop yourself. Review the full diff of any E2E-driven repair, commit it at the right boundary, and push.

### Reviewer and CI Loop

Kilobot is the only reviewer whose review is waited for. Comments already posted by other reviewers — bots or humans — get the same triage, repair, reply, and resolve flow, but never wait for another reviewer to review or re-review.

9. Only after E2E completes, read and triage review comments; the PR opened at step 7 means Kilobot and CI results may already be waiting. Wait until Kilobot has reviewed the latest head. Kilobot can crash: if its review does not arrive in a reasonable time, retrigger it with an empty commit or a PR comment tagging it, then resume waiting. Fetch every unresolved review thread from every reviewer and triage each finding per the repository-root `AGENTS.md` review-remark workflow.
10. Valid finding: send the smallest coherent repair to `mobile-implementer`, run the required narrow checks, dispatch a fresh `mobile-reviewer`, commit, push, reply in the thread, and resolve it. Invalid finding: reply in the thread with technical evidence and do not change correct code. A fix without its in-thread reply and thread resolution is not done.
11. Repeat steps 9-10 until Kilobot has reviewed the latest head and no actionable posted comment from any reviewer is unresolved.
12. Rerun local mobile E2E after any review-driven repair that affects behavior, build or runtime configuration, or the E2E workflow. A documentation-only or test-only repair may skip it when you record why the verified behavior is unaffected.
13. When the base branch advances, integrate the current base in the dedicated worktree and push the new head. Then:
    - No conflicts, or conflicts resolved and certainly behavior-neutral: no reruns. CI and Kilobot run on the new SHA anyway.
    - Conflicts resolved with possible behavioral impact: rerun the affected checks and local E2E and get a fresh review before pushing.
14. Always wait for CI and Kilobot on the exact latest head SHA, and confirm GitHub reports it mergeable.

## GitHub Communication

Every GitHub issue comment, PR comment, review comment, review body, and thread reply written by this workflow must begin exactly with `(bot) `, including replies to Kilobot and rejections of findings. Only the PR title and PR description carry no prefix.

## Handoff Requirements

Every dispatch to a role agent must include:

- The assigned task, explicit non-goals, and observable acceptance criteria
- The feature-state matrix for any new user-facing feature: each state's trigger or classification, message intent, CTA label and outcome (or required absence), and coverage
- The dedicated worktree path for every repository in scope, including sibling repositories
- Existing uncommitted changes that must be preserved
- The exact checks or user flows expected for that stage
- Prior findings being addressed, including rejected findings that must not reopen without new evidence
- The intended commit boundary for the assigned slice
- Priority order, minimum complete outcome, optional work to drop, and a clean stopping rule before budget exhaustion
- Required continuation state on early stop: completed work, remaining work, failures, files touched, checks run or deferred, and safest next action
- The GitHub comment rule (see GitHub Communication)
- Secrets rule: role agents must not read `.env`, `.env.*`, `.dev.vars`, or equivalent files. Use documented setup commands, sanitized status output, and sanitized explicit values supplied by the orchestrator.
- Fixture rule: never commit generated E2E fixtures. Create them only in a temporary directory for the current run and clean them up before returning.

Never ask a role agent to infer context from a conversation it cannot see. Keep cross-repository changes on coordinated branches, and give reviewers and verifiers the location of every related diff. Never place secrets or raw environment-file contents in a handoff.

## Workflow Metrics

Record lightweight in-session measurements in the final report when applicable: wave count and width, budget exhaustions, ownership collisions, unmanaged listener detections, prewarm reuse or invalidation, simulator relabel or name-restoration failures, accepted-plan-to-final-E2E-start time, accepted-plan-to-merged-PR time, review/E2E/CI repair rounds, and orchestrator takeovers with a one-line justification each. Do not add persistent telemetry or a data store.

## Completion Gate

Declare the work complete only when every item holds:

- All accepted plan tasks are implemented
- Every applicable feature state has automated behavioral coverage, including CTA presence or complete absence
- Every safely reproducible feature state has passed E2E; an exception requires explicit user acceptance in hands-on mode and cannot be self-accepted in hands-off mode
- Changes are organized into small, internally coherent logical commits
- A fresh reviewer reports no valid actionable findings
- Final automated checks pass in every changed repository
- The orchestrator has reviewed the complete diff and performed all Git and PR actions itself
- The PR is assigned to the requesting human
- Kilobot has reviewed the latest head, no actionable posted comment from any reviewer is unresolved, and every addressed finding has an in-thread reply and a resolved thread
- GitHub reports the exact latest head as mergeable with no conflicts
- All expected CI checks on the latest head are in a successful terminal state; failed, cancelled, timed-out, action-required, or pending checks block completion
- No generated E2E fixture remains, tracked or untracked, in any repository
- Every verifier temporary edit is removed, and each repository's final Git state exactly matches its recorded pre-verification baseline
- Every backend service, simulator, or emulator this run started — including prewarmed and bug-reproduction resources — is shut down or released; resources the run did not start (such as the shared Metro dev runner) stay running
- The temporary handoff file is deleted
