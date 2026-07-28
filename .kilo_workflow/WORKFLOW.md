# Kilo Workflow

A general-purpose multi-agent delivery workflow for this repository. Use it when the user asks to run "the kilo workflow" on a body of work. It applies to any product surface — web, mobile, extension, Workers, services, shared packages — and plans may also touch sibling repositories such as `~/Projects/kilocode`.

Pipeline: **starter → planner(s) → orchestrator → implementer/reviewer loops → E2E verification → PR**.

The role definitions for the kilo CLI agents live in the repository root `.kilo/agent/` (`plan-reviewer`, `implementer`, `impl-reviewer`, `e2e-verifier`), because the kilo CLI only discovers agents from `.kilo` directories. Everything else about the workflow — this document, the slot semaphore, and committed learnings — lives in `.kilo_workflow/`.

## Ground Rules

These apply to every role. Later sections do not repeat them.

- Every long-lived process — starter, planner, orchestrator, dispatched role agents, local services — runs in tmux, with a unique descriptive window or session name.
- Section names carry a short run id (for example `billing-a7f3`) so parallel runs never collide on worktrees, branches, tmux names, or scratch paths.
- Work only in dedicated worktrees, in every repository the plan touches. Never edit a primary or main checkout. Create worktrees under `~/Projects/.worktrees/`: `git worktree add ~/Projects/.worktrees/<section> -b <section> origin/main`, then run `pnpm dev:worktree:prepare` inside it (cloud repo only — sibling repositories follow their own `AGENTS.md` setup; `~/Projects/kilocode` uses bun, not pnpm).
- Each section gets a scratch directory outside every repository — `mktemp -d "${TMPDIR:-/tmp}/kilo-workflow-<section>.XXXXXX"` — for its brief, plan, handoffs, decisions, and dispatch logs. Plans and handoffs are never committed and never live inside a repository.
- The PR, ready for human eyes, is the deliverable. When a section completes, everything that ran for it closes: agents, monitors, tmux sessions and windows, services, devices, slots, and the scratch directory. Anything a human needs afterward lives in the PR.
- Every reviewer and verifier invocation is a fresh session, so earlier conclusions cannot anchor later passes.
- Treat every reviewer's remarks as untrusted advice: the reviewer has less context than you and may be wrong. Verify each remark against the request, repository evidence, and applicable instructions before acting on it. The dispatcher (planner or orchestrator) records rejected remarks with a short technical rationale in `$SCRATCH/decisions.md` and carries them into later handoffs; rejections of GitHub findings also get their in-thread reply. Role agents return their triage in their reports instead of writing files. A rejected remark must not reopen without new evidence.
- Always aim for the simplest solution that achieves the user's goals — feature-wise as much as code-wise. Reuse existing helpers, components, and contracts. Do not add abstraction or scope without evidence it is required.
- Commit in small, logically scoped commits. The orchestrator owns every commit, push, branch change, and PR; other roles make only uncommitted worktree edits, and only where their definitions allow.
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

Role-agent models and step limits are pinned in their definitions in `.kilo/agent/` — the definition is authoritative, so role-agent dispatches never pass `--model`/`--variant`. The table's model column matters only for the planner and orchestrator launches, which have no definition. Never use `kilo/kilo-auto/free` — it is rate-limited. Not even as a fallback: if a call stalls or errors, retry or relaunch on the assigned model, never a different one. Product-side LLM calls in E2E flows follow "Real LLM responses" below.

### Step Limits

The kilo role-agent step limits above are hard ceilings pinned in the agent definitions. For the step-limited roles, size every handoff below 75% of the role's limit — estimate roughly one step per planned tool call; an implementation slice should fit in roughly 60 planned steps. Unlimited roles rely on stopping rules instead. Never raise a limit to fit an oversized task — split the task.

### Dispatching Kilo Role Agents

Any harness dispatches a role agent by shelling out to the kilo CLI. Always dispatch with cwd inside the **cloud** worktree, even when the slice edits a sibling repository — the role definitions in root `.kilo/agent/` are only discovered there, and they pin the model, so dispatches never pass `--model`/`--variant`:

