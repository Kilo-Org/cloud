# Mobile Agent Workflow

Use this workflow when the product surface of the work is the mobile app. Start Kilo from `apps/mobile/` so the role agents in `.kilo/agent/` are discovered. The accepted plan may still change cloud services, tRPC routers, shared packages, infrastructure, or a sibling checkout such as `~/Projects/kilocode`: "mobile" describes the product, not a directory boundary.

## Ground Rules

These rules apply to every session and role. Later sections do not repeat them.

- Work only in dedicated worktrees, in every repository the plan touches. Never edit the primary or main checkout of any repository.
- The first session is the planner. After plan approval, a fresh session becomes the orchestrator.
- Model policy: every kilo CLI — all role agents and any other kilo invocation — always runs on `kilo/kilo-auto/efficient`. The only exceptions are the planner (model chosen by the user) and the orchestrator (model chosen by the user; default `kilo/anthropic/claude-opus-4.8` at high reasoning). `kilo/kilo-auto/free` is rate-limited and must never be used, including as a fallback: if an `efficient` call stalls or errors, retry or relaunch on `efficient` — never switch to `free`.
- Role agents always run inside the Kilo CLI. The four role agents under `apps/mobile/.kilo/agent/` (`mobile-plan-reviewer`, `mobile-implementer`, `mobile-reviewer`, `mobile-e2e-verifier`) are configured with `mode: all`, making them available as both primary and subagents. They can be invoked directly via `kilo run --agent <agent-name>` even when the orchestrating agent is not itself running in a Kilo CLI harness.

  Example command a non-kilo harness would run to dispatch a role agent:
  ```bash
  cd /path/to/mobile/worktree
  kilo run \
    --model kilo/kilo-auto/efficient \
    --agent mobile-plan-reviewer \
    --title "Plan review via role agent" \
    "Please review the attached plan."
  ```
  The `kilo run` invocation must originate from the mobile worktree directory (where `.kilo/agent/` is visible) so Kilo can discover the agent definition.
- The orchestrator owns product judgment, architecture decisions, loop control, final verification, Git, and the PR. Role agents never dispatch other agents, commit, push, or create or update a PR.
- Every reviewer and verifier invocation must be a fresh session so earlier conclusions cannot anchor later passes.
- Choose the simplest maintainable implementation that fully satisfies the accepted requirements. Reuse existing code and contracts. Do not add abstraction or scope without evidence that it is required.
- Make small, logically scoped commits throughout. Never squash the work into one catch-all commit unless the user explicitly requests it.
- Delegation discipline: the orchestrator is the expensive model driving cheap role agents. Its output is judgment — handoffs, steering, triage, and verification — not diffs. When the orchestrator diagnoses a problem, the diagnosis goes into a role handoff with acceptance criteria; the orchestrator does not implement the fix itself, even when it already knows it. Direct orchestrator edits are limited to trivial glue: merge-conflict resolution, one-line configuration, and the final narrowly scoped repair in the last orchestration step. Anything behavioral routes through an implementer and a fresh reviewer.
- Escalation ladder, not takeover-by-count. When a loop iteration fails: first re-dispatch the same role with sharper steering — the diagnosis, the failing evidence, what was already tried, and a narrower goal. If the steered round also fails, restructure the work: split the slice or change the approach in the handoff. Take over directly only when a steered round produced zero new progress, and record every takeover with a one-line justification in the final report. Progress means new root-cause information, a smaller reproduction, fewer reviewer findings, or a previously failing check now passing; the same error under the same theory twice is not progress. Never loop indefinitely: a steered round with zero new progress is the floor at which takeover is required.
- Real LLM responses: any step where an agent or LLM must respond — cloud-agent sessions, chat flows, E2E acceptance states — uses real model calls on `kilo-auto/efficient`, always (never `kilo-auto/free`, which is rate-limited; if an `efficient` call stalls or errors, retry or relaunch on `efficient`, do not switch models). The fake-llm server and every other form of LLM mocking are prohibited unless a real call cannot produce the required state (for example, forcing a specific provider failure); each use must name the mock and carry a written justification in the handoff and the final report.
- Step limits are hard ceilings: `mobile-plan-reviewer` 40, `mobile-implementer` 80, `mobile-reviewer` 50, `mobile-e2e-verifier` 100. Size every handoff below 75% of the role's limit; an implementation slice should fit in roughly 60 planned steps. Never raise a limit to fit an oversized task; split the task instead.

## Interaction Modes

