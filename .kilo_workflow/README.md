# Kilo Workflow — TL;DR

A multi-agent delivery workflow for this repository (and siblings like `~/Projects/kilocode`). You hand it a body of work; it returns a reviewed, E2E-verified, CI-green PR assigned to you. [`WORKFLOW.md`](WORKFLOW.md) is the canonical spec every agent follows — this file is the human orientation.

## How to run it

1. Open an interactive session on a strong model — either harness works:
   - Claude Code: just ask, e.g. *"Run the kilo workflow on \<work\>."*
   - kilo CLI: `kilo run --agent starter --interactive` (pass `--model` and `--variant` only to override the pinned default)
2. Answer the one process question: **hands on** (it asks you questions, you approve the plan) or **hands off** (it decides everything from repository evidence and never waits for you).
3. Walk away. Everything runs in tmux windows named after the section (`<name>-<hex>`, e.g. `billing-a7f3-planner`); attach to watch or, in hands-on mode, to answer a question.

A run ends in one of two states:

- **Complete** — an open PR, CI green, Kilobot-reviewed (or Kilobot's absence explicitly waived after two failed retriggers, noted on the PR), assigned to you, awaiting your review. The workflow never approves or merges its own PR; a PR waiting on human review is the deliverable, not a stall.
- **BLOCKED** — a precise blocker report (in the PR or the section's final report) saying exactly what a human must do. It does not guess past blockers or fake completion.

## What happens inside

Pipeline: **starter → planner → orchestrator → implementer/reviewer loops → E2E verification → Kilobot loop → completion gate.**

| Role | What it does |
|---|---|
| Starter | Grills the requirements, challenges the request itself, splits work into disjoint sections; one planner per section |
| Planner | Writes the plan (SOTA model); loops with fresh plan-reviewers until `No findings.`; for bugs, a repro gate proves the defect exists before anything is planned |
| Orchestrator | Owns git end to end; slices the plan, dispatches parallel implementers, commits at slice boundaries, opens the PR |
| Implementer / impl-reviewer | Cheap-model pairs: implement a slice, then a fresh reviewer re-derives the diff's correctness; loop until findings dry up |
| E2E verifier | Boots the real local stack (simulator, browser, services — real LLM calls, no mocks) and verifies the plan's goals behave, not just compile |

Each section works in its own worktree under `~/Projects/.worktrees/` — never a primary checkout — and cleans up everything it started when it ends; the worktree itself is the one local artifact that stays until its PR closes.

## Fast without trading correctness

The workflow minimizes wall time while preserving independent review and live verification:

- **Expensive models only where judgment concentrates** (planning); high-volume implementation and review runs on cheaper models that follow an explicit plan.
- **Independent work runs in parallel.** Slices, reviewers, checks, and iOS/Android E2E shards overlap when their files and resources do not conflict; synchronization gates only the points that need a complete diff.
- **Nothing ships on one opinion.** Every artifact — plan, slice, cumulative diff, runtime behavior, PR — is checked by a *fresh* session with no memory of earlier rounds, so conclusions can't anchor. Loops repeat until a fresh reviewer finds nothing.
- **Verification is empirical.** Bugs must be reproduced before they're fixed; features must pass a live E2E round against real services before the gate opens.
- **Doomed E2E rounds stop early.** A verifier stops at the first confirmed product failure; after the fix, it runs that case first, every same-area regression case, and every unproven case. Only proven cases with a concrete disjoint-impact reason carry forward.

A section can still take hours of unattended machine time when builds or live E2E dominate. The human cost is minutes at the edges: state the request, optionally approve the plan, review the final PR.

## What's in this directory

| Path | Purpose |
|---|---|
| [`WORKFLOW.md`](WORKFLOW.md) | The canonical spec — roles, loops, gates, dispatch commands |
| [`init-section.sh`](init-section.sh) | Creates a section or adds a mid-plan repository: run id, worktrees, cloud prepare, scratch directory — prints the manifest |
| [`dispatch-role.sh`](dispatch-role.sh) | Launches a kilo role agent in tmux with a clean environment and logged exit code |
| [`await-role.sh`](await-role.sh) | Waits on a dispatched agent's log and reports the round's outcome: DONE with its verdict, VOID, STALLED, or RUNNING |
| [`launch-interactive.sh`](launch-interactive.sh) | Launches an interactive session (planner, orchestrator) in tmux with a clean environment and a live TTY |
| [`launch-gate.sh`](launch-gate.sh) | Spaces Kilo CLI startups through a recoverable machine-global lock |
| [`await-interactive.sh`](await-interactive.sh) | Watches an interactive session for the monitor: COMPLETED, BLOCKED, LAUNCHED, DEAD, QUIET, or RUNNING |
| [`steer.sh`](steer.sh) | Delivers a message to a running interactive session (starter, planner, orchestrator) and confirms it was submitted; `--interrupt` cancels the in-flight turn first |
| [`e2e-take-slot.sh`](e2e-take-slot.sh) | Takes one of three machine-global E2E bundle slots for the current round (default: iOS-only scope) |
| [`e2e-start-resource.sh`](e2e-start-resource.sh) | Starts a stack, iOS simulator, Android emulator, or explicit custom resource after proving the caller holds a slot; also prebuilds/builds/claims the device as needed. Default bundle form is `--ios-only`; use `bundle <avd>` for dual-platform |
| [`e2e-stop-resource.sh`](e2e-stop-resource.sh) | Stops the matching resource through its repository wrapper |
| [`e2e-free-slot.sh`](e2e-free-slot.sh) | Frees the caller's slot after its resources are stopped |
| [`e2e-slot-status.sh`](e2e-slot-status.sh) | Reclaims dead owners and reports live slots plus known resources with no slot; also enumerates booted devices with no claim record and claimed devices that are no longer booted. The all-clear footer prints only when zero findings |
| [`slice-diff.sh`](slice-diff.sh) | Emits one slice's diff for review plus a snapshot fingerprint; `--check` judges the round for violations |
| [`baseline.sh`](baseline.sh) | Records a worktree's exact git state and later proves the E2E verifier's byte-identical restore |
| [`pr-gate.sh`](pr-gate.sh) | Checks the completion gate's mechanical items against one head SHA (CI, threads, assignee, bot summary) |
| [`pr-threads.sh`](pr-threads.sh) | Lists, replies to, and resolves PR review threads (GraphQL plumbing for the Kilobot loop) |
| [`pick-reviewers.sh`](pick-reviewers.sh) | Ranks reviewer candidates for a PR from file history and the requester's past reviewers |
| [`upload-pr-attachment.sh`](upload-pr-attachment.sh) | Uploads a screenshot to GitHub `user-attachments` via the checksum-pinned, security-reviewed `gh-image` binary |
| [`learnings/`](learnings/) | Environment blockers and fixes, one file each, committed via PRs so every future run inherits them; `learnings/system/` is gitignored machine-local state |

A standing rule from the spec: **anything that can be automated away, should be automated away.** Agents' tokens go to the work, not to battling the workflow or the environment — when a run stumbles on something a script or a document could have prevented, the run fixes the script or the document in the same PR, and learnings that graduate into automation get deleted.

Role definitions live in the repository root `.kilo/agent/` (the kilo CLI only discovers agents there).
