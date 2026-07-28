# Kilo Workflow — TL;DR

A multi-agent delivery workflow for this repository (and siblings like `~/Projects/kilocode`). You hand it a body of work; it returns a reviewed, E2E-verified, CI-green PR assigned to you. [`WORKFLOW.md`](WORKFLOW.md) is the canonical spec every agent follows — this file is the human orientation.

## How to run it

1. Open an interactive session on a strong model — either harness works:
   - Claude Code: just ask, e.g. *"Run the kilo workflow on \<work\>."*
   - kilo CLI: `kilo run --agent starter --interactive --model <model>`
2. Answer the one process question: **hands on** (it asks you questions, you approve the plan) or **hands off** (it decides everything from repository evidence and never waits for you).
3. Walk away. Everything runs in tmux windows named after the section (`<name>-<hex>`, e.g. `billing-a7f3-planner`); attach to watch or, in hands-on mode, to answer a question.

A run ends in one of two states:

- **Complete** — an open PR, CI green, Kilobot-reviewed, assigned to you, awaiting your review. The workflow never approves or merges its own PR; a PR waiting on human review is the deliverable, not a stall.
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

Each section works in its own worktree under `~/Projects/.worktrees/` — never a primary checkout — and cleans up everything it started when it ends.

## The trade: wall time for correctness, at a good price

The workflow is deliberately slow in wall-clock hours and cheap in both dollars and human minutes:

- **Expensive models only where judgment concentrates** (planning); high-volume implementation and review runs on cheaper models that follow an explicit plan.
- **Nothing ships on one opinion.** Every artifact — plan, slice, cumulative diff, runtime behavior, PR — is checked by a *fresh* session with no memory of earlier rounds, so conclusions can't anchor. Loops repeat until a fresh reviewer finds nothing.
- **Verification is empirical.** Bugs must be reproduced before they're fixed; features must pass a live E2E round against real services before the gate opens.

A section routinely takes hours of unattended machine time. The human cost is minutes at the edges: state the request, optionally approve the plan, review the final PR. That is the intended trade — burn agent time and cheap tokens to make the one expensive resource (your review attention) arrive at an already-verified PR.

## What's in this directory

| Path | Purpose |
|---|---|
| [`WORKFLOW.md`](WORKFLOW.md) | The canonical spec — roles, loops, gates, dispatch commands |
| [`dispatch-role.sh`](dispatch-role.sh) | Launches a kilo role agent in tmux with a clean environment and logged exit code |
| [`e2e-slot.sh`](e2e-slot.sh) | Machine-global semaphore (default 3) capping concurrent device/stack E2E phases; agents are never capped |
| [`learnings/`](learnings/) | Environment blockers and fixes, one file each, committed via PRs so every future run inherits them; `learnings/system/` is gitignored machine-local state |

Role definitions live in the repository root `.kilo/agent/` (the kilo CLI only discovers agents there). The workflow self-heals: when a run stumbles on something this documentation could have prevented, it fixes the documentation in the same PR.