The planner's first message must ask the user one question: is this run `hands on` or `hands off`? The selected mode governs the planner, the orchestrator, and every later decision.

- `hands on`: ask the user one question at a time until requirements, trade-offs, acceptance criteria, and the plan are unambiguous. Obtain explicit user approval of the plan before launching the orchestrator. Ask the user when a repair loop or ambiguity cannot be resolved.
- `hands off`: after mode selection, never ask the user a question and never wait for user approval. Treat all approvals as granted. Interrogate the plan yourself to expose missing requirements, trade-offs, risks, and acceptance criteria. Answer open questions from repository evidence and best judgment, and record material assumptions in the plan and handoff. Continue through planning, implementation, review, E2E, PR creation and repair, Kilobot review, conflict resolution, and green CI. Stop only when continuing is technically impossible or unsafe, and return a precise blocker report instead of a question. A blocked E2E criterion is a blocker, not something to self-accept.

Planner lifecycle: regardless of the selected mode, the planner is hands-on through planning and must resolve every unknown before handoff — in hands-on mode with the user, in hands-off mode from repository evidence with recorded assumptions. After launching the orchestrator it switches to monitor mode (see Planner Monitor Mode) and does not resume hands-on work.

Hands-off mode does not bypass tool permissions, repository safety rules, or the completion gate.

## Feature State Matrix

Every new user-facing feature must define these four states before implementation begins:

| State | Required experience |
|---|---|
| Happy | The intended task completes and the resulting state is clear. |
| Unhappy, retryable | A specific message explains the failure and an actionable CTA lets the user retry or recover. |
| Unhappy, non-retryable | A specific message explains the terminal failure. No CTA. |
| Empty | A message explains why there is no content and a CTA leads to the next useful step. |

Rules:

- Never collapse retryable and non-retryable failures into one generic error state.
- For each state, the plan defines: the trigger or classification rule, the message intent, the CTA label and outcome (or its required absence), and the automated and E2E coverage.
- A state may be `not applicable` only when it is structurally impossible for the feature, with a concrete rationale accepted by the orchestrator. Inconvenient or hard-to-set-up is not `not applicable`.
- Automated tests must cover every applicable state's selection logic and CTA presence or absence.
- E2E must exercise every applicable state that can be produced safely and deterministically, and must explicitly report any state it could not reproduce.

## Planning

1. Explore requirements in the selected mode. Inspect the affected repositories. Define acceptance criteria, the feature-state matrix, and non-goals.
2. Create the dedicated worktrees.
3. For defect work, run the bug reproduction gate below before writing the plan.
4. Write the complete draft plan.
5. Run the plan review gate below.
6. In hands-on mode, obtain explicit user approval. In hands-off mode, self-approve.

### Bug Reproduction Gate

When the work fixes a reported defect, dispatch a fresh `mobile-e2e-verifier` in repro mode on the unmodified baseline in the dedicated worktree before writing the draft plan. Its assignment is to reproduce the reported issue — not to fix anything — and return exact reproduction steps, evidence, and a failure classification. It claims iOS with `--phase prewarm`; the claimed device and warmed services carry into the planner handoff as existing resources to preserve, and the final verifier later reclaims the same device with `--phase verify`.

A confirmed reproduction feeds the plan: the reproduction steps and failure classification inform the root-cause hypothesis, and the confirmed repro flow passing becomes an acceptance criterion the final verifier must rerun.

`Cannot reproduce` is a blocker, not a license to fix an unconfirmed bug. In hands-on mode, return the repro attempt evidence to the user and ask how to proceed. In hands-off mode, stop with a blocker report containing that evidence: no plan, no orchestrator.

### Plan Review Gate

After the draft plan is complete and before approval, dispatch a fresh `mobile-plan-reviewer`. It reports unclear requirements, unsupported assumptions, missing or conflicting acceptance criteria, incomplete ownership or cross-repository boundaries, infeasible sequencing, and underspecified verification or E2E coverage.

The reviewer has less context than the planner and may be wrong. Treat every finding as untrusted advice: verify each claim independently against the request, repository evidence, and applicable instructions. Fix only valid findings. Record rejected findings with a short technical rationale; a rejected finding must not reopen without new evidence. Never weaken or expand the plan merely to satisfy the reviewer.

After fixing valid findings, dispatch another fresh reviewer. Repeat until a fresh reviewer returns `No findings.` If three consecutive rounds stay stuck on the same issue, the planner resolves it directly, records the resolution, and dispatches one final fresh reviewer that must return `No findings.` This count-based floor is a deadlock-breaker for plan-text disagreement between planner and reviewer — the planner edits its own plan here, so nothing is being taken over. Delegated implementation work follows the escalation ladder in Ground Rules instead.