```bash
cd <cloud-worktree>
LOG="$SCRATCH/plan-reviewer-r1.log"
env $(env | grep -oE '^(KILO|OPENCODE)[A-Za-z0-9_]*' | sed 's/^/-u /') kilo run \
  "Review the plan in the attached handoff per your role definition." \
  --agent plan-reviewer \
  --file "$SCRATCH/handoff.md" \
  --title "Plan review round 1" > "$LOG" 2>&1
echo "EXITCODE=$?" >> "$LOG"
```

The message is a short literal; file content — handoffs, plans, diffs — always travels via `--file <path>` (repeatable), never inlined with `"$(cat file)"`: dispatches routed through a tmux command string get re-parsed by another shell, and backticks inside the file then execute (see `learnings/kilo-run-shell-substitution-executes-backticks.md`). The message must stay positional before the flags.

The `env -u` prefix strips every inherited `KILO_*`/`OPENCODE*` variable — it matters when the dispatcher itself runs inside kilo, where partial stripping still poisons nested runs (see `learnings/nested-kilo-run-env-poisoning.md`).

Rules that prevent silent failures (details in `learnings/`):

- Run the dispatch inside tmux, never directly in a harness shell — harness command timeouts kill long runs. Non-device dispatches use a window; device-phase dispatches (the repro gate, every `e2e-verifier` round) get their **own tmux session** (`tmux new-session -d -s <section>-e2e-r<round>`), because E2E slots are owned and auto-reclaimed by session name — a window-named owner leaks or shares slots. Name windows/sessions `<section>-<role>-<slice>-r<round>` and logs `$SCRATCH/<role>-<slice>-r<round>.log` (slice omitted when not applicable). The current session name is `tmux display-message -p '#S'`.
- Redirect output; never pipe it (`| tee` makes `$?` report the pipe's exit, not kilo's).
- Keep the message positional **before** the flags: `--file` takes multiple values and swallows a trailing message as a path.
- Wait event-driven: the run is done when the tmux window is gone or `tail -1 "$LOG"` matches `^EXITCODE=[0-9]`.
- **Void rounds:** every role definition requires a fixed final sentinel line (`No findings.` or a findings list for reviewers; `SLICE COMPLETE.`/`STOPPED EARLY.` for the implementer; `VERIFICATION PASSED.`/`VERIFICATION FAILED.`/`VERIFICATION BLOCKED.`/`REPRODUCED.`/`CANNOT REPRODUCE.`/`STOPPED EARLY.` for the verifier). A round whose log lacks its role's sentinel is void, never a pass, regardless of exit code — kilo runs can die mid-stream and still exit 0. Discard the round and dispatch a fresh session.

Role boundaries — reviewers never modify the tree, the implementer never commits, no role dispatches agents — are enforced by instruction, not permission. This is deliberate: permission deny lists caused void review rounds (a reviewer whose blocked command made it exit with no verdict, which read as a pass) and takeover churn. The workflow trades enforcement for reliable rounds and accepts that a misbehaving agent can do what it was told not to; do not "fix" this by re-adding deny lists.

While a role agent runs, its dispatcher checks on it about every 7 minutes and unsticks infrastructure failures only: a wedged or crashed kilo CLI, a dead tmux window, a hung service the agent cannot restart itself. Product, logic, or review problems are not stuck states — route those through the escalation ladder.

### Escalation

When a loop iteration fails, escalate in order:

1. Re-dispatch the same role once with sharper steering: the diagnosis, the failing evidence, what was already tried, and a narrower goal.
2. If the steered round failed but made progress, restructure: split the slice or change the approach in the handoff, then dispatch again.
3. Take over directly as soon as any steered round produced zero new progress — step 2 is not a prerequisite. Record every takeover with a one-line justification in `$SCRATCH/decisions.md`.

Progress means new root-cause information, a smaller reproduction, fewer reviewer findings, or a previously failing check now passing. The same error under the same theory twice is not progress. Never loop indefinitely.

### Handoff Requirements

Every dispatch to a role agent includes:

- The assigned task, explicit non-goals, and observable acceptance criteria
- The scratch directory path
- The worktree path for every repository in scope, with branch and working-tree state, and existing changes that must be preserved
- The mode; for hands-off, a direct instruction to never ask the user questions
- Sanitized env values inline. Role agents must never read `.env`, `.env.*`, `.dev.vars`, or equivalent files; the handoff table is authoritative. Never place secrets or raw environment-file contents in a handoff.
- The exact checks or flows expected for that stage
- For any device or stack phase: the slot rule (see E2E Slots) with the tmux session name that owns the slot
- Prior findings being addressed, including rejected findings that must not reopen without new evidence
- Priority order, minimum complete outcome, optional work to drop, and a clean stopping rule before budget exhaustion (estimate roughly one step per planned tool call; when in doubt, split the task); on early stop, the required continuation state (completed work, remaining work, failures, files touched, checks run or deferred, safest next action)
- The GitHub comment rule (see GitHub Communication)
- Fixture rule: never commit generated E2E fixtures; create them in a temporary directory and clean up before returning

Write handoffs to temporary files outside every repository, and never ask a role agent to infer context from a conversation it cannot see.

## 1. Starter

The session the user invokes the workflow from is the starter, running on the harness and model the user picked. Its job is to turn a raw request into approved, sectioned work:

1. Collect the initial body of work from the user, and ask exactly one process question: is this run `hands on` or `hands off`? The mode governs every later role.
2. Explore the relevant parts of the codebase.
3. Interrogate the requirements — in `hands on` mode by grilling the user one question at a time, in `hands off` mode by grilling itself and answering from repository evidence, recording material assumptions. Always drive toward the simplest solution that achieves the user's goals, and challenge the request itself: "should we even do this?", "why not do this instead?", "we could achieve the same thing simpler, like this".
4. Divide the finalized work into related, **disjoint** sections — no two sections may touch the same files or contracts.
5. For each section: create the dedicated worktree and scratch directory (Ground Rules), write the section brief to `$SCRATCH/brief.md` — the work, the mode, acceptance criteria and constraints gathered so far, the requesting human's GitHub handle for PR assignment, the worktree path, and the scratch path — and launch a planner in a new tmux window on the user-picked planner harness and model. The `$SCRATCH` value must be expanded by the launching shell (double-quote the tmux command string; the tmux server does not know the variable):

```bash
# kilo planner:
tmux new-window -t <session> -n <section>-planner -c <worktree> \
  "kilo run 'You are the planner in .kilo_workflow/WORKFLOW.md. Plan the work in the attached brief.' \
   --interactive --model <planner-model> --variant high --title '<section> planner' --file $SCRATCH/brief.md"
# claude planner:
tmux new-window -t <session> -n <section>-planner -c <worktree> \
  "claude 'You are the planner in .kilo_workflow/WORKFLOW.md. Plan the work in the brief at $SCRATCH/brief.md.'"
```

One planner per section; each section flows through its own planner, orchestrator, and PR. A single-section run launches a single planner. If the starter's own session already fits the planner role (right model, user agrees), it may become the single planner itself instead of launching one.

### Starter Monitor Mode

After launching planners the starter monitors them the same way the planner monitors the orchestrator: check about every 30 minutes, unstick or relaunch on infrastructure death only (a fresh session with a continuation brief covering what the dead planner observably finished — never `--continue`), and never intervene in planning judgment. The starter's duty ends when every section has reached a terminal state (see Planner Monitor Mode).

### Interaction Modes

- `hands on`: ask the user one question at a time until requirements, trade-offs, and acceptance criteria are unambiguous. The planner later gets explicit user approval of the plan before launching the orchestrator. After the handoff, user questions belong to the orchestrator — it asks directly in its interactive session when a repair loop or ambiguity cannot be resolved.
- `hands off`: after mode selection, never ask the user a question and never wait for approval — treat all approvals as granted. Answer open questions from repository evidence and record material assumptions in the plan and handoff. Stop only when continuing is technically impossible or unsafe, and return a precise blocker report instead of a question. Hands-off mode does not bypass tool permissions, repository safety rules, or the completion gate.

## 2. Planner

