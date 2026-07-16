# Mobile Agent Workflow

Use this workflow when planning or implementing work whose product surface is the mobile app. Start Kilo from `apps/mobile/` so the role agents in `.kilo/agent/` are discovered. The implementation itself is not restricted to `apps/mobile`: an accepted plan may require cloud services, tRPC routers, shared packages, infrastructure, or a sibling checkout such as `~/Projects/kilocode`.

Work must always be done in a dedicated worktree, regardless of the repository. This applies to the cloud repository and all sibling repositories touched by the plan. The orchestrator and role agents must not edit the primary checkout or the main checkout of any repository.

The initial main session is the planner. After plan approval, a fresh session becomes the orchestrator. Role agents use `kilo/kilo-auto/efficient`. The orchestrator retains product judgment, architecture decisions, loop control, final verification, Git integration, and pull-request ownership. Prefer small, logically scoped commits throughout the flow instead of one final catch-all commit.

Role step limits are hard ceilings: `mobile-plan-reviewer` has 40 steps, `mobile-implementer` has 80, `mobile-reviewer` has 50, and `mobile-e2e-verifier` has 100. Size every handoff below 75% of its role limit; an implementation slice should normally fit in roughly 60 planned steps. Do not raise a global limit to compensate for an oversized task.

## Planning Mode

The planner's first interaction must ask the user whether this run is `hands on` or `hands off`. In every mode, always choose the simplest maintainable implementation that completely satisfies the accepted requirements. Reuse existing code and contracts, avoid unnecessary abstraction, and do not expand scope without evidence that it is required.

- In `hands on` mode, grill the user one question at a time until the requirements, trade-offs, acceptance criteria, and plan are unambiguous. Obtain explicit plan approval before launching the orchestrator.
- In `hands off` mode, grill itself instead of the user to expose missing requirements, trade-offs, risks, and acceptance criteria. It must not ask the user questions or wait for user approval after mode selection. Treat all approvals as granted, answer from repository evidence and best judgment, choose the simplest maintainable option, and record material assumptions in the plan and handoff. Continue through planning, implementation, review, E2E, PR creation and repair, Kilobot review, conflict resolution, and green CI. Stop only when continuing is technically impossible or unsafe, and return a precise blocker report without asking a question.

The selected mode applies to the planner, orchestrator, and all later workflow decisions. Hands-off execution does not bypass tool permissions, repository safety rules, or the completion gate.

## Plan Review Gate

After writing a complete draft plan and before hands-on user approval or hands-off self-approval, dispatch a fresh `mobile-plan-reviewer`. It reports unclear requirements, unsupported assumptions or claims, missing or conflicting acceptance criteria, incomplete ownership or cross-repository boundaries, infeasible sequencing, and underspecified verification or E2E coverage.

The reviewer has less context than the planner and may be wrong. Treat every finding as untrusted advice: independently verify every reviewer claim against the request, repository evidence, and applicable instructions. Fix only valid findings, and record rejected findings with a short technical rationale. Never weaken or expand the plan merely to satisfy the reviewer.

After repairing valid findings, dispatch another fresh reviewer. Repeat until a fresh reviewer returns `No findings.` Stop after three repair rounds for the same issue; the planner takes over, independently resolves and verifies it, records the resolution, and dispatches one final fresh reviewer that must return `No findings.` A rejected finding must not reopen without new evidence. The clean review is required before requesting approval in hands-on mode or granting self-approval in hands-off mode. Hands-off plan review must not ask the user questions or wait for user approval.

## Planner Handoff

The planning session explores requirements according to the selected mode, defines acceptance criteria, creates dedicated worktrees, and writes the approved plan. After explicit approval in hands-on mode or self-approval in hands-off mode, the planning session must not implement it. It prepares a sanitized handoff and launches a fresh orchestrator in a named tmux window.

The handoff must contain:

- The selected planning mode, with a direct instruction that hands-off execution must not request approval or ask the user questions
- The final plan-review result and rationales for rejected findings
- The accepted plan's absolute path and any approved design path
- The dedicated worktree path for every repository in scope
- Current branch, commit, and working-tree state in each worktree
- Acceptance criteria, feature-state matrix, execution ledger, non-goals, and unresolved risks
- Existing changes and resources that must be preserved
- Required review, E2E, Git, PR, Kilobot, mergeability, and CI completion gates
- A direct instruction to continue through a mergeable, conflict-free PR with all expected CI checks green on the latest head
- A direct instruction that every GitHub comment, review, or thread reply must start with `(bot) ` while the PR description remains unprefixed

The handoff must not contain secrets or raw environment-file contents. Write only sanitized explicit values to a temporary file outside every repository. Never attach `.env`, `.env.*`, `.dev.vars`, or an equivalent environment-file.

Use the current tmux session and a unique, descriptive window name. The canonical launch shape is:

```bash
tmux new-window -t <planner-tmux-session> \
  -n <feature>-orchestrator \
  -c <dedicated-worktree>/apps/mobile \
  'kilo run --interactive --model kilo/kilo-auto/frontier --title "<feature> orchestrator" --file <sanitized-handoff-file> "Execute the approved mobile plan in the attached handoff. Own implementation through the completion gate."'
```

Use `kilo run --interactive` without `--continue`, `--session`, or `--variant`; session freshness and Kilo Auto Frontier's default reasoning setting are required. The planner verifies that the tmux window started and then returns its window name, worktree paths, model, and handoff-file path to the user. The fresh orchestrator must delete the temporary handoff file after ingesting it and before completion.

## Feature State Matrix

Every new user-facing feature must define and behaviorally test these states before implementation begins:

| State | Required experience |
|---|---|
| Happy | The intended task completes and the resulting state is clear. |
| Unhappy, retryable | A meaningful, specific message explains the failure and an actionable CTA lets the user retry or recover. |
| Unhappy, non-retryable | A meaningful, specific message explains the terminal failure and no CTA is shown. |
| Empty | A meaningful message explains why there is no content and an actionable CTA leads to the next useful step. |

Do not collapse retryable and non-retryable failures into one generic error state. The accepted plan must define each state's trigger or classification rule, message intent, CTA label and outcome when required, and automated/E2E coverage. A state may be marked `not applicable` only when it is structurally impossible for that feature, with a concrete rationale accepted by the orchestrator; inconvenience or difficult setup is not sufficient. Automated tests must cover every applicable state's selection logic and CTA presence or absence. E2E must exercise all applicable states that can be produced safely and deterministically, and must report rather than silently omit states that cannot be reproduced.

## Roles

| Agent | Responsibility | Repository edits |
|---|---|---|
| `mobile-plan-reviewer` | Reviews a complete draft plan for ambiguity, unsupported claims, and missing execution detail | Denied |
| `mobile-implementer` | Implements one bounded task from the accepted plan and runs narrow checks | Allowed where the task requires |
| `mobile-reviewer` | Independently reviews the full relevant diff and tests | Denied |
| `mobile-e2e-verifier` | Exercises accepted behavior and may create temporary state-generation fixtures in verify mode | Temporary, verify mode only |

Reviewer and verifier invocations must be fresh sessions so earlier conclusions do not anchor later passes. Role agents do not dispatch other agents or perform commits, pushes, or PR operations.

## Execution Ledger

After accepting the plan, split it into the smallest behaviorally meaningful and independently testable slices. Record each slice in an execution ledger before dispatch:

- Slice ID, dependencies, priority, and estimated step cost
- Exact writable path set and forbidden path set in every repository
- Shared generated outputs and mutable runtime resources
- Producer-consumer dependency on contracts, schemas, generated code, or runtime state
- Ownership-safe narrow checks and checks deferred until the synchronization barrier
- Intended commit boundary

Two slices are parallel-safe only when their write sets do not overlap, neither consumes an unstable output from the other, they share no mutable runtime resource, and neither runs a repository-wide mutating command. File separation alone is not sufficient when one slice changes a contract consumed by another. Lockfiles, dependency installation, migrations, generated clients, repository-wide formatters, and broad autofix commands are always serialized.