### Planner Handoff

After approval the planner must not implement anything. It writes a sanitized handoff file and launches a fresh orchestrator.

The handoff must contain:

- The selected mode, and for hands-off a direct instruction to never ask the user questions or wait for approval
- The final plan-review result and rationales for rejected findings
- The absolute path of the accepted plan and any approved design
- The dedicated worktree path for every repository in scope, with each worktree's current branch, commit, and working-tree state
- Acceptance criteria, feature-state matrix, execution ledger, non-goals, and unresolved risks
- For defect work: the reported defect, the confirmed reproduction steps and failure classification from the bug reproduction gate, and the repro run's resource manifest
- Existing changes and resources that must be preserved
- The completion gate: review, E2E, Git, PR, Kilobot, mergeability, and CI requirements, with a direct instruction to continue until the PR is mergeable and conflict-free with all expected CI checks green on the latest head
- The GitHub comment rule (see GitHub Communication)

Write the handoff to a temporary file outside every repository. It must contain only sanitized explicit values: never secrets, raw environment-file contents, or an attached `.env`, `.env.*`, `.dev.vars`, or equivalent file.

Launch the orchestrator in the current tmux session with a unique, descriptive window name:

```bash
tmux new-window -t <planner-tmux-session> \
  -n <feature>-orchestrator \
  -c <dedicated-worktree>/apps/mobile \
  'kilo run "Execute the approved mobile plan in the attached handoff. Own implementation through the completion gate." --interactive --model kilo/anthropic/claude-opus-4.8 --variant high --title "<feature> orchestrator" --file <sanitized-handoff-file>'
```

Use `kilo run --interactive` exactly as shown, with the message positional before the flags: `--file` accepts multiple values and consumes a trailing message as a file path, which fails with `File not found`. Do not add `--continue` or `--session`, because the orchestrator must be a fresh session on Claude Opus 4.8 at high reasoning effort. Verify the tmux window started, then report the window name, worktree paths, model, and handoff path to the user. The orchestrator deletes the handoff file after ingesting it.

### Planner Monitor Mode

After the handoff the planner stops all hands-on work — no planning, implementation, or product judgment — and switches to monitor mode. Everything the orchestrator does runs in the shared tmux session, so the planner inspects its windows and service logs directly.

Monitor mode has exactly one job: unblock the orchestrator when it is stuck on an environment failure, never on a problem it is supposed to solve itself.

- Unblock: a wedged or crashed kilo CLI, a dead orchestrator tmux window, a hung service or simulator the orchestrator cannot restart — infrastructure it cannot recover on its own.
- Do not intervene: the orchestrator struggling with a product, logic, design, or review problem. That work is the orchestrator's, handled by its escalation ladder; solving it here defeats the fresh-session and delegation discipline.

Run one check on a roughly 30-minute interval to preserve context, and stay idle between checks. Stop monitoring when the orchestrator reaches the completion gate or returns a blocker report.

## Roles

| Agent | Responsibility | Repository edits |
|---|---|---|
| `mobile-plan-reviewer` | Reviews a complete draft plan for ambiguity, unsupported claims, and missing execution detail | Denied |
| `mobile-implementer` | Implements one bounded task from the accepted plan and runs narrow checks | Allowed where the task requires |
| `mobile-reviewer` | Independently reviews the full relevant diff and tests | Denied |
| `mobile-e2e-verifier` | Exercises accepted behavior; in repro mode, reproduces a reported defect on the unmodified baseline before planning; may create temporary state-generation fixtures | Temporary only |

## Local Tooling

Agents start and inspect the local stack, simulator, login, and E2E flows through [e2e/AGENTS.md](../e2e/AGENTS.md); do not ask the user to start Metro or backend services. Two helpers cover most runs:

- Seed data: `pnpm dev:seed` with no arguments lists every topic and its usage. Use it to resolve or create users, grant credits, and mint tokens (`app:user-id`, `app:create-user`, `app:add-credits`, `app:api-token`) instead of hand-writing SQL or JWTs.
- Remote CLI sessions: the orchestrator runs `apps/mobile/e2e/remote-cli.sh start [email]` to launch a local kilo CLI as a remote session for this worktree, targeting the local stack, when testing session discovery, mirroring, or mobile-to-CLI messaging. It resolves ports, mints the token, installs the CLI, and starts a `kilo-e2e-cli-<worktree-slug>` tmux session. Use `remote-cli.sh exec <kilo args...>` to run any one-off CLI command (`remote`, `session list`, `run`, ...) against the same prepared stack. Role agents reuse that prepared session and never mint tokens or install the CLI themselves.

