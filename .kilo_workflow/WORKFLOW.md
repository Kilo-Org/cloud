# Kilo Workflow

A general-purpose multi-agent delivery workflow for this repository. Use it when the user asks to run "the kilo workflow" on a body of work. It applies to any product surface — web, mobile, extension, Workers, services, shared packages — and plans may also touch sibling repositories such as `~/Projects/kilocode`.

Pipeline: **starter → planner(s) → orchestrator → implementer/reviewer loops → E2E verification → PR**.

The definitions for every kilo CLI role live in the repository root `.kilo/agent/` — `starter`, `planner`, `orchestrator`, `plan-reviewer`, `implementer`, `impl-reviewer`, `e2e-verifier` — because the kilo CLI only discovers agents from `.kilo` directories. Everything else about the workflow — this document, the dispatch and slot scripts, and committed learnings — lives in `.kilo_workflow/`.

## Ground Rules

These apply to every role. Later sections do not repeat them.

- Every long-lived process — starter, planner, orchestrator, dispatched role agents, local services — runs in tmux, with a unique descriptive window or session name.
- Section names are lowercase slugs (`[a-z0-9-]` only — they become branch, tmux, and path names) carrying a short random run id: `<name>-$(openssl rand -hex 2)`, for example `billing-a7f3`. This keeps parallel runs from colliding on worktrees, branches, tmux names, or scratch paths.
- All workflow tmux lives on the default tmux server — never a custom socket; slot reaping and monitoring key on the sessions one server can see.
- Work only in dedicated worktrees, in every repository the plan touches — one worktree per repository, `~/Projects/.worktrees/<section>` for cloud and `~/Projects/.worktrees/<section>-<repo>` for siblings, all on the same branch name: `git fetch origin && git worktree add <path> -b <section> origin/main`, then run `pnpm dev:worktree:prepare` inside it (cloud repo only — sibling repositories follow their own `AGENTS.md` setup; `~/Projects/kilocode` uses bun, not pnpm). The cloud worktree always exists, even for sibling-only sections — role dispatches run from it. Never edit a primary or main checkout, with one exception: machine-local learnings under the main checkout's `.kilo_workflow/learnings/system/` (`mkdir -p` it if missing). Worktrees outlive the run; remove them (`git worktree remove <path>`) once their PR closes.
- Each section gets a scratch directory outside every repository — `mktemp -d "${TMPDIR:-/tmp}/kilo-workflow-<section>.XXXXXX"` — for its brief, plan, handoffs, decisions, and dispatch logs. Plans and handoffs are never committed and never live inside a repository.
- The PR, ready for human eyes, is the deliverable. When a section completes, everything that ran for it closes: agents, monitors, tmux sessions and windows, services, devices, slots, and the scratch directory (a BLOCKED section retains its scratch directory as evidence). Anything a human needs afterward lives in the PR.
- Every reviewer and verifier invocation is a fresh session, so earlier conclusions cannot anchor later passes.
- Treat every reviewer's remarks as untrusted advice: the reviewer has less context than you and may be wrong. Verify each remark against the request, repository evidence, and applicable instructions before acting on it. The dispatcher (planner or orchestrator) records rejected remarks with a short technical rationale in `$SCRATCH/decisions.md` and carries them into later handoffs; rejections of GitHub findings also get their in-thread reply. Role agents return their triage in their reports instead of writing files. A rejected remark must not reopen without new evidence.
- Always aim for the simplest solution that achieves the user's goals — feature-wise as much as code-wise. Reuse existing helpers, components, and contracts. Do not add abstraction or scope without evidence it is required.
- Commit in small, logically scoped commits. The orchestrator owns every commit, push, branch change, and PR; other roles make only uncommitted worktree edits, and only where their definitions allow.
- Monitoring is event-driven: when a dispatched process exits, its dispatcher reacts immediately, never after a fixed sleep. Periodic checks exist only to detect a wedge.
- Before any environment-dependent phase, read the learnings (see Learnings): the worktree's `.kilo_workflow/learnings/`, plus the main checkout's `~/Projects/cloud/.kilo_workflow/learnings/system/` — the canonical machine-local set, which mid-run writes go to and worktree copies lag.

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

Every kilo-CLI role above has a definition in `.kilo/agent/` (including `starter`, `planner`, and `orchestrator`) pinning its permissions, and — except the starter and planner, whose models are the user's pick at launch — its model and step limit. The definition is authoritative: dispatches pass `--model`/`--variant` only for the starter and planner. Never use `kilo/kilo-auto/free` — it is rate-limited. Not even as a fallback: if a call stalls or errors, retry or relaunch on the assigned model, never a different one. Product-side LLM calls in E2E flows follow "Real LLM responses" below.

