# Kilo Workflow

A general-purpose multi-agent delivery workflow for this repository. Use it when the user asks to run "the kilo workflow" on a body of work. It applies to any product surface — web, mobile, extension, Workers, services, shared packages — and plans may also touch sibling repositories such as `~/Projects/kilocode`.

Pipeline: **starter → planner(s) → orchestrator → implementer/reviewer loops → E2E verification → PR**.

The role definitions for the kilo CLI agents live in the repository root `.kilo/agent/` (`plan-reviewer`, `implementer`, `impl-reviewer`, `e2e-verifier`), because the kilo CLI only discovers agents from `.kilo` directories. Everything else about the workflow — this document, the slot semaphore, and committed learnings — lives in `.kilo_workflow/`.

## Ground Rules

These apply to every role. Later sections do not repeat them.

- Every long-lived process — starter, planner, orchestrator, dispatched role agents, local services — runs in tmux, with a unique descriptive window or session name.
- Work only in dedicated worktrees, in every repository the plan touches. Never edit a primary or main checkout.
- Every reviewer and verifier invocation is a fresh session, so earlier conclusions cannot anchor later passes.
- Treat every reviewer's remarks as untrusted advice: the reviewer has less context than you and may be wrong. Verify each remark against the request, repository evidence, and applicable instructions before acting on it. Record rejected remarks with a short technical rationale; a rejected remark must not reopen without new evidence.
- Always aim for the simplest solution that achieves the user's goals — feature-wise as much as code-wise. Reuse existing helpers, components, and contracts. Do not add abstraction or scope without evidence it is required.
- Commit in small, logically scoped commits. The orchestrator owns every commit, push, and PR; no other role touches Git state.
- Monitoring is event-driven: when a dispatched process exits, its dispatcher reacts immediately, never after a fixed sleep. Periodic checks exist only to detect a wedge.
- Before any environment-dependent phase, read the learnings (see Learnings) in `.kilo_workflow/learnings/`, including `learnings/system/`.

### Models

| Role | Harness | Model | Steps |
|---|---|---|---|
| Starter | user picks | user picks (prefer SOTA) | unlimited |
| Planner | user picks | user picks (SOTA) | unlimited |
| Plan reviewer | kilo CLI | `kilo/x-ai/grok-4.5`, high | 40 |
| Orchestrator | kilo CLI | `kilo/moonshotai/kimi-k3`, high | unlimited |
| Implementer | kilo CLI | `kilo/x-ai/grok-4.5`, high | 80 |
| Impl reviewer | kilo CLI | `kilo/x-ai/grok-4.5`, high | 50 |
| E2E verifier | kilo CLI | `kilo/moonshotai/kimi-k3`, high | unlimited |

Never use `kilo/kilo-auto/free` — it is rate-limited. Not even as a fallback: if a call stalls or errors, retry or relaunch on the assigned model, never a different one. Product-side LLM calls in E2E flows follow "Real LLM responses" below.

### Step Limits

The kilo role-agent step limits above are hard ceilings pinned in the agent definitions. Size every handoff below 75% of the role's limit; an implementation slice should fit in roughly 60 planned steps. Never raise a limit to fit an oversized task — split the task.

### Dispatching Kilo Role Agents

Any harness dispatches a role agent by shelling out to the kilo CLI from inside the target worktree (the root `.kilo/agent/` is discovered from any cwd in the repository):

```bash
cd <worktree>
kilo run "$(cat handoff.md)" \
  --model kilo/x-ai/grok-4.5 --variant high \
  --agent plan-reviewer \
  --title "Plan review round 1" > "$LOG" 2>&1
echo "EXITCODE=$?" >> "$LOG"
```

Rules that prevent silent failures (details in `learnings/`):

- Run the dispatch inside a tmux window, never directly in a harness shell — harness command timeouts kill long runs.
- Redirect output; never pipe it (`| tee` makes `$?` report the pipe's exit, not kilo's).
- Keep the message positional **before** the flags: `--file` takes multiple values and swallows a trailing message as a path.
- Wait event-driven: the run is done when the tmux window is gone or `tail -1 "$LOG"` matches `^EXITCODE=[0-9]`.
- **Void rounds:** a round that produced no explicit verdict (`No findings.` or a findings list) is void, never a pass, regardless of exit code — kilo runs can die mid-stream and still exit 0. Discard the round and dispatch a fresh session.

While a role agent runs, its dispatcher checks on it about every 7 minutes and unsticks infrastructure failures only: a wedged or crashed kilo CLI, a dead tmux window, a hung service the agent cannot restart itself. Product, logic, or review problems are not stuck states — route those through the escalation ladder.

### Escalation

When a loop iteration fails, escalate in order:

