# Kilo Workflow

A general-purpose multi-agent delivery workflow for this repository. Use it when the user asks to run "the kilo workflow" on a body of work. It applies to any product surface — web, mobile, extension, Workers, services, shared packages — and plans may also touch sibling repositories such as `~/Projects/kilocode`.

Pipeline: **starter → planner(s) → orchestrator → implementer/reviewer loops → E2E verification → PR**.

The definitions for every kilo CLI role live in the repository root `.kilo/agent/` — `starter`, `planner`, `orchestrator`, `plan-reviewer`, `implementer`, `impl-reviewer`, `e2e-verifier` — because the kilo CLI only discovers agents from `.kilo` directories. Everything else about the workflow — this document, the dispatch and slot scripts, and committed learnings — lives in `.kilo_workflow/`.

## Ground Rules

These apply to every role. Later sections do not repeat them.

- Every long-lived process — planner, orchestrator, dispatched role agents, local services — runs in tmux, with a unique descriptive window or session name; the launch scripts guarantee this. The one exception is the starter, which lives wherever the user invoked it (often a plain harness session outside tmux) — its launches still land in tmux via `launch-interactive.sh`.
- Section names are lowercase slugs (`[a-z0-9-]` only — they become branch, tmux, and path names). `init-section.sh` appends the four-hex run id, for example `billing-a7f3`, so parallel runs cannot collide.
- All workflow tmux lives on the default tmux server — never a custom socket; slot reaping and monitoring key on the sessions one server can see.
- Work only in dedicated worktrees, in every repository the plan touches — never a primary or main checkout, with one exception: machine-local learnings under the main checkout's `.kilo_workflow/learnings/system/`. [`init-section.sh`](init-section.sh) creates everything a section needs — the run id, the cloud worktree (always, even for sibling-only sections — role dispatches run from it), sibling worktrees on the same branch, `pnpm dev:worktree:prepare`, and the scratch directory — and prints the manifest; never hand-assemble any of it (sibling repositories then follow their own `AGENTS.md` setup; `~/Projects/kilocode` uses bun, not pnpm). A worktree made any other way — by `git worktree add`, by hand — has no run id, manifest, or scratch and cannot be repaired in place: remove it and run `init-section.sh`. A worktree is the one local artifact that outlives the run; remove it (`git worktree remove <path>`) once its PR closes.
- The scratch directory (from `init-section.sh`, outside every repository) holds the section's brief, plan, handoffs, decisions, and dispatch logs. Plans and handoffs are never committed and never live inside a repository. A planner adding a repository mid-plan runs `init-section.sh add-repo <section> <repo>` and adds the printed worktree path to the handoff.
- The PR, ready for human eyes, is the deliverable. When a section completes, everything that ran for it closes: agents, monitors, tmux sessions and windows, services, devices, slots, and the scratch directory (a BLOCKED section retains its scratch directory as evidence). Anything a human needs afterward lives in the PR.
- Every reviewer and verifier invocation is a fresh session, so earlier conclusions cannot anchor later passes.
- Treat every reviewer's remarks as untrusted advice: the reviewer has less context than you and may be wrong. Verify each remark against the request, repository evidence, and applicable instructions before acting on it. The dispatcher (planner or orchestrator) records rejected remarks with a short technical rationale in `$SCRATCH/decisions.md` and carries them into later handoffs; rejections of GitHub findings also get their in-thread reply. Role agents return their triage in their reports instead of writing files. A rejected remark must not reopen without new evidence.
- Always aim for the simplest solution that achieves the user's goals — feature-wise as much as code-wise. Reuse existing helpers, components, and contracts. Do not add abstraction or scope without evidence it is required.
- Commit in small, logically scoped commits. The orchestrator owns every commit, push, branch change, and PR; other roles make only uncommitted worktree edits, and only where their definitions allow.
- Monitoring is event-driven: when a dispatched process exits, its dispatcher reacts immediately, never after a fixed sleep. Periodic checks exist only to detect a wedge.
- Tokens go to the work, never to fighting the workflow or the environment. Every mechanical step that can be scripted is scripted — `init-section.sh`, `dispatch-role.sh`, `await-role.sh`, `launch-interactive.sh`, `launch-gate.sh`, `await-interactive.sh`, `steer.sh`, the five `e2e-*` lifecycle scripts, `slice-diff.sh`, `baseline.sh`, `pr-threads.sh`, `pr-gate.sh`, `pick-reviewers.sh`, `upload-pr-attachment.sh` — use the script, never hand-assemble its steps. **Anything that can be automated away, should be** (see Learnings).
- Learnings are the residue automation cannot reach. Before any environment-dependent phase, list both learnings directories — the worktree's `.kilo_workflow/learnings/` and the main checkout's `~/Projects/cloud/.kilo_workflow/learnings/system/` (the canonical machine-local set, which mid-run writes go to and worktree copies lag) — and read the entries whose names match your surface; filenames are symptom-keyed. When a tool or environment failure blocks you mid-run, grep both directories for the error text before debugging from scratch: a prior run has usually already paid for the answer.

### Models

| Role | Harness | Model | Steps |
|---|---|---|---|
| Starter | user picks | `kilo/x-ai/grok-4.5`, high (user may override at launch) | unlimited |
| Planner | user picks | `kilo/moonshotai/kimi-k3`, high (user may override at launch) | unlimited |
| Plan reviewer | kilo CLI | `kilo/x-ai/grok-4.5`, high | 40 |
| Orchestrator | kilo CLI | `kilo/x-ai/grok-4.5`, high | unlimited |
| Implementer | kilo CLI | `kilo/kilo-auto/efficient` | 80 |
| Impl reviewer | kilo CLI | `kilo/x-ai/grok-4.5`, high | 50 |
| E2E verifier | kilo CLI | `kilo/x-ai/grok-4.5`, high | 100 |