Env sync between the app bundle, Metro, and this worktree is already validated by `apps/mobile/e2e/preflight.sh` (invoked by `login.sh`); trust its failure output instead of re-checking URLs by hand.

## Execution Ledger

Split the accepted plan into the smallest behaviorally meaningful, independently testable slices. Before dispatching anything, record each slice in a ledger:

- Slice ID, dependencies, priority, and estimated step cost
- Exact writable path set and forbidden path set in every repository
- Shared generated outputs and mutable runtime resources
- Producer-consumer dependencies on contracts, schemas, generated code, or runtime state
- Ownership-safe narrow checks, and checks deferred to the synchronization barrier
- Intended commit boundary

Two slices are parallel-safe only when all of these hold: their write sets do not overlap, neither consumes an unstable output of the other, they share no mutable runtime resource, and neither runs a repository-wide mutating command. File separation is not enough when one slice changes a contract the other consumes. Always serialize: lockfile changes, dependency installation, migrations, generated clients, repository-wide formatters, and broad autofix commands.

## Orchestration

1. Ingest the handoff. Split work into ledger slices.
2. Dispatch ready independent slices in a bounded wave of at most two or three concurrent `mobile-implementer`s. Each handoff lists the other active slices and their ownership boundaries. While a wave is active, run only ownership-safe narrow checks.
3. When every implementer in the wave has returned, treat it as a synchronization barrier: inspect each result, ownership adherence, and the combined diff; resolve integration and architecture decisions yourself; run shared mutating commands and shared checks once. If one slice failed, preserve the successful ones.
4. Dispatch one fresh `mobile-reviewer` over the coherent wave diff. Triage findings yourself: route valid findings through a bounded repair wave and then a fresh reviewer; record rejected findings with a short rationale. This is a loop: repeat repair wave → fresh reviewer, steering each round per the escalation ladder, until a fresh reviewer reports no valid actionable findings. Running this loop is the orchestrator's primary job, not a preamble to doing the work itself.
5. After checks and review pass, create the commits at the ledger's intended per-slice boundaries. If a slice exhausts its implementer budget, split it or re-dispatch it with a sharper handoff; take it over yourself only per the escalation ladder.
6. When device E2E is likely, prewarm infrastructure concurrently with implementation: stable services, a claimed and labeled device, a baseline native build (only when unaffected by active slices), the exact Metro URL, and login state. Do not judge acceptance behavior while implementation is still changing. Record a resource manifest for the final verifier.
7. After the implementation passes review, perform the final full-diff review yourself, then push the reviewed head, create the PR, and assign it to the requesting human — before starting E2E. Opening the PR now lets CI and Kilobot review concurrently with the E2E run instead of after it. Do not read or triage any review comment yet (see step 9).
8. Dispatch a fresh final `mobile-e2e-verifier` with the resource manifest. Route product failures through a bounded repair wave and fresh reviewer, then another fresh final verifier. This is a loop: repeat triage → repair wave → fresh reviewer → fresh verifier, steering each round per the escalation ladder, until a fresh verifier passes every applicable feature state. The orchestrator may reproduce a failure once to triage it; the repair itself, with the orchestrator's diagnosis and acceptance criteria attached, goes through the implementer-reviewer loop. The orchestrator never sits in an edit-run-verify loop itself. Perform a final full-diff review of any E2E-driven repair, commit it at the right boundary, and push — updating the PR and re-triggering CI and Kilobot.

### Reviewer and CI Loop

Kilobot is the only reviewer whose review is waited for. Comments that other reviewers — bots or humans — have already posted get exactly the same triage, repair, reply, and resolve flow, but never wait for another reviewer to review or re-review.