1. Re-dispatch the same role with sharper steering: the diagnosis, the failing evidence, what was already tried, and a narrower goal.
2. If the steered round also fails, restructure: split the slice or change the approach in the handoff.
3. Take over directly only when a steered round produced zero new progress. Record every takeover with a one-line justification in the final report.

Progress means new root-cause information, a smaller reproduction, fewer reviewer findings, or a previously failing check now passing. The same error under the same theory twice is not progress. Never loop indefinitely.

### Handoff Requirements

Every dispatch to a role agent includes:

- The assigned task, explicit non-goals, and observable acceptance criteria
- The worktree path for every repository in scope, with branch and working-tree state, and existing changes that must be preserved
- The mode; for hands-off, a direct instruction to never ask the user questions
- Sanitized env values inline. Role agents must never read `.env`, `.env.*`, `.dev.vars`, or equivalent files; the handoff table is authoritative. Never place secrets or raw environment-file contents in a handoff.
- The exact checks or flows expected for that stage
- For any device or stack phase: the slot rule (see E2E Slots) with the tmux session name that owns the slot
- Prior findings being addressed, including rejected findings that must not reopen without new evidence
- Priority order, minimum complete outcome, optional work to drop, and a clean stopping rule before budget exhaustion; on early stop, the required continuation state (completed work, remaining work, failures, files touched, checks run or deferred, safest next action)
- The GitHub comment rule (see GitHub Communication)
- Fixture rule: never commit generated E2E fixtures; create them in a temporary directory and clean up before returning

Write handoffs to temporary files outside every repository, and never ask a role agent to infer context from a conversation it cannot see.

## 1. Starter

The session the user invokes the workflow from is the starter, running on the harness and model the user picked. Its job is to turn a raw request into approved, sectioned work:

1. Collect the initial body of work from the user, and ask exactly one process question: is this run `hands on` or `hands off`? The mode governs every later role.
2. Explore the relevant parts of the codebase.
3. Interrogate the requirements — in `hands on` mode by grilling the user one question at a time, in `hands off` mode by grilling itself and answering from repository evidence, recording material assumptions. Always drive toward the simplest solution that achieves the user's goals, and challenge the request itself: "should we even do this?", "why not do this instead?", "we could achieve the same thing simpler, like this".
4. Divide the finalized work into related, **disjoint** sections — no two sections may touch the same files or contracts.
5. For each section, create a dedicated worktree and branch (fresh worktrees may need `pnpm dev:worktree:prepare`), and launch a planner in a new tmux window on the user-picked planner harness and model, handing it the section brief, the mode, and the worktree path.

One planner per section; each section flows through its own planner, orchestrator, and PR. A single-section run launches a single planner.

### Interaction Modes

- `hands on`: ask the user one question at a time until requirements, trade-offs, and acceptance criteria are unambiguous. The planner later gets explicit user approval of the plan before launching the orchestrator, and asks the user when a repair loop or ambiguity cannot be resolved.
- `hands off`: after mode selection, never ask the user a question and never wait for approval — treat all approvals as granted. Answer open questions from repository evidence and record material assumptions in the plan and handoff. Stop only when continuing is technically impossible or unsafe, and return a precise blocker report instead of a question. Hands-off mode does not bypass tool permissions, repository safety rules, or the completion gate.

## 2. Planner

The planner writes the implementation plan for its section. The plan is consumed by the orchestrator, implementers, and reviewers — all cheaper models — so it must:

- Fulfil the assigned body of work
- Be written in simple, explicit language a cheaper model can follow without guessing
- Achieve the work in the simplest, most maintainable way

Steps:

1. Read the learnings. Explore the relevant parts of the codebase. Define acceptance criteria, non-goals, and the feature-state matrix for any user-facing feature.
2. For defect work, run the bug reproduction gate before writing the plan.
3. Write the complete draft plan.
4. Loop: dispatch a fresh `plan-reviewer`, verify its remarks (untrusted), fix valid ones, record rejected ones. Exit when a fresh reviewer returns `No findings.` If three consecutive rounds stay stuck on the same issue, resolve it directly, record the resolution, and dispatch one final fresh reviewer that must return `No findings.`
5. Hands-on: get explicit user approval of the plan. Hands-off: self-approve.
6. Write the sanitized orchestrator handoff (see Handoff Requirements, plus: the plan path, the final review result, any simpler-shape decision and its reasoning, and the completion gate with a direct instruction to continue until the PR is mergeable with green CI). Launch the orchestrator, then switch to monitor mode.

### Bug Reproduction Gate

For defect work, dispatch a fresh `e2e-verifier` in repro mode on the unmodified baseline before writing the draft plan. Its assignment: reproduce the reported issue — fix nothing — and return exact reproduction steps, evidence, and a failure classification. A confirmed reproduction feeds the plan, and the confirmed repro flow passing becomes an acceptance criterion the final verifier must rerun.