Every kilo-CLI role above has a definition in `.kilo/agent/` (including `starter`, `planner`, and `orchestrator`) pinning its permissions and its model and step limit. The definition is authoritative: dispatches pass `--model`/`--variant` only for the starter and planner, where the user may override the pinned model at launch. Never use `kilo/kilo-auto/free` — it is rate-limited. Not even as a fallback: if a call stalls or errors, retry or relaunch on the assigned model, never a different one. Product-side LLM calls in E2E flows follow "Real LLM responses" below.

### Step Limits

The kilo role-agent step limits above are hard ceilings pinned in the agent definitions. For the step-limited roles, size every handoff below 75% of the role's limit — estimate roughly one step per planned tool call; an implementation slice should fit in roughly 60 planned steps. Unlimited roles rely on stopping rules instead. Never raise a limit to fit an oversized task — split the task.

### Dispatching Kilo Role Agents

Dispatch worker role agents with [`dispatch-role.sh`](dispatch-role.sh) — it encodes the whole contract (tmux wrapping, env strip, naming, redirection, the `EXITCODE` marker) so nothing is hand-assembled:

```bash
LOG=$(.kilo_workflow/dispatch-role.sh plan-reviewer <section> r1 <cloud-worktree> "$SCRATCH" \
  "Review the plan in the attached handoff per your role definition." \
  --file "$SCRATCH/handoff.md")
```

The cwd/worktree is always the **cloud** worktree, even when the slice edits a sibling repository — the role definitions in root `.kilo/agent/` are only discovered there, and they pin the model, so worker dispatches never pass `--model`/`--variant`. The message is a short literal; file content — handoffs, plans, diffs — always travels via `--file <path>` (repeatable), never inlined with `"$(cat file)"`: dispatches routed through a tmux command string get re-parsed by another shell, and backticks inside the file then execute as shell commands.

What the script encodes (details in its header comments):

The script prints the log path for `await-role.sh`; it guarantees tmux wrapping (a dispatcher outside tmux gives the role its own session), unique per-dispatch names and logs, and the redirection + `EXITCODE` marker the await script judges.

- Full `KILO_*`/`OPENCODE*` env strip — a child kilo inheriting `KILO_*`/`OPENCODE*` (from a parent kilo or the tmux server environment) misattaches sessions and auth. If the tmux server itself is poisoned, clear it with `tmux set-environment -g -u <var>`.
- `--auto` on every dispatch — a plain `kilo run` auto-rejects any permission ask (some paths ask regardless of what the agent definition grants) and still exits 0 with no verdict, which reads as a pass. Never strip the flag; any non-interactive `kilo run` outside `dispatch-role.sh` must pass it explicitly.

Wait with [`await-role.sh`](await-role.sh) — never a hand-rolled loop (exit codes lie, whole-log sentinel greps false-pass on quoted sentinels, and a stalled run never writes its marker):

```bash
.kilo_workflow/await-role.sh "$LOG"   # blocks up to 8 minutes, prints exactly one line
```

Act on that line:

- `DONE <sentinel>` — the round's verdict, taken from the only place a verdict counts (the line above the `EXITCODE` marker). Sentinels: reviewers `No findings.` / `FINDINGS: <n>`; implementer `SLICE COMPLETE.`; verifier `VERIFICATION PASSED.`/`VERIFICATION FAILED.`/`VERIFICATION BLOCKED.` (repro mode: `REPRODUCED.`/`CANNOT REPRODUCE.`/`VERIFICATION BLOCKED.`); any role `STOPPED EARLY.` — not a failure but not success: re-dispatch with a continuation handoff, and it counts toward the loop's round cap.
- `RUNNING` — invoke it again. Each re-invocation is also the moment to unstick **infrastructure failures only**: a wedged or crashed kilo CLI, a dead tmux window, a hung service the agent cannot restart itself. Product, logic, or review problems are never stuck states — route those through the escalation ladder.
- `VOID` — the run ended with no valid verdict for its role (kilo runs can die mid-stream and still exit 0). Never a pass: discard the round and dispatch a fresh session. If several consecutive rounds die at the same point, shrink the handoff rather than retrying it unchanged.
- `STALLED` — the stall that never exits. Kill the round's tmux window/session, verify state from artifacts on disk (never the dead run's claims), and redispatch fresh with a continuation handoff.

Two checks stay with the dispatcher, since only it knows the slice — both are one `slice-diff.sh --check` call, which judges the round itself and prints `OK` or `VIOLATION`:

```bash
.kilo_workflow/slice-diff.sh --check reviewer    "$SNAP" <worktree> "$SCRATCH/<slice>.diff" -- <owned paths>   # after a reviewer round: nothing may have changed
.kilo_workflow/slice-diff.sh --check implementer "$SNAP" <worktree> "$SCRATCH/<slice>.diff" -- <owned paths>   # after an implementer round: no commit on the owned paths (edits expected)
```

`$SNAP` is the `SNAPSHOT=...` line printed by the emit made immediately before that same round — every round gets its own emit (for a reviewer round the emit doubles as the diff under review); never reuse a snapshot across rounds. A `VIOLATION` voids the round. Void rounds count toward the loop's round cap; after two consecutive voids shrink the handoff, and three consecutive rounds voided by either check — await-`VOID` or `VIOLATION` — are an infrastructure blocker (auth wedge, provider outage): stop redispatching, and the loop's remaining moves are takeover or a BLOCKED section.

Role boundaries — reviewers never modify the tree, the implementer never commits, no role dispatches agents — are enforced by instruction, not permission. This is deliberate: permission deny lists caused void review rounds (a reviewer whose blocked command made it exit with no verdict, which read as a pass) and takeover churn. The single exception is `task: deny` in the definitions — blocking agent dispatch costs nothing and cannot void a round. The workflow otherwise trades enforcement for reliable rounds and accepts that a misbehaving agent can do what it was told not to; do not "fix" this by re-adding deny lists.

### Steering a Live Interactive Session

Worker roles are steered by re-dispatching them (see Escalation). The interactive sessions — starter, planner, orchestrator — are steered in place with [`steer.sh`](steer.sh), never with hand-assembled `tmux send-keys`:

```bash
.kilo_workflow/steer.sh <section>-orchestrator "Scope change: drop slice 4; commit what holds and open the PR."
printf '%s' "$AMENDMENT" | .kilo_workflow/steer.sh <section>-orchestrator -   # long or multi-line text via stdin
```

It prints `running` when the session took the message immediately and `queued` when the message is waiting behind the active turn; either way it is delivered. A non-zero exit means it is **not** delivered — inspect the target rather than sending a second copy. Delivery mechanics (Enter as its own keystroke, bracketed paste, non-kilo-pane refusal, pane-confirmed delivery) are enforced by the script — see its header.

**`N queued` in the footer is delivery working, not a wedge.** Queued messages land one at a time at turn boundaries, in order, and a session that chains tool calls for tens of minutes holds the whole queue that entire time. Never kill, relaunch, or escalate on a queue count; a wedge needs its own evidence (frozen build timer, stream or api error, dead process — see Monitor Mode). `Escape` does not flush the queue.

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
- For any device or stack phase: the slot-bundle owner, resources, cleanup owner, and the platform scope — exactly one of `none`, `ios`, `android`, `ios+android` — plus its rationale (`N/A — default` is enough for `none`/`ios`) and the exact start command from the E2E Loop scope table
- Continuation and re-verify handoffs restate the same platform scope, rationale, and start command (or `unchanged from round N`)
- Prior findings being addressed, including rejected findings that must not reopen without new evidence
- Priority order, minimum complete outcome, optional work to drop, and a clean stopping rule before budget exhaustion (estimate roughly one step per planned tool call; when in doubt, split the task); on early stop, the required continuation state (completed work, remaining work, failures, files touched, checks run or deferred, safest next action)
- For long tool-heavy phases: output discipline — cap every shell command's output (`| tail -c 1500` / `| tail -5`), write dumps and captures to files and print only greps or counts, bound the final report. Oversized session payloads kill kilo runs silently mid-task.
- The GitHub comment rule (see GitHub Communication)
- Fixture rule: never commit generated E2E fixtures; create them in a temporary directory and clean up before returning. Save every sanctioned temporary worktree edit (stub fixtures, test patches) as a patch file under `$SCRATCH` and name it in the report — Edit-tool entries in a dispatch log are not recoverable state (terminal echo corrupts the logged diff, so it does not `git apply`)
- For E2E verifier rounds: reusable flow scripts and assertions go in `$E2E_ARTIFACTS` (section scratch `e2e-artifacts/`, injected by `dispatch-role.sh`), named `<platform>-<case>.js` as the handoff assigns. Continuation handoffs carry the path. A later verifier evaluates prior artifacts before reusing them — they are evidence, not truth. Baselines and temp files stay in the unique per-round `$SCRATCH`.

Write handoffs to temporary files outside every repository, and never ask a role agent to infer context from a conversation it cannot see.

## 1. Starter

The session the user invokes the workflow from is the starter. A kilo starter defaults to its
agent definition's pinned model and launches as `kilo run --agent starter --interactive`; pass
`--model` and `--variant` only for an explicit user override. The definition pins its permissions.
Its job is to turn a raw request into approved, sectioned work:

1. Collect the initial body of work from the user, and ask exactly one process question: is this run `hands on` or `hands off`? The mode governs every later role. Planner model: default to the planner agent definition's pinned model (`kilo/moonshotai/kimi-k3`, high). Only use the starter's own model or another explicit user pick when the user specifically requested a different planner model; do not reuse the starter's model by default.
2. Explore the relevant parts of the codebase.
3. Interrogate the requirements — in `hands on` mode, load the `grilling` skill and follow its contract: inspect the codebase instead of asking anything the repository can answer, then ask the user one remaining question at a time with a recommended answer. In `hands off` mode, apply the same questions to itself, answer from repository evidence, and record material assumptions. Always drive toward the simplest solution that achieves the user's goals, and challenge the request itself: "should we even do this?", "why not do this instead?", "we could achieve the same thing simpler, like this".
4. Divide the finalized work into related, **disjoint** sections — no two sections may touch the same files or contracts.
5. For each section: run `.kilo_workflow/init-section.sh <name> [sibling-repo...]` (Ground Rules) and use the manifest it prints, write the section brief to `$SCRATCH/brief.md` — the work, the mode, acceptance criteria and constraints gathered so far, the requesting human's GitHub handle for PR assignment, the worktree path, and the scratch path — and launch a planner on the planner harness and model with [`launch-interactive.sh`](launch-interactive.sh). The script encodes the launch traps (env strip, TTY, tmux targeting — details in its header), lands the window in your own session when you are inside tmux and a fresh session otherwise, prints the tmux target for `steer.sh` and `capture-pane`, and fails loudly if the command dies at launch:

```bash
# kilo planner (defaults to the planner agent definition's pinned model; pass --model/--variant only for an explicit user override):
.kilo_workflow/launch-interactive.sh <section>-planner <worktree> --log "$SCRATCH/planner.log" \
  kilo run 'Plan the work in the attached brief.' --agent planner \
  --interactive --title '<section> planner' --file "$SCRATCH/brief.md"
```

One planner per section; each section flows through its own planner, orchestrator, and PR. A single-section run launches a single planner. If the starter's own session already fits the planner role (right model, user agrees), it may become the single planner itself instead of launching one — only when the starter already runs inside tmux on the default server: the repro gate's slot scripts refuse to run outside tmux, and a starter-turned-planner has no separate monitor to relaunch it. After launch, the starter follows Monitor Mode below for its planners until every section reaches a terminal state.

### Interaction Modes

