# e2e-verifier stacks killed twice mid-round by foreign slot churn

Symptom: during hermes-mem-c716 verifier r1 (2026-07-28, 3/3 slots held all round),
this worktree's `kilo-dev-hermes-mem-c716` stack was killed twice (~20:47 and ~21:10)
with no action by the owning verifier. `pnpm dev:status` prints "No dev session
running"; Metro dies mid-flow (dev client falls back to the launcher screen or
"There was a problem loading the project"); sibling stacks (`attach-oom`,
`sessions-context`) died in the same window; `e2e-slot.sh status` persistently shows
`stack=none` for every held slot, and its hint line advertises `stacks --reap`.

Cause (assessment, not proof): some foreign actor (a verifier running
`stacks --reap`, or stack startup while 3/3 slots are held) reaps stacks it considers
uncovered. The slot registry never records the owned stack (`stack=none`), so
coverage cannot be distinguished from the outside.

Recovery (worked twice): `pnpm dev:start --no-attach mobile cloud-agent-next kiloclaw
event-service` (same ports return), restart the CLI relay in its tmux window
(`remote-cli.sh exec remote` → `Remote connection enabled.`), re-prove
`session list --pure`, re-anchor the dev client with the deep link, and re-run only
the failed iteration. Memory iterations completed before the kill stay valid
(meminfo is device-local). A third kill would have been reported BLOCKED instead.