9. Only now, after E2E has completed, begin reading and triaging review comments; the PR opened at step 7 means Kilobot and CI results may already be waiting. Wait until Kilobot has reviewed the latest head; do not wait for any other reviewer. Kilobot can crash: if its review or check does not arrive in a reasonable time, retrigger it by pushing an empty commit or by tagging it in a PR comment asking for a re-review, then resume waiting. Then fetch every unresolved review thread from every reviewer, including comments that arrived after earlier repairs, and triage each finding using the repository-root `AGENTS.md` review-remark workflow.
10. For each valid finding: send the smallest coherent repair to `mobile-implementer`, run the required narrow checks, dispatch a fresh `mobile-reviewer`, commit, push, reply in the thread, and resolve it. For each invalid finding: reply in the thread with technical evidence and do not change correct code. A fix without its in-thread reply and thread resolution is not done.
11. Repeat steps 9-10 until Kilobot has reviewed the latest head and no actionable comment already posted by any reviewer is unresolved.
12. Rerun local mobile E2E after any review-driven repair that affects behavior, build or runtime configuration, or the E2E workflow. A documentation-only or test-only repair may skip it when you record why the verified behavior is unaffected.
13. When the base branch advances, integrate the current base in the dedicated worktree and push the new head. Then apply exactly one of:
    - No conflicts: do not rerun checks, E2E, or review. The merged tree matches the verified head, and CI and Kilobot run on the new SHA anyway.
    - Conflicts resolved, certainly behavior-neutral: same as above, no reruns.
    - Conflicts resolved, behavioral impact possible: rerun the affected checks and local E2E and obtain a fresh review before pushing.
14. Always wait for CI and Kilobot on the exact latest head SHA, and confirm GitHub reports it mergeable.

## GitHub Communication

Every GitHub issue comment, PR comment, review comment, review body, and thread reply written by this workflow must begin exactly with `(bot) `. This includes replies to Kilobot and rejections of findings. Exceptions: the PR description and the PR title carry no prefix.

## Handoff Requirements

Every dispatch to a role agent must include:

- The assigned task, explicit non-goals, and observable acceptance criteria
- The feature-state matrix for any new user-facing feature: each state's trigger or classification, message intent, CTA label and outcome or required absence, and coverage
- The dedicated worktree path for every repository in scope, including sibling repositories
- Existing uncommitted changes that must be preserved
- The exact checks or user flows expected for that stage
- Prior findings being addressed, including rejected findings that must not be reopened without new evidence
- The intended commit boundary for the assigned slice
- Priority order, minimum complete outcome, optional work to drop, and a clean stopping rule before budget exhaustion
- Required continuation state on early stop: completed work, remaining work, failures, files touched, checks run or deferred, and safest next action
- The GitHub comment rule (see GitHub Communication)
- Secrets rule: role agents must not read `.env`, `.env.*`, `.dev.vars`, or equivalent files. Use documented setup commands, sanitized status output, and sanitized explicit values supplied by the orchestrator.
- Fixture rule: generated E2E fixtures must never be committed. Create them only in a temporary directory for the current run and clean them up before returning.

Never ask a role agent to infer context from a conversation it cannot see. Keep cross-repository changes on coordinated branches, and give reviewers and verifiers the location of every related diff. Never place secrets or raw environment-file contents in a handoff.

## Workflow Metrics

Record lightweight in-session measurements in the final report when applicable: wave count and width, budget exhaustions, ownership collisions, unmanaged listener detections, prewarm reuse or invalidation, simulator relabel or name-restoration failures, accepted-plan-to-final-E2E-start time, accepted-plan-to-merged-PR time, review/E2E/CI repair rounds, and orchestrator takeovers with a one-line justification each. Do not add persistent telemetry or a data store for these.

## Completion Gate

The orchestrator may declare the work complete only when every item holds:

- All accepted plan tasks are implemented
- Every applicable feature state has automated behavioral coverage, including CTA presence or complete absence
- Every safely reproducible feature state has passed E2E verification; an exception requires explicit user acceptance in hands-on mode, and cannot be self-accepted in hands-off mode
- Changes are organized into small, internally coherent logical commits
- A fresh reviewer reports no valid actionable findings
- Final automated checks pass in every changed repository
- The orchestrator has reviewed the complete diff and performed all Git and PR actions itself
- The PR is assigned to the requesting human
- Kilobot has reviewed the latest head — Kilobot is the only reviewer waited for — no actionable comment already posted by any reviewer is unresolved, and every addressed finding has an in-thread reply and a resolved thread
- GitHub reports the exact latest head as mergeable with no conflicts
- All expected CI checks on the latest head are in a successful terminal state; failed, cancelled, timed-out, action-required, or pending checks block completion
- No generated E2E fixture remains tracked or untracked in any repository
- Every verifier temporary edit is removed, and each repository's final Git state exactly matches its recorded pre-verification baseline
- Every backend service, simulator, or emulator this run started — including prewarmed and bug-reproduction resources — is shut down or released; resources the run did not start (such as the shared Metro dev runner) are left running
- The temporary handoff file is deleted