The planner writes the implementation plan for its section. The plan is consumed by the orchestrator, implementers, and reviewers — all cheaper models — so it must:

- Fulfil the assigned body of work
- Be written in simple, explicit language a cheaper model can follow without guessing
- Achieve the work in the simplest, most maintainable way

Steps:

1. Read the learnings. Explore the relevant parts of the codebase. Define acceptance criteria, non-goals, and the feature-state matrix for any user-facing feature.
2. For defect work, run the bug reproduction gate before writing the plan.
3. Write the complete draft plan to `$SCRATCH/plan.md`.
4. Loop, at most five rounds: dispatch a fresh `plan-reviewer`, verify its remarks (untrusted), fix valid ones, record rejected ones. Exit when a fresh reviewer returns `No findings.` If three consecutive rounds stay stuck on the same issue — or the five-round cap is hit — resolve the remaining findings directly, record each resolution in `$SCRATCH/decisions.md`, and dispatch one final fresh reviewer. If that final reviewer still objects, do not loop again: record the disagreement and proceed with the recorded resolution (hands-on: ask the user instead).
5. Hands-on: get explicit user approval of the plan. Hands-off: self-approve.
6. Write the sanitized orchestrator handoff to `$SCRATCH/handoff.md` (see Handoff Requirements, plus: the plan path, the scratch directory path, the final review result, any simpler-shape decision and its reasoning, and the completion gate with a direct instruction to continue until the PR is mergeable with green CI). Launch the orchestrator, then switch to monitor mode.

### Bug Reproduction Gate

For defect work, dispatch a fresh `e2e-verifier` in repro mode on the unmodified baseline before writing the draft plan. Repro mode is not a CLI flag: the dispatch is the normal `--agent e2e-verifier` dispatch (own tmux session — see Dispatching), and the handoff text assigns repro mode, which the verifier definition recognizes. Its assignment: reproduce the reported issue — fix nothing — and return exact reproduction steps, evidence, and a failure classification. A confirmed reproduction feeds the plan, and the confirmed repro flow passing becomes an acceptance criterion the final verifier must rerun.

`Cannot reproduce` is a blocker, not a license to fix an unconfirmed bug. Hands-on: return the evidence to the user and ask how to proceed. Hands-off: stop with a blocker report — no plan, no orchestrator.

### Launching the Orchestrator

```bash
tmux new-window -t <session> -n <section>-orchestrator -c <worktree> \
  "kilo run 'Execute the approved plan in the attached handoff. Own implementation through the completion gate.' \
   --interactive --model kilo/moonshotai/kimi-k3 --variant high \
   --title '<section> orchestrator' --file $SCRATCH/handoff.md"
```

`--interactive` requires a TTY: launch it as the tmux window command with no pipe, and attach logging with `tmux pipe-pane` if needed. Do not add `--continue` or `--session`; the orchestrator must be a fresh session. Verify the window started, then report the window name, worktree path, and handoff path.

### Planner Monitor Mode

After the handoff the planner stops all hands-on work. It has exactly one job — relaunch or unstick the orchestrator when infrastructure fails (a crashed kilo CLI, a dead tmux window, a hung service). Product, logic, design, and review problems are the orchestrator's, handled by its escalation ladder. Check about every 30 minutes; react immediately when the orchestrator's process exits.

A dead orchestrator window is not automatically a crash — check the scratch directory:

- Scratch **gone** → the section COMPLETED and shut itself down; confirm the PR state with `gh pr view`, tell the user, and close yourself.
- Scratch present with `$SCRATCH/final-report.md` → BLOCKED; relay the report to the user, then clean up the scratch and close yourself.
- Scratch present with no final report → a crash; relaunch with a continuation handoff.

Long kilo runs die on provider stream stalls, and `--interactive` sessions can wedge on provider errors. Relaunch a dead or wedged orchestrator as a **fresh session** (never `--continue`) with a continuation handoff: the original handoff plus everything observably done so far — commits, PR state, passed rounds, held resources — assembled from `git log`, the PR, and the dispatch logs, so the new session verifies rather than redoes. See `learnings/kilo-interactive-orchestrator-wedges-relaunch.md`.

