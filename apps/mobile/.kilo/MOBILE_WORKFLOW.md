# Mobile Agent Workflow

Use this workflow when the main session is planning or implementing work whose product surface is the mobile app. Start Kilo from `apps/mobile/` so the role agents in `.kilo/agent/` are discovered. The implementation itself is not restricted to `apps/mobile`: an accepted plan may require cloud services, tRPC routers, shared packages, infrastructure, or a sibling checkout such as `~/Projects/kilocode`.

The main session is the orchestrator and should use a strong model. Role agents use `kilo/kilo-auto/efficient`. The orchestrator retains product judgment, architecture decisions, loop control, final verification, Git integration, and pull-request ownership. Prefer small, logically scoped commits throughout the flow instead of one final catch-all commit.

## Roles

| Agent | Responsibility | Repository edits |
| --- | --- | --- |
| `mobile-implementer` | Implements one bounded task from the accepted plan and runs narrow checks | Allowed where the task requires |
| `mobile-reviewer` | Independently reviews the full relevant diff and tests | Denied |
| `mobile-e2e-verifier` | Exercises accepted behavior on local services and a simulator/emulator | Denied |

Reviewer and verifier invocations must be fresh sessions so earlier conclusions do not anchor later passes. Role agents do not dispatch other agents or perform commits, pushes, or PR operations.

## Orchestration

1. Discuss the request with the user. Inspect affected repositories, agree on acceptance criteria, and produce an implementation plan before dispatching work.
2. Split the plan into the smallest slices that remain behaviorally meaningful and independently testable. Give `mobile-implementer` one slice, relevant repository paths, acceptance criteria, and required checks. A slice may span repositories when one contract change requires coordinated producers and consumers.
3. Inspect the implementer's result and diff. Resolve ambiguity with the user or make architecture decisions in the main session; do not delegate judgment to the efficient model. After the slice passes its required review and checks, the orchestrator creates a concise logical commit before dispatching the next slice.
4. Dispatch a fresh `mobile-reviewer` with the accepted plan, acceptance criteria, changed repositories, and exact diff range or working-tree scope.
5. Triage every review finding in the main session. Send valid findings to `mobile-implementer`, then repeat review with a fresh reviewer. Record rejected findings with a short rationale to prevent churn.
6. Stop after three repair rounds if findings remain. The main session takes over or asks the user to resolve the underlying ambiguity; never loop indefinitely.
7. Once review has no valid findings, dispatch `mobile-e2e-verifier` with observable acceptance criteria and the intended worktree/service context.
8. Route product failures through implementer and reviewer again. Let the verifier attempt one recovery for environment failures. The main session classifies inconclusive results before deciding whether code should change.
9. The main session performs the final full-diff review and repository-appropriate verification, commits any final narrowly scoped repair, then pushes and creates or updates the PR. Do not squash the work into a catch-all commit unless the user explicitly requests it.

## Handoff Requirements

Every dispatch should include:

- The accepted plan task and explicit non-goals
- Observable acceptance criteria
- Repositories and worktrees in scope
- Existing uncommitted changes that must be preserved
- Exact checks or user flows expected for that stage
- Prior findings being addressed, including rejected findings that must not be reopened without new evidence
- The intended commit boundary for the assigned slice

Do not ask a role agent to infer context from the conversation it cannot see. Keep cross-repository changes on coordinated branches or working trees, and give the reviewer and verifier the location of every related diff.

## Completion Gate

The orchestrator may call the work complete only when:

- All accepted plan tasks are implemented
- Changes are organized into small logical commits with each commit internally coherent
- A fresh reviewer reports no valid actionable findings
- E2E acceptance criteria pass, or a documented environment blocker is explicitly accepted by the user
- Final automated checks pass in every changed repository
- The main session has reviewed the complete diff and owns the Git/PR actions