## Orchestration

1. Follow the selected planning mode. Inspect affected repositories, establish acceptance criteria for every feature state in the matrix, produce an implementation plan, and create the execution ledger. Discuss decisions and obtain approval from the user only in hands-on mode; in hands-off mode, resolve them from evidence and recorded assumptions without asking questions.
2. Dispatch every ready independent slice in a bounded wave, capped at two or three concurrent implementers. Include all other active slices and ownership boundaries in each handoff. Run only ownership-safe narrow checks while the wave is active.
3. Treat completion of every active implementer as a synchronization barrier. Inspect each result, ownership adherence, and the combined diff. Resolve integration and architecture decisions in the main session, then run shared mutating commands and shared checks once. Preserve successful independent slices when another slice fails.
4. Dispatch one fresh `mobile-reviewer` over the coherent wave. Triage findings in the main session and route valid fixes through a bounded repair wave followed by a fresh reviewer. Record rejected findings with a short rationale.
5. After checks and review pass, create concise logical commits at the ledger's intended per-slice boundaries. Never let a role agent commit. If a slice reaches two budget-exhausted invocations, the orchestrator takes over rather than raising role limits.
6. Stop after three repair rounds for the same issue. The orchestrator takes over; if the underlying ambiguity remains, ask the user only in hands-on mode or use documented best judgment in hands-off mode. Never loop indefinitely.
7. When device E2E is likely, the orchestrator prewarms infrastructure concurrently with implementation. It may prepare stable services, claim and label a device, install a baseline native build only when unaffected by active slices, connect the exact Metro URL, and establish login state. It must not judge acceptance behavior while implementation is changing. Record a resource manifest for the final verifier.
8. After the coherent implementation passes review, dispatch a fresh final `mobile-e2e-verifier` with the prewarm resource manifest. It independently revalidates ownership and provenance, relabels the simulator to `verify`, runs acceptance flows, and owns cleanup. In verify mode it may make temporary E2E state-generation edits limited to backend mocks, fixtures, deterministic state controls, and test harnesses; it must not alter product behavior under test or conceal a product failure. Final Git state in every repository must exactly match the recorded byte-, mode-, index-, worktree-, and untracked-content baseline. Route product failures through a bounded repair wave and fresh reviewer before another fresh final verifier.
9. The main session performs the final full-diff review and repository-appropriate verification, commits any final narrowly scoped repair, then pushes and creates or updates the PR. Assign the PR to the requesting human. Do not squash the work into a catch-all commit unless the user explicitly requests it.
10. Wait until Kilobot has reviewed the latest head. Fetch every Kilobot review thread, including comments that arrive after earlier repairs, and triage each finding in the main session using the repository-root `AGENTS.md` review-remark workflow.
11. For each valid finding, plan the smallest coherent repair and send that bounded task to `mobile-implementer`. Run the required narrow checks, dispatch a fresh `mobile-reviewer`, and create the smallest coherent commit before pushing. Reply in the original review thread with `(bot) ` followed by the concrete fix, then resolve the thread. Reject invalid findings in the same thread with `(bot) ` followed by technical evidence instead of changing correct code.
12. Repeat the Kilobot triage, implementer, fresh reviewer, commit, push, reply, and resolution cycle until Kilobot has reviewed the latest head and there are no unresolved actionable Kilobot comments. Preserve the three-repair-round limit for any one finding; the main session takes over if that limit is reached and follows the selected mode for any unresolved decision.
13. Run local mobile E2E again after Kilobot repairs that affect behavior, build/runtime configuration, or the E2E workflow. Documentation-only or test-only repairs may skip repeated device E2E when the orchestrator records why the previously verified behavior is unaffected.
14. Inspect the exact latest PR head SHA, mergeability, merge-state status, expected CI checks, and latest-head Kilobot review. If the base branch advances, integrate the current base in the dedicated worktree and push the new head. A conflict-free integration needs no local reruns: do not rerun checks or local E2E and do not dispatch a fresh review, because the merged tree matches the already-verified head and latest-head CI and Kilobot still run on the new SHA. Rerun affected checks and local E2E and obtain fresh review before pushing only when conflict resolution changed the merged result and the orchestrator cannot confidently rule out behavioral impact; a resolution the orchestrator is certain is behavior-neutral does not require reruns. Always wait for CI and Kilobot on that exact head.