- `hands on`: ask the user one question at a time until requirements, trade-offs, and acceptance criteria are unambiguous. The planner later gets explicit user approval of the plan before launching the orchestrator. After the handoff, user questions belong to the orchestrator — it asks directly in its interactive session when a repair loop or ambiguity cannot be resolved. Hands-on assumes the user can attach to the reported tmux windows; a question unanswered after a bounded wait (hours, not minutes) becomes a BLOCKED report, and a session waiting on one is not a wedge.
- `hands off`: after mode selection, never ask the user a question and never wait for approval — treat all approvals as granted. Answer open questions from repository evidence and record material assumptions in the plan and handoff. Stop only when continuing is technically impossible or unsafe, and return a precise blocker report instead of a question. Hands-off mode does not bypass tool permissions, repository safety rules, or the completion gate.

## 2. Planner

The planner writes the implementation plan for its section. The plan is consumed by the orchestrator, implementers, and reviewers — all cheaper models — so it must:

- Fulfil the assigned body of work
- Be written in simple, explicit language a cheaper model can follow without guessing
- Achieve the work in the simplest, most maintainable way

Steps:

1. Read the learnings. For defect work, dispatch the bug reproduction gate FIRST (below). Explore the relevant parts of the codebase. Define acceptance criteria, non-goals, and the feature-state matrix for any user-facing feature.
2. Write the complete draft plan to `$SCRATCH/plan.md`. For defect work, do not finalize it before the repro verdict is in — the confirmed reproduction feeds the plan, and `CANNOT REPRODUCE.` stops it (see the gate).
3. Loop, at most five rounds: dispatch TWO fresh `plan-reviewer`s in parallel (they cannot anchor each other — union their findings), verify the remarks (untrusted), fix valid ones, record rejected ones. Exit when a round returns `No findings.` from both. If three consecutive rounds stay stuck on the same issue — or the five-round cap is hit — resolve the remaining findings directly, record each resolution in `$SCRATCH/decisions.md`, and dispatch one final fresh reviewer (outside the cap). If that final reviewer still objects, do not loop again: record the disagreement and proceed with the recorded resolution (hands-on: ask the user instead).
   The planner ends its own run the same way the orchestrator does: a blocker it cannot pass (a failed repro gate, an unresolvable hands-off gap) is written to `$SCRATCH/final-report.md` with first line `BLOCKED` — never a silent stop.
4. Hands-on: get explicit user approval of the plan. Hands-off: self-approve.
5. Create a worktree for any repository the plan turned out to touch that lacks one (Ground Rules) — before orchestrator launch, every in-scope repository has a worktree path in the handoff. Write the sanitized orchestrator handoff to `$SCRATCH/handoff.md` (see Handoff Requirements, plus: the plan path, the scratch directory path, the final review result, any simpler-shape decision and its reasoning, and the completion gate with a direct instruction to continue until the PR is mergeable with green CI and an approving Kilobot summary). Launch the orchestrator, then switch to monitor mode.

### Bug Reproduction Gate

For defect work, the planner takes one slot and starts the whole required E2E bundle only when the repro dispatch is imminent, then dispatches a fresh `e2e-verifier` in repro mode on the unmodified baseline as its FIRST act. The default platform scope is iOS-only (`e2e-start-resource.sh bundle --ios-only`) unless the defect is platform-specific. The verifier runs while the planner explores and drafts. Dispatch with `--mode repro` (label `r0`; see Dispatching); the flag pins the sentinel contract, and the handoff names the planner as bundle owner. Its assignment: reproduce the reported issue — fix nothing — and return exact reproduction steps, evidence, and a failure classification. After the verdict, the planner stops every bundle resource and frees the slot. A confirmed reproduction feeds the plan, and the confirmed repro flow passing becomes an acceptance criterion the final verifier must rerun.

A `CANNOT REPRODUCE.` sentinel is a blocker, not a license to fix an unconfirmed bug. Hands-on: return the evidence to the user and ask how to proceed. Hands-off: stop with a BLOCKED report — no plan, no orchestrator. `VERIFICATION BLOCKED.` means the environment prevented a verdict: make one reasonable environment recovery and dispatch one fresh repro verifier; a second blocked result makes the section BLOCKED.

### Launching the Orchestrator

```bash
.kilo_workflow/launch-interactive.sh <section>-orchestrator <worktree> --log "$SCRATCH/orchestrator.log" \
  kilo run 'Execute the approved plan in the attached handoff. Own implementation through the completion gate.' \
  --agent orchestrator --interactive --title '<section> orchestrator' --file "$SCRATCH/handoff.md"
```

The `orchestrator` agent definition pins the model and permissions, so the launch passes neither. Do not add `--continue` or `--session`; the orchestrator must be a fresh session. The script preserves the TTY that `--interactive` requires, verifies the session survived launch, and prints the tmux target — report that target, the worktree path, and the handoff path. Always pass `--log "$SCRATCH/orchestrator.log"` (before the command): Monitor Mode needs the transcript to tell a wedge from work.

### Monitor Mode

After the handoff the planner stops all hands-on work. It has exactly one job — relaunch or unstick the orchestrator when infrastructure fails (a crashed kilo CLI, a dead tmux window, a hung service). Product, logic, design, and review problems are the orchestrator's, handled by its escalation ladder. (The starter monitors its planners under these same rules.) Watch with [`await-interactive.sh`](await-interactive.sh) — it reads the scratch-directory state machine and reports one line per invocation:

```bash
.kilo_workflow/await-interactive.sh <tmux-target> "$SCRATCH" --log "$SCRATCH/orchestrator.log"   # blocks up to 25 min
```

- `COMPLETED` — scratch gone; confirm the PR is in gate state (below) and close yourself.
- `BLOCKED <report>` — relay the report to the user, leave the scratch directory alone, close yourself.
- `DEAD` — a crash; relaunch fresh with a continuation handoff (below).
- `QUIET <sec>s` — the transcript stopped moving. Not a verdict: read the pane first (below) — a hands-on user question and queued steers look exactly like this.
- `RUNNING` — invoke it again.

A monitor never kills a live dispatch on a judgment call, edits the worktree, or writes to another role's dispatch log. Before concluding an orchestrator is misbehaving, read its pane scrollback (`tmux capture-pane -t <window> -p -S -`), scratch directory, and git log. The only kill-worthy states are the infrastructure failures named above.

