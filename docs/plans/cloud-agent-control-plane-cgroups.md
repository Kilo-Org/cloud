# Control-plane cgroup resource isolation

## Goal and scope

Prevent a memory-heavy command started by Kilo (for example, lint, typecheck, or code generation) from making the whole Cloudflare sandbox unresponsive. The command may fail from a cgroup OOM; the control wrapper must remain able to heartbeat, report the failure, cancel work, and accept another command. Apply this to the `workspace_*` control plane, not the legacy `agent_*` wrapper. Do not enable swap or change the container's disk allocation.

This is an implementation plan, not a claim that memory pressure has been measured in a failing production container. The first real-container checks must confirm that Cloudflare delegates the required cgroup v2 controllers and permits the intended hierarchy.

## Current behavior and constraint

- Legacy `wrapper/src/tool-cgroup.ts` places the Kilo server and its tool children in separate slices. The tool slice defaults to a hard cap of `MemTotal - reserve` (subject to availability); `kilo-server` defaults to `memory.max=max`. A server-specific cap applies only when `TOOL_CGROUP_SERVER_LIMIT_MB` is positive. Legacy classification uses a periodic `/proc` sweep, so a fresh child briefly inherits the server slice.
- Control-plane `wrapper/src/control/worktree-runtime.ts` starts `kilo serve` through `createOwnedProcessScope()`. `wrapper/src/control/owned-processes.ts` creates a cgroup and gates process start until migration is confirmed, but uses the group for ownership and cancellation rather than memory/CPU controls. Kilo's children inherit that group.
- Owned scopes provide recursive occupancy checks and `cgroup.kill` for cleanup. Moving children to unrelated top-level groups would lose this proof of ownership. Preserve each worktree's cleanup boundary while adding resource controls.
- Several worktrees can run in one container. Per-worktree tool limits alone cannot reserve memory for the wrapper; a container-wide aggregate workload limit is necessary.

## Target hierarchy

```text
container cgroup (provider limit)
|-- control wrapper (outside the workload limit)
`-- kilo-workloads (aggregate memory.max, lower cpu.weight)
    |-- worktree A owned scope (existing cleanup owner)
    |   |-- server (kilo serve; no individual memory.max initially)
    |   `-- tools (Kilo-started commands; memory.max, memory.oom.group=1)
    `-- worktree B owned scope
        |-- server
        `-- tools
```

The workload parent includes server processes as well as tools. Its hard cap reserves room outside it for the wrapper and container overhead even if several Kilo servers or worktrees run at once. Keep the individual server group uncapped initially, matching the legacy default; it remains subject to the aggregate parent cap. Do not add a separate server limit without evidence of server-specific pressure. `memory.oom.group=0` on the server group avoids killing Kilo together with a tool that grew before migration; test the behavior of an OOM at the aggregate parent as well.

## Implementation steps

1. **Prove provider capabilities first.** In a disposable Cloudflare container of each relevant class, inspect the wrapper's actual cgroup, ancestor `memory.max` files, `cgroup.controllers`/`cgroup.subtree_control`, mount permissions, and whether child memory/CPU controllers can be enabled and read back. A parent containing the wrapper may not allow subtree controller activation under cgroup v2's no-internal-process rule; establish a valid empty workload parent without moving the wrapper or changing the provider's parent. Record a clear blocker if the platform cannot support this hierarchy. A writable directory or a successful `mkdir` is not proof of enforcement.
2. **Define a bounded budget.** Use the effective finite container/ancestor memory limit or an explicitly supplied, verified instance-class limit; do not infer a container's budget from `/proc/meminfo` alone. Compute `aggregateMax = containerLimit - controlReserve`, with an initial reserve by instance class and a minimum viable workload cap. Start from the legacy 2048 MiB reserve as a candidate, not an untested universal value: the available 4, 6, and 12 GiB classes need separate validation. Keep per-worktree tool caps at or below the aggregate cap. A single central owner must calculate and report the applied budget.
3. **Extend the existing owned-scope machinery.** Have the control wrapper create the shared workload parent and per-worktree owned scopes below it. Before releasing the gated `kilo serve` process, create its server/tools children, set `memory.max` on the workload parent and tool group, set appropriate `cpu.weight` on sibling groups where supported, and read back the effective controls. Keep the existing opened-directory identity checks, cleanup deadlines, and recursive `cgroup.kill`/occupancy semantics. Remove nested groups after confirmed death; do not discard an unproven scope merely to tidy up cgroup directories.
4. **Classify Kilo descendants into tools.** Reuse the legacy Kilo-server recognition and `/proc` process-table approach, but scope migration to each worktree's owned cgroup. Traverse through server-chain processes to find tools, verify PID identity immediately before migration, and confirm membership after writing `cgroup.procs`. Periodic migration has a window in which a newborn tool remains in the server group; `memory.oom.group=0` there and the aggregate parent cap must keep that window safe. Account for children reparented after their original parent exits: they must remain inside the owned hierarchy and be covered by its limit and cleanup even when ancestry can no longer classify them. Avoid a second, independent process owner or a global migration sweep that moves another worktree's processes.
5. **Make failures and limits visible.** Report controller unavailability, applied/read-back limits, migration failures, `memory.events` OOM counts, `memory.current`/peak, and pressure alongside wrapper heartbeat gaps. Deduplicate persistent failures. Never include tool command text, environment, tokens, or credentials in resource diagnostics. If enforcement cannot be established on an enabled cohort, do not silently report it as protected or admit an unbounded workload under that claim; define an explicit user-visible failure/rollback path.
6. **Roll out by container class/cohort.** Keep the legacy path unchanged. Enable the control-plane policy first on a small Cloudflare cohort, then compare sandbox availability, wrapper heartbeats, tool OOMs, and successful subsequent commands. Use an explicit rollback that neutralizes limits or selects the previous image only after verifying cleanup/ownership behavior; do not leave stale caps in reused containers.

## Verification and acceptance

- Unit tests exercise budget calculation for 4, 6, and 12 GiB limits and missing/unbounded ancestor limits; classifier behavior; PID reuse; failed controller setup; correct nested membership; and cleanup after a tool and then a Kilo server exit.
- Linux integration tests use real cgroup files when privileges permit. Prove that the direct Kilo process stays in its server group, its shell/build descendants enter the matching tool group, all remain beneath the original owned scope, and stopping the scope kills both groups. Mocked cgroup files are not sufficient proof of kernel enforcement.
- Real Cloudflare-container stress test: run a bounded memory-heavy command that exceeds its tool limit. Verify a prompt tool failure/OOM signal, continuing wrapper heartbeats and cancellation, and a successful new command on the same live sandbox. Repeat with simultaneous worktrees, a tool that allocates before the first sweep, a parent that exits leaving a descendant, and the smallest 4 GiB class. Confirm CPU contention does not starve the wrapper.
- Check negative behavior: no tool OOM should kill the Kilo server or wrapper; a setup/migration failure must be identifiable rather than silently bypassing limits; a stopped worktree must leave no live descendant outside its owned scope. Check parent OOM behavior separately since an aggregate OOM may select Kilo rather than a tool; adjust the hierarchy or policy if that violates the goal.

## Out of scope

- Swap, zram, disk-backed paging, disk-size changes, and systemd supervision.
- A default hard cap on `kilo serve`; legacy does not apply one by default.
- Changing the legacy cgroup implementation or Vercel Sandbox behavior as part of the Cloudflare rollout.