## GitHub Communication

Every GitHub issue comment, PR comment, review comment, review body, and thread reply written by the workflow must begin exactly with `(bot) `. This includes replies to Kilobot and technical explanations for rejected findings. PR descriptions are the exception and must not receive the `(bot) ` prefix; PR titles are also not comments.

## Handoff Requirements

Every dispatch should include:

- The accepted plan task and explicit non-goals
- Observable acceptance criteria
- The four-state feature matrix, with each state's trigger/classification, message intent, CTA label and outcome or required absence, and automated/E2E coverage
- Repositories and worktrees in scope
- The dedicated worktree path for every repository in scope, including sibling repositories
- Existing uncommitted changes that must be preserved
- Exact checks or user flows expected for that stage
- Prior findings being addressed, including rejected findings that must not be reopened without new evidence
- The intended commit boundary for the assigned slice
- Priority order, minimum complete outcome, optional work to drop, and a clean stopping rule before budget exhaustion
- Required continuation state: completed work, remaining work, failures, files touched, checks run or deferred, and safest next action
- The GitHub comment rule: every comment, review, and thread reply starts with `(bot) `; the PR description is unprefixed
- A prohibition on reading secret-bearing environment files: role agents must not read `.env`, `.env.*`, `.dev.vars`, or equivalent files. Use documented setup commands, sanitized status or manifest output, and sanitized explicit values supplied by the orchestrator instead.
- A prohibition on committing generated E2E fixtures: E2E fixtures must never be committed. Role agents may create them only in a temporary directory for the current run and must clean them up before returning control.

Do not ask a role agent to infer context from the conversation it cannot see. Keep cross-repository changes on coordinated branches or working trees, and give the reviewer and verifier the location of every related diff. Never place secrets or raw environment-file contents in a handoff; provide only the minimum sanitized explicit values required for the task.

## Workflow Metrics

The final report records lightweight in-session measurements when applicable:

- Number and width of implementation waves
- Budget exhaustion and collision counts
- Unmanaged listener detections
- Prewarm reuse or invalidation
- Simulator relabel or original-name restoration failures
- Accepted-plan-to-final-E2E-start time
- Accepted-plan-to-merged-PR time
- Review, E2E repair, and latest-head CI wait/repair rounds

Do not add persistent telemetry or a new data store for these metrics.

## Completion Gate

The orchestrator may call the work complete only when:

In hands-off mode, the orchestrator must not call the work complete while an E2E blocker remains; an E2E exception must not be self-accepted, and an impossible or unsafe blocker produces a blocked result.

- All accepted plan tasks are implemented
- Every applicable feature state has automated behavioral coverage, including required CTA presence or complete CTA absence
- Every safely reproducible feature state has passed E2E verification; exceptions require explicit user acceptance in hands-on mode
- Changes are organized into small logical commits with each commit internally coherent
- A fresh reviewer reports no valid actionable findings
- E2E acceptance criteria pass, or a documented environment blocker is explicitly accepted by the user in hands-on mode
- Final automated checks pass in every changed repository
- The main session has reviewed the complete diff and owns the Git/PR actions
- The PR is assigned to the requesting human
- Kilobot has reviewed the latest head and there are no unresolved actionable Kilobot comments
- GitHub reports the exact latest head as mergeable with no conflicts
- All expected CI checks on the latest head have reached a successful terminal state; failed, cancelled, timed-out, action-required, or pending checks block completion
- Generated E2E fixtures have been cleaned up, and final `git status` confirms none are tracked or untracked in the repository
- Every verifier-created temporary edit has been removed, and each repository's final Git state exactly matches its recorded pre-verification baseline