On `COMPLETED`, confirm the PR exists in gate state in **every** repository the section touched — `.kilo_workflow/pr-gate.sh <owner/repo> <pr> --assignee <requesting-handle> --label human-ready` per repository (find the PR with `gh pr view <section> --repo <owner>/<repo>`; never bare `gh pr view`, which only checks the cloud branch). A missing PR or a failing gate means it was not a completion — treat it as a crash.

On `QUIET`, read the pane (`tmux capture-pane -pJ -t <target>`) before acting. A session waiting on a hands-on user answer is not wedged, and neither is one holding queued steers (see Steering a Live Interactive Session). Real wedge evidence: a provider or stream error in the pane, a frozen build timer, a repeated hard SDK error. Long kilo runs die on provider stream stalls, and `--interactive` sessions can wedge on provider errors — kill only on that evidence.

Relaunch a dead or wedged orchestrator as a **fresh session** (never `--continue`) with a continuation handoff: the original handoff plus everything observably done so far — commits, PR state, passed rounds, held resources — assembled from `git log`, the PR, and the dispatch logs, so the new session verifies rather than redoes. Distrust the dead session's unevidenced claims. After three consecutive relaunches with no new progress, stop and write the BLOCKED report yourself — the same rule bounds the starter's planner relaunches. See `learnings/kilo-interactive-orchestrator-wedges-relaunch.md`.

### 2.1 Plan Reviewer

Given the plan and what it is trying to achieve, the `plan-reviewer` reviews the plan as a whole and pokes holes in it, with special attention to unnecessary complexity. It returns a list of remarks, or `No findings.` when it is confident the plan achieves the goal appropriately and is written so cheaper models can follow it. See `.kilo/agent/plan-reviewer.md`.

## 3. Orchestrator

The orchestrator drives the plan to completion. It is the expensive model steering cheap role agents: its output is judgment — handoffs, steering, triage, verification — not diffs. It may edit directly only for merge-conflict resolution, one-line configuration, and takeovers under the escalation ladder.

1. Ingest the handoff, verify each worktree matches its recorded branch and state (`git -C <worktree> rev-parse --abbrev-ref HEAD` and `git -C <worktree> status --porcelain` against the handoff), and read the learnings.
2. Segment the plan into slices with disjoint write sets so parallel implementers cannot collide — the plan proposes the tasks, the orchestrator owns the slicing. Always serialize: lockfile changes, dependency installs, migrations, generated clients, repository-wide formatters, and broad autofix commands. File separation is not enough when one slice changes a contract another consumes.
3. Dispatch ready independent slices to parallel `implementer`s — as many in parallel as the segmentation safely allows; agent parallelism is never capped, only E2E device/stack phases are (see E2E Slots). Loop per slice, at most five rounds: implementer implements, then a fresh `impl-reviewer` reviews the slice diff, produced with [`slice-diff.sh`](slice-diff.sh) (parallel slices share the worktree, so the reviewer gets a diff file via `--file`, never the whole tree):

```bash
.kilo_workflow/slice-diff.sh <worktree> "$SCRATCH/slice-api.diff" -- <owned paths>   # prints SNAPSHOT=<head>:<hash>
```

   Keep the `SNAPSHOT` line; after the round, `slice-diff.sh --check reviewer|implementer` judges it (see the dispatcher checks under Dispatching). Triage remarks (untrusted), route valid ones through a repair dispatch. Exit the loop when a fresh reviewer returns `No findings.`, or when its only remaining findings are already rejected in `$SCRATCH/decisions.md` and cite no evidence the rejection did not consider. At the round cap the remaining moves are takeover or BLOCKED (see Escalation).
4. Create small logical commits at slice boundaries, staging only the slice's owned paths (`git add -- <owned paths>`, never `git add -A` while other slices are mid-flight). Once every slice has landed, run the synchronization point: the deferred project-wide checks (typecheck and each changed repository's own check commands) — then, and again after any later repair or direct orchestrator edit, dispatch one fresh `impl-reviewer` over the cumulative section diff (`git diff origin/main...HEAD`, plus any uncommitted changes), so integration seams, takeovers, and merge resolutions never ship unreviewed.
5. Create the PR — use the repository's PR template when one exists, with the human-readable **what / why / how** narrative inside its summary section, and verification evidence (verifier screenshots and flow results, pulled from reports before scratch cleanup) where the template asks for it. For work with a UI, upload the screenshots to the PR per GitHub Communication before scratch cleanup — local paths are not evidence. Assign the PR to the requesting human, and pick the reviewers yourself (see Picking Reviewers). When the section spans multiple repositories, use the same branch name in each, open one PR per repository, cross-link them, and hold every one to the completion gate. CI and Kilobot start running concurrently with E2E.
6. Run the E2E loop (below) when the work has verifiable runtime behavior; skip it for doc-only or equivalently inert changes, recording why in the PR description.
7. Run the Kilobot loop (below).
8. When both loops are clean, verify the completion gate, label the PR `human-ready` (`gh pr edit <n> --add-label human-ready`) as the last act before teardown, then shut the section down. The PR is the deliverable; everything else closes.

Two terminal states, distinguished by what remains on disk:

- **COMPLETE** — the gate fully holds (a PR awaiting required human review is COMPLETE). Release every held resource (local backends, simulators, emulators, browsers, slots), delete the scratch directory, and close its own tmux window (`tmux kill-window`). Nothing survives but the PR — its description carries everything a human needs; material process notes (E2E skips with rationale, simpler-shape decisions) belong in it.
- **BLOCKED** — something made the gate unsatisfiable. Release every resource all the same, write `$SCRATCH/final-report.md` — first line `BLOCKED`, then the blocker, PR link and state, acceptance-criteria outcomes, takeovers with justifications, rejected findings, learnings written — leave the scratch directory as evidence, and close the window.

### Picking Reviewers

There is no fixed reviewer list. [`pick-reviewers.sh`](pick-reviewers.sh) ranks candidates from what the repository already shows — who reviewed recent PRs touching the same files, and who reviews the requesting human's work:

```bash
.kilo_workflow/pick-reviewers.sh <owner/repo> <requesting-handle> <file> [file...]   # run in the changed repo, on its 2–3 most-changed files
```

Request the top one or two names it prints: `gh pr edit <number> --add-reviewer <login>`. If it prints nothing — new area, no history — request nobody and say so in one line in the PR description; Kilobot and the assignee still review it.

### E2E Loop

1. The orchestrator takes one slot and starts the whole E2E bundle per the platform scope recorded in the handoff: one stack, up to one iOS simulator, up to one Android emulator, and any other resources this round needs. The default platform scope is **iOS only** (`e2e-start-resource.sh bundle --ios-only`). Dual-platform requires a recorded rationale: the change touches platform-specific paths (native modules, platform-split components, Android/iOS-only code, layout/insets work) or a prior platform-specific defect exists. The supported scopes are:

   | Scope | When | Start command |
   |---|---|---|
   | none | stack-only/backend E2E, no devices | `e2e-start-resource.sh stack ...` |
   | ios | default | `e2e-start-resource.sh bundle --ios-only` |
   | android | Android-only defect or Android-only change | `e2e-start-resource.sh stack ...` + `e2e-start-resource.sh android <avd>` |
   | ios+android | platform-specific paths touched or prior platform defect | `e2e-start-resource.sh bundle <avd>` |

    Then dispatch a fresh `e2e-verifier` with the plan goals and acceptance criteria. The verifier runs inside the assigned platform scope and stops with `VERIFICATION BLOCKED.` when the handoff's scope/devices disagree with what is running. Each verifier has a hard 100-step ceiling: size its handoff below roughly 75 planned tool calls, and split a larger independent platform or flow scope into separate handoffs in the same bundle. Each handoff names the orchestrator as bundle owner and gives the exact assigned scope, start command, and devices. `dispatch-role.sh` gives every verifier a unique `$SCRATCH` for baselines and temporary files only, and injects `$E2E_ARTIFACTS` (section scratch `e2e-artifacts/`) for reusable flow scripts and assertions named `<platform>-<case>.js`. After all parallel shards return, any serialized cross-platform or shared-fixture cases run now while the slot is still held (in-round verification, not repair). Then the orchestrator runs `apps/mobile/e2e/record.sh <device> stop` for every bundle device (idempotent), stops every bundle resource, and frees the slot. Serialize only a genuinely cross-platform flow or a test that needs shared mutable fixtures or temporary worktree edits. Never dispatch while implementers are active or uncommitted changes sit in an in-scope worktree — the verifier's byte-identical baseline restore turns concurrent edits into false failures. If a verifier round dies or is killed, the orchestrator still owns and cleans the bundle before redispatching.
2. Each verifier fails fast on the first confirmed product failure in its platform scope after capturing reproducible evidence; later cases in that scope are intentionally unrun. A sibling platform verifier already running continues its independent scope. Collect every in-flight shard's sentinel and wait for all of them to return before editing, committing, or dispatching an implementer. Then act on the union of sentinels: `VERIFICATION FAILED.` → triage the remarks (untrusted) and run the implementer → impl-reviewer loop to fix them, commit and push. `VERIFICATION BLOCKED.` → one environment recovery attempt and a fresh dispatch; if it blocks again, the section is BLOCKED. A `VERIFICATION BLOCKED.` environment recovery is a device phase: re-take the slot, start the same platform scope, recover or redispatch the verifier, stop every bundle resource, and free the slot.
3. Re-verify with the repaired failing case first. Then rerun every prior case in the same page, flow, component, or shared-dependency area and every case no completed round has proved. Carry forward a prior pass only when the handoff names the case, cites its round and evidence, and gives concrete changed-file or dependency evidence that the fix cannot affect it — for example, a page-2-only fix may carry forward page-1 cases with no shared dependency. The fresh verifier independently rejects weak carry-forward claims and runs those cases. Before writing new flow scripts, evaluate any `$E2E_ARTIFACTS` files named in the handoff — reuse only after judging them sound; a faulty prior run's assertions are evidence, not truth. A re-verification round re-takes the slot and repeats the pinned lifecycle: take → start the same platform scope → dispatch the verifier → wait → stop recorders and every bundle resource → free the slot.
4. Exit when every platform shard returns `VERIFICATION PASSED.` and the current rounds plus explicitly justified carried-forward proof cover every criterion. After five rounds without that, the remaining moves are takeover or BLOCKED (see Escalation).

### Kilobot Loop

1. Wait for Kilobot to review the latest head — `pr-gate.sh <owner/repo> <n> --wait 1200` blocks until a bot summary (or waiver) postdates the head commit, then prints the whole mechanical picture; thread state is GraphQL-only — list threads with `pr-threads.sh list|unresolved` and reply-plus-resolve them with [`pr-threads.sh`](pr-threads.sh) `close`, never hand-written GraphQL. Kilobot can crash: if the wait expires with no summary, retrigger it (`git commit --allow-empty -m "chore: retrigger review" && git push`, or a `(bot) @kilocode-bot please review` PR comment), then resume waiting. After two failed retriggers, stop waiting: post `(bot) Kilobot posted no approving summary on this head after two retriggers` on the PR and treat the gate's Kilobot item as waived — the pending human review covers it. A green `Kilo Code Review` check only says the review finished; it carries no verdict. The clean state is a Kilobot summary comment on the current head that approves it (`gh pr view <n> --json comments` — read the verdict the comment states, do not match an exact string; bot wording drifts) plus zero **unresolved** review threads. A green check with no approving summary is not a clean head: keep waiting, then retrigger.
2. For each comment: verify it (untrusted), then route valid findings through the implementer → impl-reviewer loop; commit, push, then `pr-threads.sh close <owner/repo> <thread-id> "<what was done>"` — it replies in-thread and resolves in one step. Invalid finding: `close` with the technical evidence and do not change correct code. A fix without its in-thread reply and thread resolution is not done. Follow the repository-root `AGENTS.md` "Kilobot Review Remarks" contract.
3. Comments already posted by other reviewers — bots or humans — get the same triage flow, but never wait for anyone except Kilobot to review or re-review.
4. CI failures are findings too: route the fix through the implementer loop; rerun a flaky check once (`gh run rerun <id> --failed`); a check still failing after two fix rounds makes the section BLOCKED.
5. Rerun E2E for any repair that affects verified behavior (touched bits only). Three full E2E↔Kilobot alternations without converging is BLOCKED.
6. Exit when Kilobot has posted an approving summary comment on the latest head — or its absence was waived per step 1 — no actionable posted comment is unresolved, and CI is green.