### 2.1 Plan Reviewer

Given the plan and what it is trying to achieve, the `plan-reviewer` reviews the plan as a whole and pokes holes in it, with special attention to unnecessary complexity. It returns a list of remarks, or `No findings.` when it is confident the plan achieves the goal appropriately and is written so cheaper models can follow it. See `.kilo/agent/plan-reviewer.md`.

## 3. Orchestrator

The orchestrator drives the plan to completion. It is the expensive model steering cheap role agents: its output is judgment — handoffs, steering, triage, verification — not diffs. It may edit directly only for merge-conflict resolution, one-line configuration, and takeovers under the escalation ladder.

1. Ingest the handoff, verify each worktree matches its recorded branch and state, and read the learnings.
2. Segment the plan into slices with disjoint write sets so parallel implementers cannot collide — the plan proposes the tasks, the orchestrator owns the slicing. Always serialize: lockfile changes, dependency installs, migrations, generated clients, repository-wide formatters, and broad autofix commands. File separation is not enough when one slice changes a contract another consumes.
3. Dispatch ready independent slices to parallel `implementer`s — as many in parallel as the segmentation safely allows; agent parallelism is never capped, only E2E device/stack phases are (see E2E Slots). Loop per slice, at most five rounds: implementer implements, then a fresh `impl-reviewer` reviews the slice diff — scope it to the slice's owned paths (`git diff -- <owned paths>` written to a scratch file passed via `--file`), since parallel slices share the worktree; triage remarks (untrusted), route valid ones through a repair dispatch. Exit the loop when a fresh reviewer returns `No findings.`, or when its only remaining findings are already rejected in `$SCRATCH/decisions.md`. At the round cap, escalate (see Escalation) instead of looping.
4. Create small logical commits at slice boundaries.
5. Create the PR — description with human-readable **what / why / how** sections — assign it to the requesting human, and request reviews per repository convention (cloud: `eshurakov`, `jeanduplessis`; kilocode: additionally `marius-kilocode`, `chrarnoldus`). When the section spans multiple repositories, use the same branch name in each, open one PR per repository, cross-link them, and hold every one to the completion gate. CI and Kilobot start running concurrently with E2E.
6. Run the E2E loop (below) when the work has verifiable runtime behavior; skip it for doc-only or equivalently inert changes, recording why in the PR description.
7. Run the Kilobot loop (below).
8. When both loops are clean, verify the completion gate, then shut the section down. The PR is the deliverable; everything else closes.

Two terminal states, distinguished by what remains on disk:

- **COMPLETE** — the gate fully holds (a PR awaiting required human review is COMPLETE). Release every held resource (local backends, simulators, emulators, browsers, slots), delete the scratch directory, and close its own tmux window (`tmux kill-window`). Nothing survives but the PR — its description carries everything a human needs; material process notes (E2E skips with rationale, simpler-shape decisions) belong in it.
- **BLOCKED** — something made the gate unsatisfiable. Release every resource all the same, write `$SCRATCH/final-report.md` — first line `BLOCKED`, then the blocker, PR link and state, acceptance-criteria outcomes, takeovers with justifications, rejected findings, learnings written — leave the scratch directory as evidence, and close the window.

### E2E Loop

1. Dispatch a fresh `e2e-verifier` with the plan goals and acceptance criteria, in its own uniquely named tmux session (see Dispatching). The verifier acquires its own device slot under that session name and releases it the moment its device phase ends; the orchestrator never holds a slot on the verifier's behalf.
2. For each verifier remark: verify it (untrusted), then run the implementer → impl-reviewer loop to fix it; commit and push.
3. Re-verify — a follow-up verifier round re-tests only the touched behavior, not the whole plan.
4. Exit when a fresh verifier returns `VERIFICATION PASSED.` for the plan's goals. After five rounds without one, escalate (see Escalation) or record `BLOCKED` in the final report.

### Kilobot Loop

