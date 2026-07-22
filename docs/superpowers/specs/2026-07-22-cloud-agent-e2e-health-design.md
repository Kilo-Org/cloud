# Cloud Agent E2E Health Reliability Design

## Goal

Make the local fake-LLM smoke matrix a reliable health check for the real Cloud Agent path: Worker, Durable Object, sandbox container, wrapper, Kilo, and persisted run reporting. The harness must distinguish genuine product regressions from expected warm-session preparation chatter and from local container-engine cleanup races.

## Scope

This change is limited to the local E2E harness under `services/cloud-agent-next/test/e2e` and its focused unit tests and documentation. It does not change Worker, wrapper, or UI behavior. It does not add retries.

## Warm-Reuse Health Contract

The `hot` and `cold-hot` scenarios must continue to prove all of the following:

- the follow-up reaches its expected terminal state;
- the first Kilo event arrives within the existing observation window;
- the original primary sandbox remains present;
- no new sandbox container appears; and
- no live preparation step that represents cold workspace work starts.

Preparation snapshots replayed when a stream connects are historical state, not evidence of new work. Live `attempt_started`, `attempt_completed`, progress, and completion frames are also not sufficient by themselves to prove reprovisioning. The harness will therefore classify only version 2 `preparing` frames with `action: "step_started"`.

The following steps are expected during a warm verification and do not indicate reprovisioning:

- `sandbox_provision`
- `sandbox_boot`
- `kilo_server`

Any other live `step_started` preparation step is cold-path work and fails warm reuse. This deliberately fails closed for newly introduced step names: a new step must be explicitly classified before the health check accepts it. Legacy unversioned `preparing` frames also fail warm reuse because the harness cannot prove that they are harmless snapshots or warm verification.

Failure output will report the unexpected preparation step names instead of only printing `noPrepare=false`.

## Matrix Isolation Contract

After every matrix row, the harness will:

1. identify sandbox families created after the matrix baseline;
2. kill their currently running primary/proxy containers using the existing exact-family matching;
3. wait for each selected family to disappear; and
4. poll all non-baseline sandbox containers until none exist continuously for five seconds.

The continuous absence window covers the observed local container-engine `destroy -> create -> destroy` churn after an external kill. If a new non-baseline sandbox appears during the window, the stability timer resets. The total quiescence wait is bounded.

If cleanup does not quiesce, the matrix records an explicit cleanup failure and stops before running another scenario in contaminated state. It does not silently warn and continue, sleep for a fixed interval, or retry a failed product scenario.

Baseline containers are never killed or treated as cleanup failures.

## Components

### Preparation classification

A small pure helper in `lifecycle.ts` will return the unexpected cold preparation steps observed in a stream event list. Both `hot` and `cold-hot` will use it.

### Sandbox quiescence

`sandbox-control.ts` will own a bounded stable-absence polling helper because it already owns Docker discovery and family operations. Its Docker executor and timing inputs will be injectable for deterministic unit tests while production callers use defaults.

`smoke.ts` will use the helper after its existing family cleanup and convert failure into an explicit matrix result before stopping.

### Documentation

The E2E README will describe the warm-reuse and between-row isolation assertions so operators know what a failure means.

## Tests

Focused unit tests will cover:

- snapshots and warm verification steps do not count as cold preparation;
- cold-path and legacy preparation events do count;
- the stable-absence window succeeds only after uninterrupted absence;
- a transient recreation resets the stability window;
- persistent non-baseline containers time out; and
- baseline containers are ignored.

Focused verification will run the new unit tests, service typecheck, formatting checks, and `git diff --check`.

Runtime verification will run the complete 15-row matrix against the current local stack with `WORKER_URL=http://localhost:10594`. Completion requires 15/15 scenario results and no matrix-cleanup failure.

## Deferred Work

The following remain separate follow-ups:

- suppressing no-op preparation attempts in production to remove the warm UI flash;
- retrying matrix scenarios;
- removing stopped Docker container corpses;
- adding provisioning elapsed-time landmarks; and
- cleaning pre-existing proxy containers.