### Step Limits

The kilo role-agent step limits above are hard ceilings pinned in the agent definitions. For the step-limited roles, size every handoff below 75% of the role's limit — estimate roughly one step per planned tool call; an implementation slice should fit in roughly 60 planned steps. Unlimited roles rely on stopping rules instead. Never raise a limit to fit an oversized task — split the task.

### Dispatching Kilo Role Agents

Dispatch worker role agents with [`dispatch-role.sh`](dispatch-role.sh) — it encodes the whole contract (tmux wrapping, env strip, naming, redirection, the `EXITCODE` marker) so nothing is hand-assembled:

```bash
LOG=$(.kilo_workflow/dispatch-role.sh plan-reviewer <section> r1 <cloud-worktree> "$SCRATCH" \
  "Review the plan in the attached handoff per your role definition." \
  --file "$SCRATCH/handoff.md")
```

The cwd/worktree is always the **cloud** worktree, even when the slice edits a sibling repository — the role definitions in root `.kilo/agent/` are only discovered there, and they pin the model, so worker dispatches never pass `--model`/`--variant`. The message is a short literal; file content — handoffs, plans, diffs — always travels via `--file <path>` (repeatable), never inlined with `"$(cat file)"`: dispatches routed through a tmux command string get re-parsed by another shell, and backticks inside the file then execute (see `learnings/kilo-run-shell-substitution-executes-backticks.md`).

What the script encodes (details in `learnings/`):

- tmux wrapping — harness command timeouts kill bare long runs. The `e2e-verifier` gets its **own tmux session** (E2E slots are owned and auto-reclaimed by session name; a window-named owner leaks or shares slots); other roles run as windows in the dispatcher's session, resolved through `$TMUX_PANE`. A dispatcher that is not itself inside tmux has no such session, so its roles get their own sessions too — never a guessed one. Names are `<section>-<role>-<label>`, logs `$SCRATCH/<role>-<label>.log`.
- Full `KILO_*`/`OPENCODE*` env strip — a dispatcher running inside kilo poisons nested runs otherwise (see `learnings/nested-kilo-run-env-poisoning.md`).
- Output redirected, never piped (`| tee` makes `$?` report the pipe's exit, not kilo's), with `EXITCODE=$?` appended as the log's last line.