1. Wait for Kilobot to review the latest head (`gh pr view <n> --json statusCheckRollup,mergeable,mergeStateStatus`; threads via `gh api repos/<owner>/<repo>/pulls/<n>/comments`). Kilobot can crash: after about 20 minutes without a review, retrigger it (`git commit --allow-empty -m "chore: retrigger review" && git push`, or a `(bot) @kilo-code-bot please review` PR comment), then resume waiting. After two failed retriggers, stop waiting: post `(bot) Kilobot did not review this head after two retriggers` on the PR and treat the gate's Kilobot item as waived — the pending human review covers it. The clean state is the green `Kilo Code Review` check on the current head plus zero review threads; the `Status: No Issues Found` summary comment is a hint, not a contract — bot wording drifts (see `learnings/kilobot-no-findings-state.md`).
2. For each comment: verify it (untrusted), then route valid findings through the implementer → impl-reviewer loop; commit, push, reply in the thread, and resolve it. Invalid finding: reply with technical evidence and do not change correct code. A fix without its in-thread reply and thread resolution is not done. Follow the repository-root `AGENTS.md` "Kilobot Review Remarks" contract.
3. Comments already posted by other reviewers — bots or humans — get the same triage flow, but never wait for anyone except Kilobot to review or re-review.
4. Rerun E2E for any repair that affects verified behavior (touched bits only).
5. Exit when Kilobot has reviewed the latest head and no actionable posted comment is unresolved.

Integrate the base branch **only when GitHub reports an actual conflict** (`mergeable: CONFLICTING`) or the run needs something that landed on the base. Integrate by merge, not rebase — `git fetch origin && git merge origin/main` — with the orchestrator resolving conflicts itself (its merge-conflict direct-edit allowance). Rebasing a conflict-free branch invalidates green CI and a completed Kilobot review for nothing. `mergeStateStatus: BLOCKED` on a `MERGEABLE` PR means a required human review is pending — that is the expected terminal state, not a problem to solve.

### Completion Gate

The work is complete only when every item holds:

- All accepted plan tasks are implemented, with automated coverage for every applicable feature state
- A fresh impl reviewer reports no valid actionable findings
- A fresh E2E verifier returned `VERIFICATION PASSED.` for the plan's goals — or E2E was skipped as inert, with the rationale in the PR description
- Changes are organized into small, coherent commits; format, typecheck, lint, and tests pass in every changed repository, using the check commands the nearest `AGENTS.md` or `package.json` defines for each changed package
- The PR exists with what/why/how sections and is assigned to the requesting human
- Kilobot has reviewed the latest head and no actionable posted comment is unresolved — or Kilobot's absence after two retriggers is noted in a `(bot) ` PR comment
- All expected CI checks on the latest head are green, and GitHub reports the head mergeable with no conflicts
- No generated fixture remains, tracked or untracked; every verifier temporary edit is restored
- Every resource this run started is shut down or released; resources the run did not start stay running
- New committed learnings are included in the PR

A PR waiting on required human review is COMPLETE — the workflow never approves or merges its own PR. A gate item that can never hold is BLOCKED (see step 8), never a reason to loop forever or fake completion.

### 3.1 Implementer

Implements one bounded slice per the plan and the handoff, runs narrow checks on what it changed, and never commits. See `.kilo/agent/implementer.md`.

### 3.2 Impl Reviewer

Independently reviews the slice diff against the plan's goals for that slice. Read-only. See `.kilo/agent/impl-reviewer.md`.

### 3.3 E2E Verifier

Verifies that the goals of the plan are met by the new implementation. It starts local services and points local clients at them, following the surface-specific runbook (mobile: `apps/mobile/e2e/AGENTS.md`; web and services: `DEVELOPMENT.md` and the repository dev runner). Everything is verified fully locally. It also writes learnings (see Learnings). See `.kilo/agent/e2e-verifier.md`.

#### Real LLM Responses

Any step where an agent or LLM must actually respond — cloud-agent sessions, chat flows, acceptance states — uses real model calls on `kilo-auto/efficient`, always. If an `efficient` call stalls or errors, retry on `efficient`; never switch models. LLM mocking (fake-llm or otherwise) is prohibited unless a real call cannot produce the required state; each use must be named and justified in the handoff and the PR. Two standing exceptions qualify: forcing a specific provider failure, and deterministic local cloud-agent turns per `learnings/mobile-cloud-agent-deterministic-turns-fake-llm.md`.