Integrate the base branch **only when GitHub reports an actual conflict** (`mergeable: CONFLICTING`) or the run needs something that landed on the base. Integrate by merge, not rebase — `git fetch origin && git merge origin/main` — with the orchestrator resolving conflicts itself (its merge-conflict direct-edit allowance). Rebasing a conflict-free branch invalidates green CI and a completed Kilobot review for nothing. `mergeStateStatus: BLOCKED` on a `MERGEABLE` PR means a required human review is pending — that is the expected terminal state, not a problem to solve.

### Completion Gate

Check the mechanical half with [`pr-gate.sh`](pr-gate.sh) — it pins every fact to the current head SHA, so an approving comment from an older head can never vouch for this one:

```bash
.kilo_workflow/pr-gate.sh <owner/repo> <pr> --assignee <requesting-handle>
```

`GATE OK` covers mergeability, green CI, zero unresolved threads, assignee, and a bot summary postdating the head commit. The rest is yours to judge. The work is complete only when every item holds:

- All accepted plan tasks are implemented, with automated coverage for every applicable feature state
- A fresh impl reviewer has cleared the cumulative section diff (step 4), including any repair or orchestrator edit since
- A fresh E2E verifier returned `VERIFICATION PASSED.` for the plan's goals — or E2E was skipped as inert, with the rationale in the PR description
- Changes are organized into small, coherent commits; format, typecheck, lint, and tests pass in every changed repository, using the check commands the nearest `AGENTS.md` or `package.json` defines for each changed package. oxfmt covers `*.yml`/`*.yaml`: after writing or editing any `*.yml` or `*.yaml` file, run `pnpm format` and diff its rewrite before committing — never let a formatter rewrite load-bearing whitespace unreviewed
- The PR exists with what/why/how sections and is assigned to the requesting human
- If any accepted task has a UI, the PR description renders screenshots of the final behavior from the latest head, uploaded to that repository as GitHub `user-attachments`; visual changes include before/after evidence when a meaningful before state exists. A non-UI PR records `Visual Changes: N/A`
- Kilobot has posted an approving summary comment on the latest head and no actionable posted comment is unresolved — or Kilobot's absence after two retriggers is noted with the exact waiver sentence from the Kilobot loop
- All expected CI checks on the latest head are green, and GitHub reports the head mergeable with no conflicts
- No generated fixture remains, tracked or untracked; every verifier temporary edit is restored
- Every resource this run started is shut down or released; resources the run did not start stay running
- New committed learnings are included in the PR
- The PR carries the `human-ready` label, added only after every item above holds

A PR waiting on required human review is COMPLETE — the workflow never approves or merges its own PR. A gate item that can never hold is BLOCKED (see step 8), never a reason to loop forever or fake completion.

### Real LLM Responses

Any step where an agent or LLM must actually respond — cloud-agent sessions, chat flows, acceptance states — uses real model calls on `kilo-auto/efficient` (the in-app id; `kilo/kilo-auto/*` are the same models as CLI ids), always. If an `efficient` call stalls or errors, retry on `efficient`; never switch models. LLM mocking (fake-llm or otherwise) is prohibited unless a real call cannot produce the required state; each use must be named and justified in the handoff and the PR. One standing exception to the prohibition qualifies: forcing a specific provider failure; the naming and justification requirement applies to it too.

## E2E Slots

The machine is shared by parallel workflows, and unslotted E2E work overloads it. Only E2E bundles are capped — agents themselves are never capped. One slot permits one round's complete bundle: one dev stack, up to one iOS simulator, up to one Android emulator, and its remote CLIs, browsers, native builds, and other resources. A slot is not per resource or per verifier; parallel platform verifiers in one round share the same bundle. Slot ownership is round-scoped: the bundle owner takes the slot at the start of the device/stack phase, holds it through the round's E2E work and any in-round verification, and frees it immediately after stopping every bundle resource.

The planner owns the repro bundle. The orchestrator owns implementation-verification bundles. That owner follows this lifecycle plus status check (default 3 slots, machine-global):

```bash
.kilo_workflow/e2e-take-slot.sh
.kilo_workflow/e2e-start-resource.sh stack <services...>  # or ios, android, command
# run the E2E work
.kilo_workflow/e2e-stop-resource.sh stack                 # stop every resource started above
.kilo_workflow/e2e-free-slot.sh
.kilo_workflow/e2e-slot-status.sh                         # live slots + stale/unaccounted checks
```

The take/free scripts resolve the caller's own tmux session themselves and refuse to run outside one.

`e2e-take-slot.sh` atomically takes one of three tokens and `e2e-free-slot.sh` returns it. Start and stop resources through the paired scripts; `stack`, `ios`, and `android` dispatch to the repository wrappers, while `command` runs another explicit start/stop command. Stop every resource first, then free the slot. `e2e-slot-status.sh` reports live holders, known stacks/device records with no slot owner, booted devices with no claim record, and claimed devices that are no longer booted; it never kills them. Every device/stack phase — main loop, `VERIFICATION BLOCKED.` recovery, and Kilobot-driven re-verify — uses the same round lifecycle: take → start → stop → free.