Wait event-driven: the run is done when the tmux window/session is gone or `tail -1 "$LOG"` matches `^EXITCODE=[0-9]`. The role's sentinel is then the line **above** the marker — check it with `tail -2 "$LOG" | head -1`, never by grepping the whole log (agents quote sentinel strings when reading this document, and a mid-log match false-passes).
- **Void rounds:** every role definition requires a fixed sentinel as the log's **last report line** (reviewers: `No findings.`, `FINDINGS: <n>`, or `STOPPED EARLY.`; implementer: `SLICE COMPLETE.`/`STOPPED EARLY.`; verifier: `VERIFICATION PASSED.`/`VERIFICATION FAILED.`/`VERIFICATION BLOCKED.`/`REPRODUCED.`/`CANNOT REPRODUCE.`/`STOPPED EARLY.`). A round without its sentinel is void, never a pass, regardless of exit code — kilo runs can die mid-stream and still exit 0. Discard it and dispatch a fresh session. `STOPPED EARLY.` is not void but not success either: re-dispatch with a continuation handoff; it counts toward the loop's round cap.
- After a reviewer round, the reviewed slice's owned paths must match the dispatcher's pre-round snapshot (other slices' implementers may legitimately be editing theirs); after an implementer round no new commits may exist. A violation voids the round.
- Void rounds count toward the loop's round cap, and three consecutive void rounds are an infrastructure blocker (auth wedge, provider outage), never something to redispatch through.

Role boundaries — reviewers never modify the tree, the implementer never commits, no role dispatches agents — are enforced by instruction, not permission. This is deliberate: permission deny lists caused void review rounds (a reviewer whose blocked command made it exit with no verdict, which read as a pass) and takeover churn. The single exception is `task: deny` in the definitions — blocking agent dispatch costs nothing and cannot void a round. The workflow otherwise trades enforcement for reliable rounds and accepts that a misbehaving agent can do what it was told not to; do not "fix" this by re-adding deny lists.

While a role agent runs, its dispatcher checks on it about every 7 minutes and unsticks infrastructure failures only: a wedged or crashed kilo CLI, a dead tmux window, a hung service the agent cannot restart itself. Product, logic, or review problems are not stuck states — route those through the escalation ladder.

### Steering a Live Interactive Session

Worker roles are steered by re-dispatching them (see Escalation). The interactive sessions — starter, planner, orchestrator — are steered in place with [`steer.sh`](steer.sh), never with hand-assembled `tmux send-keys`:

```bash
.kilo_workflow/steer.sh <section>-orchestrator "Scope change: drop slice 4; commit what holds and open the PR."
printf '%s' "$AMENDMENT" | .kilo_workflow/steer.sh <section>-orchestrator -   # long or multi-line text via stdin
```

It prints `running` when the session took the message immediately and `queued` when the message is waiting behind the active turn; either way it is delivered. A non-zero exit means it is **not** delivered — inspect the target rather than sending a second copy. What the script encodes (details in `learnings/steering-a-running-kilo-session.md`):

- Enter as its own keystroke after the text. A trailing `Enter` in the same `send-keys` call submits short messages but is swallowed by long ones, which then sit unsent in the composer — the "wedged" session that is really an undelivered message.
- Bracketed paste, so a multi-line message stays one prompt. An unbracketed paste submits at every newline, and the first fragment gets acted on before the rest arrives.
- A refusal to paste into a pane that is not running the kilo CLI — a mistargeted steer executes in a shell.
- Delivery confirmed from the pane, never assumed.

**`N queued` in the footer is delivery working, not a wedge.** Queued messages land one at a time at turn boundaries, in order, and a session that chains tool calls for tens of minutes holds the whole queue that entire time. Never kill, relaunch, or escalate on a queue count; a wedge needs its own evidence (frozen build timer, stream or api error, dead process — see Planner Monitor Mode). `Escape` does not flush the queue.

Because delivery is ordered and turn-paced, a correction cannot overtake what it corrects: send ONE consolidated, self-contained message per change, never a drip of add-then-retract. When a change must take effect before the current turn ends, kill the session and relaunch it fresh with an updated handoff — faster than waiting on the queue, and it cannot half-apply. Everything a session needs at launch belongs in its launch message and handoff; steering a live one is the exception, not the channel.

### Escalation

When a loop iteration fails, escalate in order:

1. Re-dispatch the same role once with sharper steering: the diagnosis, the failing evidence, what was already tried, and a narrower goal.
2. If the steered round failed but made progress, restructure: split the slice or change the approach in the handoff, then dispatch again.
3. Take over directly as soon as any steered round produced zero new progress — step 2 is not a prerequisite. Record every takeover with a one-line justification in `$SCRATCH/decisions.md`.

Progress means new root-cause information, a smaller reproduction, fewer reviewer findings, or a previously failing check now passing. The same error under the same theory twice is not progress. Never loop indefinitely.

The ladder and the loop round caps work together, not against each other. One round = one full iteration of the loop's body (in the implementer loop, an implementer dispatch plus its reviewer dispatch; in single-role loops, one dispatch) — and every attempted round counts, whether steered, restructured, void, or `STOPPED EARLY.` A cap is a ceiling and never a budget (the ladder usually ends a loop well before it), and at the cap the steering and restructure rungs are spent — the only remaining moves are takeover or BLOCKED.

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

The session the user invokes the workflow from is the starter, running on the harness and model the user picked; a kilo starter launches as `kilo run --agent starter --interactive --model <model>` (the definition pins its permissions). Its job is to turn a raw request into approved, sectioned work:

1. Collect the initial body of work from the user, and ask exactly one process question: is this run `hands on` or `hands off`? The mode governs every later role. Planner harness and model: whatever the user picked; absent an explicit pick, reuse the starter's own.
2. Explore the relevant parts of the codebase.
3. Interrogate the requirements — in `hands on` mode by grilling the user one question at a time, in `hands off` mode by grilling itself and answering from repository evidence, recording material assumptions. Always drive toward the simplest solution that achieves the user's goals, and challenge the request itself: "should we even do this?", "why not do this instead?", "we could achieve the same thing simpler, like this".
4. Divide the finalized work into related, **disjoint** sections — no two sections may touch the same files or contracts.
5. For each section: create the dedicated worktree and scratch directory (Ground Rules), write the section brief to `$SCRATCH/brief.md` — the work, the mode, acceptance criteria and constraints gathered so far, the requesting human's GitHub handle for PR assignment, the worktree path, and the scratch path — and launch a planner in a new tmux window on the planner harness and model. `<session>` is the starter's own tmux session, resolved through its own pane — `tmux display-message -p -t "$TMUX_PANE" '#S'`; never the untargeted `tmux display-message -p '#S'`, which answers with the tmux **server's** current session (the most recently active one) and silently files the window under an unrelated section. A starter that is not itself inside tmux has no such session and `$TMUX_PANE` is unset: launch the planner with `tmux new-session -d -s <section>-planner` instead of guessing a target. The `$SCRATCH` value must be expanded by the launching shell (double-quote the tmux command string; the tmux server does not know the variable):

```bash
# kilo planner (the planner agent definition pins permissions; the model is the user's pick):
tmux new-window -t <session> -n <section>-planner -c <worktree> \
  "env \$(env | grep -oE '^(KILO|OPENCODE)[A-Za-z0-9_]*' | sed 's/^/-u /' || true) \
   kilo run 'Plan the work in the attached brief.' --agent planner \
   --interactive --model <planner-model> --variant high --title '<section> planner' --file $SCRATCH/brief.md"
# claude planner:
tmux new-window -t <session> -n <section>-planner -c <worktree> \
  "claude 'You are the planner in .kilo_workflow/WORKFLOW.md. Plan the work in the brief at $SCRATCH/brief.md.'"
```

The escaped `\$(env ...)` strip runs inside the new window, clearing `KILO_*`/`OPENCODE*` the tmux server may carry (see `learnings/nested-kilo-run-env-poisoning.md`).

One planner per section; each section flows through its own planner, orchestrator, and PR. A single-section run launches a single planner. If the starter's own session already fits the planner role (right model, user agrees), it may become the single planner itself instead of launching one.

### Starter Monitor Mode

After launching planners the starter monitors them the same way the planner monitors the orchestrator: check about every 30 minutes, unstick or relaunch on infrastructure death only (a fresh session with a continuation brief covering what the dead planner observably finished — never `--continue`), and never intervene in planning judgment. The starter's duty ends when every section has reached a terminal state (see Planner Monitor Mode).

### Interaction Modes

- `hands on`: ask the user one question at a time until requirements, trade-offs, and acceptance criteria are unambiguous. The planner later gets explicit user approval of the plan before launching the orchestrator. After the handoff, user questions belong to the orchestrator — it asks directly in its interactive session when a repair loop or ambiguity cannot be resolved. Hands-on assumes the user can attach to the reported tmux windows; a question unanswered after a bounded wait (hours, not minutes) becomes a BLOCKED report, and a session waiting on one is not a wedge.
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
4. Loop, at most five rounds: dispatch a fresh `plan-reviewer`, verify its remarks (untrusted), fix valid ones, record rejected ones. Exit when a fresh reviewer returns `No findings.` If three consecutive rounds stay stuck on the same issue — or the five-round cap is hit — resolve the remaining findings directly, record each resolution in `$SCRATCH/decisions.md`, and dispatch one final fresh reviewer (outside the cap). If that final reviewer still objects, do not loop again: record the disagreement and proceed with the recorded resolution (hands-on: ask the user instead).
   The planner ends its own run the same way the orchestrator does: a blocker it cannot pass (a failed repro gate, an unresolvable hands-off gap) is written to `$SCRATCH/final-report.md` with first line `BLOCKED` — never a silent stop.
5. Hands-on: get explicit user approval of the plan. Hands-off: self-approve.
6. Create a worktree for any repository the plan turned out to touch that lacks one (Ground Rules) — before orchestrator launch, every in-scope repository has a worktree path in the handoff. Write the sanitized orchestrator handoff to `$SCRATCH/handoff.md` (see Handoff Requirements, plus: the plan path, the scratch directory path, the final review result, any simpler-shape decision and its reasoning, and the completion gate with a direct instruction to continue until the PR is mergeable with green CI and an approving Kilobot summary). Launch the orchestrator, then switch to monitor mode.

### Bug Reproduction Gate

For defect work, dispatch a fresh `e2e-verifier` in repro mode on the unmodified baseline before writing the draft plan. Repro mode is not a CLI flag: the dispatch is the normal `--agent e2e-verifier` dispatch (own tmux session, label `r0` — see Dispatching), and the handoff text assigns repro mode, which the verifier definition recognizes. Its assignment: reproduce the reported issue — fix nothing — and return exact reproduction steps, evidence, and a failure classification. A confirmed reproduction feeds the plan, and the confirmed repro flow passing becomes an acceptance criterion the final verifier must rerun.

A `CANNOT REPRODUCE.` sentinel is a blocker, not a license to fix an unconfirmed bug. Hands-on: return the evidence to the user and ask how to proceed. Hands-off: stop with a BLOCKED report — no plan, no orchestrator.

### Launching the Orchestrator

```bash
tmux new-window -t <session> -n <section>-orchestrator -c <worktree> \
  "env \$(env | grep -oE '^(KILO|OPENCODE)[A-Za-z0-9_]*' | sed 's/^/-u /' || true) \
   kilo run 'Execute the approved plan in the attached handoff. Own implementation through the completion gate.' \
   --agent orchestrator --interactive \
   --title '<section> orchestrator' --file $SCRATCH/handoff.md"
```

The `orchestrator` agent definition pins the model and permissions, so the launch passes neither.

`--interactive` requires a TTY: launch it as the tmux window command with no pipe, and attach logging with `tmux pipe-pane` if needed. Do not add `--continue` or `--session`; the orchestrator must be a fresh session. Verify the window started, then report the window name, worktree path, and handoff path.

### Planner Monitor Mode

After the handoff the planner stops all hands-on work. It has exactly one job — relaunch or unstick the orchestrator when infrastructure fails (a crashed kilo CLI, a dead tmux window, a hung service). Product, logic, design, and review problems are the orchestrator's, handled by its escalation ladder. Check about every 30 minutes; react immediately when the orchestrator's process exits.

A dead orchestrator window is not automatically a crash — check the scratch directory:

- Scratch **gone** → the section COMPLETED and shut itself down; confirm the PR exists in gate state in **every** repository the section touched (`gh pr view <section> --repo <owner>/<repo>` — never bare `gh pr view`, which only checks the cloud branch), tell the user, and close yourself. A missing PR means it was not a completion — treat it as a crash.
- Scratch present with `$SCRATCH/final-report.md` → BLOCKED; relay the report to the user and close yourself. Leave the scratch directory alone — it is the blocker's evidence, and its presence is what distinguishes BLOCKED from COMPLETE for anyone who looks later.
- Scratch present with no final report → a crash; relaunch with a continuation handoff.

A live session waiting on a hands-on user answer is not wedged, and neither is one holding queued steers (see Steering a Live Interactive Session) — read the pane before declaring a wedge. Long kilo runs die on provider stream stalls, and `--interactive` sessions can wedge on provider errors. Relaunch a dead or wedged orchestrator as a **fresh session** (never `--continue`) with a continuation handoff. After three consecutive relaunches with no new progress, stop and write the BLOCKED report yourself — the same rule bounds the starter's planner relaunches: the original handoff plus everything observably done so far — commits, PR state, passed rounds, held resources — assembled from `git log`, the PR, and the dispatch logs, so the new session verifies rather than redoes. See `learnings/kilo-interactive-orchestrator-wedges-relaunch.md`.

### 2.1 Plan Reviewer

Given the plan and what it is trying to achieve, the `plan-reviewer` reviews the plan as a whole and pokes holes in it, with special attention to unnecessary complexity. It returns a list of remarks, or `No findings.` when it is confident the plan achieves the goal appropriately and is written so cheaper models can follow it. See `.kilo/agent/plan-reviewer.md`.

## 3. Orchestrator

The orchestrator drives the plan to completion. It is the expensive model steering cheap role agents: its output is judgment — handoffs, steering, triage, verification — not diffs. It may edit directly only for merge-conflict resolution, one-line configuration, and takeovers under the escalation ladder.

1. Ingest the handoff, verify each worktree matches its recorded branch and state (`git -C <worktree> rev-parse --abbrev-ref HEAD` and `git -C <worktree> status --porcelain` against the handoff), and read the learnings.
2. Segment the plan into slices with disjoint write sets so parallel implementers cannot collide — the plan proposes the tasks, the orchestrator owns the slicing. Always serialize: lockfile changes, dependency installs, migrations, generated clients, repository-wide formatters, and broad autofix commands. File separation is not enough when one slice changes a contract another consumes.
3. Dispatch ready independent slices to parallel `implementer`s — as many in parallel as the segmentation safely allows; agent parallelism is never capped, only E2E device/stack phases are (see E2E Slots). Loop per slice, at most five rounds: implementer implements, then a fresh `impl-reviewer` reviews the slice diff — `git add -N -- <owned paths> && git diff HEAD -- <owned paths>` (the `add -N` makes new files visible to the diff; take the reviewer's pre-round snapshot **after** it, since it changes status output) written to a scratch file passed via `--file`, since parallel slices share the worktree; triage remarks (untrusted), route valid ones through a repair dispatch. Exit the loop when a fresh reviewer returns `No findings.`, or when its only remaining findings are already rejected in `$SCRATCH/decisions.md` and cite no evidence the rejection did not consider. At the round cap the remaining moves are takeover or BLOCKED (see Escalation).
4. Create small logical commits at slice boundaries, staging only the slice's owned paths (`git add -- <owned paths>`, never `git add -A` while other slices are mid-flight). Once every slice has landed, run the synchronization point: the deferred project-wide checks (typecheck and each changed repository's own check commands) — then, and again after any later repair or direct orchestrator edit, dispatch one fresh `impl-reviewer` over the cumulative section diff (`git diff origin/main...HEAD`, plus any uncommitted changes), so integration seams, takeovers, and merge resolutions never ship unreviewed.
5. Create the PR — use the repository's PR template when one exists, with the human-readable **what / why / how** narrative inside its summary section, and verification evidence (verifier screenshots and flow results, pulled from reports before scratch cleanup) where the template asks for it — assign it to the requesting human, and pick the reviewers yourself (see Picking Reviewers). When the section spans multiple repositories, use the same branch name in each, open one PR per repository, cross-link them, and hold every one to the completion gate. CI and Kilobot start running concurrently with E2E.
6. Run the E2E loop (below) when the work has verifiable runtime behavior; skip it for doc-only or equivalently inert changes, recording why in the PR description.
7. Run the Kilobot loop (below).
8. When both loops are clean, verify the completion gate, label the PR `human-ready` (`gh pr edit <n> --add-label human-ready`) as the last act before teardown, then shut the section down. The PR is the deliverable; everything else closes.

Two terminal states, distinguished by what remains on disk:

- **COMPLETE** — the gate fully holds (a PR awaiting required human review is COMPLETE). Release every held resource (local backends, simulators, emulators, browsers, slots), delete the scratch directory, and close its own tmux window (`tmux kill-window`). Nothing survives but the PR — its description carries everything a human needs; material process notes (E2E skips with rationale, simpler-shape decisions) belong in it.
- **BLOCKED** — something made the gate unsatisfiable. Release every resource all the same, write `$SCRATCH/final-report.md` — first line `BLOCKED`, then the blocker, PR link and state, acceptance-criteria outcomes, takeovers with justifications, rejected findings, learnings written — leave the scratch directory as evidence, and close the window.

### Picking Reviewers

There is no fixed reviewer list. Work out who fits this PR from what the repository already shows, using two sources:

1. **The files.** For the two or three files the PR changes most, list recent commits — `git log -10 --format='%H' -- <path>` — and for each commit find its PR and that PR's reviewers:

```bash
gh api repos/<owner>/<repo>/commits/<sha>/pulls --jq '.[].number'
gh pr view <number> --json reviews --jq '.reviews[].author.login'
```

2. **The human.** Do the same for the requesting human's last ten merged PRs, to see who usually reviews their work:

```bash
gh pr list --author <handle> --state merged --limit 10 --json number --jq '.[].number'
gh pr view <number> --json reviews --jq '.reviews[].author.login'
```

Count how often each name appears across both lists. Drop bots and the requesting human. Request the top one or two: `gh pr edit <number> --add-reviewer <login>`. If both lists come out empty — new area, no history — request nobody and say so in one line in the PR description; Kilobot and the assignee still review it.

### E2E Loop

1. Dispatch a fresh `e2e-verifier` with the plan goals and acceptance criteria, in its own uniquely named tmux session (see Dispatching). Never dispatch one while implementers are active or uncommitted changes sit in an in-scope worktree — the verifier's byte-identical baseline restore turns concurrent edits into false failures. The verifier acquires its own device slot under that session name and releases it the moment its device phase ends; the orchestrator never holds a slot on the verifier's behalf. If a verifier round dies or is killed, clean up its leftovers per the runbook's cleanup section before redispatching — a crashed verifier never ran its own.
2. Act on the sentinel: `VERIFICATION FAILED.` → triage each remark (untrusted) and run the implementer → impl-reviewer loop to fix it, commit and push. `VERIFICATION BLOCKED.` → one environment recovery attempt and a fresh dispatch; if it blocks again, the section is BLOCKED.
3. Re-verify — a follow-up verifier round re-tests only the touched behavior, not the whole plan.
4. Exit when a fresh verifier returns `VERIFICATION PASSED.` for the plan's goals. After five rounds without one, the remaining moves are takeover or BLOCKED (see Escalation).

### Kilobot Loop

1. Wait for Kilobot to review the latest head (`gh pr view <n> --json statusCheckRollup,mergeable,mergeStateStatus`; thread state is GraphQL-only — exact queries and the reply/resolve mutations are in `learnings/github-pr-review-threads-api.md`). Kilobot can crash: after about 20 minutes without a review, retrigger it (`git commit --allow-empty -m "chore: retrigger review" && git push`, or a `(bot) @kilocode-bot please review` PR comment), then resume waiting. After two failed retriggers, stop waiting: post `(bot) Kilobot posted no approving summary on this head after two retriggers` on the PR and treat the gate's Kilobot item as waived — the pending human review covers it. A green `Kilo Code Review` check only says the review finished; it carries no verdict. The clean state is a Kilobot summary comment on the current head that approves it (`gh pr view <n> --json comments` — read the verdict the comment states, do not match an exact string; bot wording drifts) plus zero **unresolved** review threads. A green check with no approving summary is not a clean head: keep waiting, then retrigger.
2. For each comment: verify it (untrusted), then route valid findings through the implementer → impl-reviewer loop; commit, push, reply in the thread, and resolve it. Invalid finding: reply with technical evidence and do not change correct code. A fix without its in-thread reply and thread resolution is not done. Follow the repository-root `AGENTS.md` "Kilobot Review Remarks" contract.
3. Comments already posted by other reviewers — bots or humans — get the same triage flow, but never wait for anyone except Kilobot to review or re-review.
4. CI failures are findings too: route the fix through the implementer loop; rerun a flaky check once (`gh run rerun <id> --failed`); a check still failing after two fix rounds makes the section BLOCKED.
5. Rerun E2E for any repair that affects verified behavior (touched bits only). Three full E2E↔Kilobot alternations without converging is BLOCKED.
6. Exit when Kilobot has posted an approving summary comment on the latest head — or its absence was waived per step 1 — no actionable posted comment is unresolved, and CI is green.

Integrate the base branch **only when GitHub reports an actual conflict** (`mergeable: CONFLICTING`) or the run needs something that landed on the base. Integrate by merge, not rebase — `git fetch origin && git merge origin/main` — with the orchestrator resolving conflicts itself (its merge-conflict direct-edit allowance). Rebasing a conflict-free branch invalidates green CI and a completed Kilobot review for nothing. `mergeStateStatus: BLOCKED` on a `MERGEABLE` PR means a required human review is pending — that is the expected terminal state, not a problem to solve.

### Completion Gate

The work is complete only when every item holds:

- All accepted plan tasks are implemented, with automated coverage for every applicable feature state
- A fresh impl reviewer has cleared the cumulative section diff (step 4), including any repair or orchestrator edit since
- A fresh E2E verifier returned `VERIFICATION PASSED.` for the plan's goals — or E2E was skipped as inert, with the rationale in the PR description
- Changes are organized into small, coherent commits; format, typecheck, lint, and tests pass in every changed repository, using the check commands the nearest `AGENTS.md` or `package.json` defines for each changed package
- The PR exists with what/why/how sections and is assigned to the requesting human
- Kilobot has posted an approving summary comment on the latest head and no actionable posted comment is unresolved — or Kilobot's absence after two retriggers is noted in a `(bot) ` PR comment
- All expected CI checks on the latest head are green, and GitHub reports the head mergeable with no conflicts
- No generated fixture remains, tracked or untracked; every verifier temporary edit is restored
- Every resource this run started is shut down or released; resources the run did not start stay running
- New committed learnings are included in the PR
- The PR carries the `human-ready` label, added only after every item above holds

A PR waiting on required human review is COMPLETE — the workflow never approves or merges its own PR. A gate item that can never hold is BLOCKED (see step 8), never a reason to loop forever or fake completion.

### 3.1 Implementer

Implements one bounded slice per the plan and the handoff, runs narrow checks on what it changed, and never commits. See `.kilo/agent/implementer.md`.

### 3.2 Impl Reviewer

Independently reviews the slice diff against the plan's goals for that slice. Read-only. See `.kilo/agent/impl-reviewer.md`.

### 3.3 E2E Verifier

Verifies that the goals of the plan are met by the new implementation. It starts local services and points local clients at them, following the surface-specific runbook (mobile: `apps/mobile/e2e/AGENTS.md`; extension: `apps/extension/AGENTS.md`; web and services: `DEVELOPMENT.md` and the repository dev runner). Everything is verified fully locally. It also writes learnings (see Learnings). See `.kilo/agent/e2e-verifier.md`.

#### Real LLM Responses

Any step where an agent or LLM must actually respond — cloud-agent sessions, chat flows, acceptance states — uses real model calls on `kilo-auto/efficient` (the in-app id; `kilo/kilo-auto/*` are the same models as CLI ids), always. If an `efficient` call stalls or errors, retry on `efficient`; never switch models. LLM mocking (fake-llm or otherwise) is prohibited unless a real call cannot produce the required state; each use must be named and justified in the handoff and the PR. One standing exception qualifies: forcing a specific provider failure.

## E2E Slots

The machine is shared by parallel workflows, and unslotted device or stack work overloads it. Only E2E runs are capped — agents themselves are never capped. Every phase that drives a simulator, emulator, local backend stack, browser fleet, or native build — the repro gate and every E2E round — runs inside a slot from [`e2e-slot.sh`](e2e-slot.sh) (default 3, machine-global):

```bash
.kilo_workflow/e2e-slot.sh acquire <tmux-session>   # blocks until a slot frees
.kilo_workflow/e2e-slot.sh status                   # holders, their worktrees, stack coverage
.kilo_workflow/e2e-slot.sh release <tmux-session>   # the moment the device phase ends
.kilo_workflow/e2e-slot.sh stacks [--reap]          # stacks running with no slot
```

**A slot and a dev stack are the same resource.** The slot is what entitles a worktree to run a stack, and a stack must never outlive it: `release` stops the releasing worktree's stack, and reclaiming a dead holder's slot stops its stack too. So a later round re-acquires and starts a fresh stack rather than inheriting one — that restart is the price of the cap. A stack up with no slot is a defect, not a shortcut; `stacks` lists them and `stacks --reap` stops the workflow-owned ones (a stack with no section run id in its name was started by hand and is only reported). Five live stacks on this host drove the load average past 300 and made every emulator boot and native build time out, which reads as flaky devices rather than as over-subscription.

- Slot state lives in `$HOME/.cache/kilo-e2e-slots`, machine-global by design: every copy of the script — any worktree, any repository — contends for the same slots, and the script has no overrides by design. When working in a repository without the script (a sibling like `~/Projects/kilocode`), invoke it by absolute path from a cloud worktree.
- This holds on every run, not only when another workflow is visibly active, and a stack that is already up is not an exemption.
- `acquire` blocking is correct behavior, never a wedge to route around and never a reason to start device work unslotted. If an acquire is still blocked after about 45 minutes, the dispatcher inspects `status` for a wedged foreign holder and reports a blocker instead of waiting forever.
- The slot caps load, not data: postgres and redis containers are shared across worktrees. Keep test data keyed to this worktree's accounts (the runbooks' per-worktree defaults) and never wipe shared state.
- Release immediately when the device/stack phase ends. Planning, implementation, review, checks, and CI waits are uncapped; never hold a slot through them — and since release takes the stack with it, do not release mid-round while you still need the services.
- Slots are owned by tmux session name, record the worktree that took them, and are reclaimed automatically when the session dies. A holder that is alive but wedged belongs to its own workflow's monitor — never kill another session to free a slot; if the queue is starved by a foreign wedge, report a blocker to the user instead.
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
- Everything else goes to the section worktree's `.kilo_workflow/learnings/` and is committed — the orchestrator includes new learnings in the run's PR (they reach other runs once merged; that lag is accepted). Committed promptly, not at the end: an uncommitted learning blocks E2E dispatch (see E2E Loop) and is one stray cleanup away from vanishing. The planner cannot commit (the orchestrator owns Git), so a planner-authored learning is named in the orchestrator handoff as work for the first commit.
- `.kilo_workflow/` is exempt from section disjointness — any section may write learnings or fix this document; overlaps resolve as ordinary merge conflicts.
- Role agents whose rules forbid dirtying the tree (the E2E verifier's byte-identical baseline restore) write their learnings to `$SCRATCH/learnings/` instead and list them in their report; the orchestrator moves them into `.kilo_workflow/learnings/` and commits them.
- Read before writing: when an existing entry covers the blocker, update it instead of appending a duplicate. When a run proves an entry wrong or stale, fix the entry in the same run.
- Every role records blockers it resolves, immediately after resolving them.
- Never keep a workflow learning only in a harness's private memory; it belongs in these folders so runs on other harnesses can use it.
- The same rule applies to this document: when a run stumbles on something `WORKFLOW.md` could have prevented — a missing command, an ambiguous rule, a wrong assumption — the orchestrator fixes the document in the same run and ships the fix with the PR. Role-definition fixes from a kilo session go through shell (`cat > .kilo/agent/<name>.md <<'EOF'`) because kilo's edit tool blocks `.kilo/` paths (see `learnings/kilo-edit-tool-blocks-kilo-config-paths.md`). Mistakes that recur are workflow bugs, not agent bugs.

## GitHub Communication

Every GitHub issue comment, PR comment, review comment, review body, and thread reply written by this workflow begins exactly with `(bot) `, including replies to Kilobot and rejections of findings. Only the PR title and PR description carry no prefix.