## E2E Slots

The machine is shared by parallel workflows, and unslotted device or stack work overloads it. Only E2E runs are capped — agents themselves are never capped. Every phase that drives a simulator, emulator, local backend stack, browser fleet, or native build — the repro gate and every E2E round — runs inside a slot from [`e2e-slot.sh`](e2e-slot.sh) (default 3, machine-global):

```bash
.kilo_workflow/e2e-slot.sh acquire <tmux-session>   # blocks until a slot frees
.kilo_workflow/e2e-slot.sh status                   # current holders
.kilo_workflow/e2e-slot.sh release <tmux-session>   # the moment the device phase ends
```

- Slot state lives in `$HOME/.cache/kilo-e2e-slots`, machine-global by design: every copy of the script — any worktree, any repository — contends for the same slots. When working in a repository without the script (a sibling like `~/Projects/kilocode`), invoke it by absolute path from a cloud worktree. Never set `E2E_SLOTS` or `E2E_SLOT_DIR`; the defaults are the contract.
- This holds on every run, not only when another workflow is visibly active, and a stack that is already up is not an exemption.
- `acquire` blocking is correct behavior, never a wedge to route around and never a reason to start device work unslotted. If an acquire is still blocked after about 45 minutes, the dispatcher inspects `status` for a wedged foreign holder and reports a blocker instead of waiting forever.
- The slot caps load, not data: postgres and redis containers are shared across worktrees. Keep test data keyed to this worktree's accounts (the runbooks' per-worktree defaults) and never wipe shared state.
- Release immediately when the device/stack phase ends. Planning, implementation, review, checks, and CI waits are uncapped; never hold a slot through them.
- Slots are owned by tmux session name and reclaimed automatically when the session dies. A holder that is alive but wedged belongs to its own workflow's monitor — never kill another session to free a slot; if the queue is starved by a foreign wedge, report a blocker to the user instead.
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
- System-specific learnings (true only of this machine: installed tools, local ports, OS quirks) go to `learnings/system/`, which is gitignored (only its `.gitkeep` is committed). Write them to the **main checkout's** copy — `~/Projects/cloud/.kilo_workflow/learnings/system/` — so they survive worktree deletion and reach parallel runs immediately; `pnpm dev:worktree:prepare` copies them into fresh worktrees.
- Everything else goes to the section worktree's `.kilo_workflow/learnings/` and is committed — the orchestrator includes new learnings in the run's PR (they reach other runs once merged; that lag is accepted).
- `.kilo_workflow/` is exempt from section disjointness — any section may write learnings or fix this document; overlaps resolve as ordinary merge conflicts.
- Role agents whose rules forbid dirtying the tree (the E2E verifier's byte-identical baseline restore) write their learnings to `$SCRATCH/learnings/` instead and list them in their report; the orchestrator moves them into `.kilo_workflow/learnings/` and commits them.
- Read before writing: when an existing entry covers the blocker, update it instead of appending a duplicate. When a run proves an entry wrong or stale, fix the entry in the same run.
- Every role records blockers it resolves, immediately after resolving them.
- Never keep a workflow learning only in a harness's private memory; it belongs in these folders so runs on other harnesses can use it.
- The same rule applies to this document: when a run stumbles on something `WORKFLOW.md` could have prevented — a missing command, an ambiguous rule, a wrong assumption — the orchestrator fixes the document in the same run and ships the fix with the PR. Role-definition fixes from a kilo session go through shell (`cat > .kilo/agent/<name>.md <<'EOF'`) because kilo's edit tool blocks `.kilo/` paths (see `learnings/kilo-edit-tool-blocks-kilo-config-paths.md`). Mistakes that recur are workflow bugs, not agent bugs.

## GitHub Communication

Every GitHub issue comment, PR comment, review comment, review body, and thread reply written by this workflow begins exactly with `(bot) `, including replies to Kilobot and rejections of findings. Only the PR title and PR description carry no prefix.