`Cannot reproduce` is a blocker, not a license to fix an unconfirmed bug. Hands-on: return the evidence to the user and ask how to proceed. Hands-off: stop with a blocker report — no plan, no orchestrator.

### Launching the Orchestrator

```bash
tmux new-window -t <session> -n <section>-orchestrator -c <worktree> \
  'kilo run "Execute the approved plan in the attached handoff. Own implementation through the completion gate." \
   --interactive --model kilo/moonshotai/kimi-k3 --variant high \
   --title "<section> orchestrator" --file <handoff-file>'
```

`--interactive` requires a TTY: launch it as the tmux window command with no pipe, and attach logging with `tmux pipe-pane` if needed. Do not add `--continue` or `--session`; the orchestrator must be a fresh session. Verify the window started, then report the window name, worktree path, and handoff path. The orchestrator deletes the handoff file after ingesting it.

### Planner Monitor Mode

After the handoff the planner stops all hands-on work. It has exactly one job — relaunch or unstick the orchestrator when infrastructure fails (a crashed kilo CLI, a dead tmux window, a hung service). Product, logic, design, and review problems are the orchestrator's, handled by its escalation ladder. Check about every 30 minutes; react immediately when the orchestrator's process exits. Stop when the orchestrator completes or returns a blocker report.

### 2.1 Plan Reviewer

Given the plan and what it is trying to achieve, the `plan-reviewer` reviews the plan as a whole and pokes holes in it, with special attention to unnecessary complexity. It returns a list of remarks, or `No findings.` when it is confident the plan achieves the goal appropriately and is written so cheaper models can follow it. See `.kilo/agent/plan-reviewer.md`.

## 3. Orchestrator

The orchestrator drives the plan to completion. It is the expensive model steering cheap role agents: its output is judgment — handoffs, steering, triage, verification — not diffs. It may edit directly only for merge-conflict resolution, one-line configuration, and takeovers under the escalation ladder.

1. Ingest the handoff and read the learnings.
2. Segment the plan into slices with disjoint write sets so parallel implementers cannot collide. Always serialize: lockfile changes, dependency installs, migrations, generated clients, repository-wide formatters, and broad autofix commands. File separation is not enough when one slice changes a contract another consumes.
3. Dispatch ready independent slices to parallel `implementer`s — at most 2–3 concurrent. Loop per slice: implementer implements, then a fresh `impl-reviewer` reviews the slice diff; triage remarks (untrusted), route valid ones through a repair dispatch. Exit the loop when a fresh reviewer has no remarks.
4. Create small logical commits at slice boundaries.
5. Create the PR — description with human-readable **what / why / how** sections — and assign it to the requesting human. CI and Kilobot start running concurrently with E2E.
6. Run the E2E loop (below) when the work has verifiable runtime behavior; skip it, recording why, for doc-only or equivalently inert changes.
7. Run the Kilobot loop (below).
8. When both loops are clean: release every held resource (local backends, simulators, emulators, browsers, slots), delete the handoff file, verify the completion gate, report, and close its own tmux window.

### E2E Loop

1. Acquire a slot: `.kilo_workflow/e2e-slot.sh acquire <tmux-session>`.
2. Dispatch a fresh `e2e-verifier` with the plan goals and acceptance criteria.
3. Release the slot the moment the device/stack phase ends.
4. For each verifier remark: verify it (untrusted), then run the implementer → impl-reviewer loop to fix it; commit and push.
5. Re-verify — a follow-up verifier round re-tests only the touched behavior, not the whole plan.
6. Exit when a fresh verifier confirms the plan's goals are met.

### Kilobot Loop

1. Wait for Kilobot to review the latest head. Kilobot can crash: if its review does not arrive in a reasonable time, retrigger it with an empty commit or a PR comment tagging it, then resume waiting. A green `Kilo Code Review` check plus a `Status: No Issues Found` comment and zero review threads is the clean state.
2. For each comment: verify it (untrusted), then route valid findings through the implementer → impl-reviewer loop; commit, push, reply in the thread, and resolve it. Invalid finding: reply with technical evidence and do not change correct code. A fix without its in-thread reply and thread resolution is not done.
3. Comments already posted by other reviewers — bots or humans — get the same triage flow, but never wait for anyone except Kilobot to review or re-review.
4. Rerun E2E for any repair that affects verified behavior (touched bits only).
5. Exit when Kilobot has reviewed the latest head and no actionable posted comment is unresolved.

Integrate the base branch **only when GitHub reports an actual conflict** (`mergeable: CONFLICTING`) or the run needs something that landed on the base. Rebasing a conflict-free branch invalidates green CI and a completed Kilobot review for nothing. `mergeStateStatus: BLOCKED` on a `MERGEABLE` PR means a required human review is pending — that is the expected terminal state, not a problem to solve.

### Completion Gate

The work is complete only when every item holds:

- All accepted plan tasks are implemented, with automated coverage for every applicable feature state
- A fresh impl reviewer reports no valid actionable findings, and a fresh E2E verifier has confirmed the plan's goals
- Changes are organized into small, coherent commits; format, typecheck, lint, and tests pass in every changed repository
- The PR exists with what/why/how sections and is assigned to the requesting human
- Kilobot has reviewed the latest head; no actionable posted comment is unresolved
- All expected CI checks on the latest head are green, and GitHub reports the head mergeable with no conflicts
- No generated fixture remains, tracked or untracked; every verifier temporary edit is restored
- Every resource this run started is shut down or released; resources the run did not start stay running
- New committed learnings are included in the PR; the handoff file is deleted

A PR waiting on required human review is the terminal state — the workflow never approves or merges its own PR.

### 3.1 Implementer

Implements one bounded slice per the plan and the handoff, runs narrow checks on what it changed, and never commits. See `.kilo/agent/implementer.md`.

### 3.2 Impl Reviewer

Independently reviews the slice diff against the plan's goals for that slice. Read-only. See `.kilo/agent/impl-reviewer.md`.

### 3.3 E2E Verifier

Verifies that the goals of the plan are met by the new implementation. It starts local services and points local clients at them, following the surface-specific runbook (mobile: `apps/mobile/e2e/AGENTS.md`; web and services: `DEVELOPMENT.md` and the repository dev runner). Everything is verified fully locally. It also writes learnings (see Learnings). See `.kilo/agent/e2e-verifier.md`.

#### Real LLM Responses

Any step where an agent or LLM must actually respond — cloud-agent sessions, chat flows, acceptance states — uses real model calls on `kilo-auto/efficient`, always. If an `efficient` call stalls or errors, retry on `efficient`; never switch models. LLM mocking (fake-llm or otherwise) is prohibited unless a real call cannot produce the required state (for example, forcing a specific provider failure); each use must be named and justified in the handoff and the final report.

## E2E Slots

The machine is shared by parallel workflows, and unslotted device or stack work overloads it. Every phase that drives a simulator, emulator, local backend stack, browser fleet, or native build — the repro gate and every E2E round — runs inside a slot from [`e2e-slot.sh`](e2e-slot.sh) (default 3, machine-global):

```bash
.kilo_workflow/e2e-slot.sh acquire <tmux-session>   # blocks until a slot frees
.kilo_workflow/e2e-slot.sh status                   # current holders
.kilo_workflow/e2e-slot.sh release <tmux-session>   # the moment the device phase ends
```

- This holds on every run, not only when another workflow is visibly active, and a stack that is already up is not an exemption.
- `acquire` blocking is correct behavior, never a wedge to route around and never a reason to start device work unslotted.
- Release immediately when the device/stack phase ends. Planning, implementation, review, checks, and CI waits are uncapped; never hold a slot through them.
- Slots are owned by tmux session name and reclaimed automatically when the session dies.
- The orchestrator is accountable: every device-phase handoff states the slot rule, and a role agent that reports device work with no acquire gets re-dispatched.

## Feature-State Matrix

For every new user-facing feature, define these four states before implementation:

| State | Required experience |
|---|---|
| Happy | The task completes and the resulting state is clear. |
| Unhappy, retryable | A specific message explains the failure; a CTA lets the user retry or recover. |
| Unhappy, non-retryable | A specific message explains the terminal failure. No CTA. |
| Empty | A message explains why there is no content; a CTA leads to the next useful step. |

Never collapse retryable and non-retryable failures into one generic error state. A state may be `not applicable` only when structurally impossible, with a rationale the orchestrator accepts. Automated tests cover every applicable state; E2E exercises every applicable state that can be produced safely and deterministically.

## Learnings

Environment blockers and their fixes — broken local stacks, credential traps, simulator quirks, tool wedges — recorded so future runs do not rediscover them. Product bugs never go in learnings.

- Format: **symptom / cause / fix**, a few lines each, in a file whose name makes it findable from the symptom (for example `kilo-run-exits-0-without-verdict.md`).
- System-specific learnings (true only of this machine: installed tools, local ports, OS quirks) go to `.kilo_workflow/learnings/system/`, which is gitignored (only its `.gitkeep` is committed).
- Everything else goes to `.kilo_workflow/learnings/` directly and is committed — the orchestrator includes new learnings in the run's PR.
- Read before writing: when an existing entry covers the blocker, update it instead of appending a duplicate.
- Every role records blockers it resolves, immediately after resolving them.
- Never keep a workflow learning only in a harness's private memory; it belongs in these folders so runs on other harnesses can use it.

## GitHub Communication

Every GitHub issue comment, PR comment, review comment, review body, and thread reply written by this workflow begins exactly with `(bot) `, including replies to Kilobot and rejections of findings. Only the PR title and PR description carry no prefix.