- Slot state lives in `$HOME/.cache/kilo-e2e-slots`, machine-global by design: every copy of the script — any worktree, any repository — contends for the same slots, and the script has no overrides by design. When working in a repository without the script (a sibling like `~/Projects/kilocode`), invoke it by absolute path from a cloud worktree.
- This holds on every run, not only when another workflow is visibly active, and a stack that is already up is not an exemption.
- A blocked `e2e-take-slot.sh` is correct behavior, never a wedge to route around and never a reason to start device work unslotted. Each call blocks up to ~8 minutes while reporting holders; re-invoke while waiting, and after ~45 minutes total inspect `e2e-slot-status.sh` for a wedged foreign holder and report a blocker instead of waiting forever.
- The slot caps load, not data: postgres and redis containers are shared across worktrees. Keep test data keyed to this worktree's accounts (the runbooks' per-worktree defaults) and never wipe shared state.
- Release immediately after cleaning up the resources used by the device/stack phase. Planning, implementation, review, checks, and CI waits are uncapped; never hold a slot through them.
- Slots are owned by tmux session name and reclaimed automatically when the session dies. A holder that is alive but wedged belongs to its own workflow's monitor — never kill another session to free a slot; if the queue is starved by a foreign wedge, report a blocker to the user instead.
- The bundle owner is accountable: every verifier handoff names it and the resources it owns. A verifier never takes another slot.

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

- Format: **symptom / cause / fix**, a few lines each, in a file whose name makes it findable from the symptom (for example `mobile-metro-file-map-stale-after-node-modules-relayout.md` before it graduated — a good learning names the symptom, then gets automated away).
- System-specific learnings (true only of this machine: installed tools, local ports, OS quirks) go to `learnings/system/`, which is gitignored (only its `.gitkeep` is committed). Write them to the **main checkout's** copy — `~/Projects/cloud/.kilo_workflow/learnings/system/` — so they survive worktree deletion and reach parallel runs immediately; `pnpm dev:worktree:prepare` copies them into fresh worktrees. `learnings/system/` is the rare exception: when in doubt, commit in the section worktree.
- Everything else goes to the section worktree's `.kilo_workflow/learnings/` and is committed — the orchestrator includes new learnings in the run's PR (they reach other runs once merged; that lag is accepted). Committed promptly, not at the end: an uncommitted learning blocks E2E dispatch (see E2E Loop) and is one stray cleanup away from vanishing. The planner cannot commit (the orchestrator owns Git), so a planner-authored learning is named in the orchestrator handoff as work for the first commit.
- `.kilo_workflow/` is exempt from section disjointness — any section may write learnings or fix this document; overlaps resolve as ordinary merge conflicts.
- Role agents whose rules forbid dirtying the tree (the E2E verifier's byte-identical baseline restore) write their learnings to `$SCRATCH/learnings/` instead and list them in their report; the orchestrator moves them into `.kilo_workflow/learnings/` and commits them.
- Read before writing: when an existing entry covers the blocker, update it instead of appending a duplicate. When a run proves an entry wrong or stale, fix the entry in the same run.
- **Graduation:** a learning is a workaround waiting for a fix. When the blocker can be prevented by a script change (a flag, a guard, a wrapper) or by a line where agents already look (this document, a runbook, a role definition), make that change instead of — or in the same PR as — writing the learning, and delete any learning the change supersedes. Keep as learnings only what genuinely cannot be automated or folded away: environment trivia, one-off incident evidence, niche device quirks. A verifier cannot fix docs itself (its baseline restore must stay byte-identical), so a verifier-authored documentation fix follows the learning path: written under `$SCRATCH` (as a patch or a precise edit), named in the report, and applied by the orchestrator in the same PR.
- Every role records blockers it resolves, immediately after resolving them. The orchestrator commits learnings to the section worktree's `.kilo_workflow/learnings/`; the planner cannot commit, and an uncommitted worktree file blocks its own repro-gate dispatch, so a planner-authored learning goes to `$SCRATCH/learnings/` and is named in the orchestrator handoff for the first commit.
- Never keep a workflow learning only in a harness's private memory; it belongs in these folders so runs on other harnesses can use it.
- The same rule applies to this document: when a run stumbles on something `WORKFLOW.md` could have prevented — a missing command, an ambiguous rule, a wrong assumption — the orchestrator fixes the document in the same run and ships the fix with the PR. Role-definition fixes from a kilo session go through shell (`cat > .kilo/agent/<name>.md <<'EOF'`) because kilo's edit tool blocks `.kilo/` paths (the bash tool is not config-gated; `.kilo_workflow/` paths are unaffected). Mistakes that recur are workflow bugs, not agent bugs.

## GitHub Communication

Every GitHub issue comment, PR comment, review comment, review body, and thread reply written by this workflow begins exactly with `(bot) `, including replies to Kilobot and rejections of findings. Only the PR title and PR description carry no prefix.

GitHub's public API and `gh pr comment` cannot upload attachments. Use the repository's
checksum-pinned wrapper around the security-reviewed
[`gh-image`](https://github.com/drogers0/gh-image) v1.2.0 binary. It performs the same
repository-scoped upload as GitHub's comment box and prints ready-to-paste Markdown:

```bash
.kilo_workflow/upload-pr-attachment.sh "$SCREENSHOT" --repo <owner/repo>
# ![screenshot.png](https://github.com/user-attachments/assets/<id>)
```

Put that Markdown in the PR's `Visual Changes` section (or a `(bot) ` comment when adding
later), then fetch the PR body/comments with `gh` and verify the
`github.com/user-attachments/` URL is present. `gh-image` uses an existing GitHub browser
session because a normal `gh` API token cannot authorize this undocumented upload endpoint.
It may trigger a one-time OS keychain approval; never print, pass on the command line, commit,
or place its `user_session` cookie in a handoff; never invoke `gh-image` directly. The wrapper
verifies the reviewed release digest before every execution and blocks every supported explicit
token path. Its audit and residual risks are recorded in
`learnings/gh-image-unverified-release-binary.md`. A missing browser session is a completion
blocker for UI work, not a reason to commit screenshots into the product repository or use an
unrelated public image host. Any version change requires a fresh security review and new committed
digests.
