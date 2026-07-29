# docs-sync edit-pass repro: reset round state between B1/B2

**Symptom:** A second repro round of `.github/docs-sync/edit.mjs` returns instantly with
"edit pass complete" while doing no agent work.

**Cause:** `edit.mjs` has no stale-summary cleanup. After each `runKilo` call it checks
`fs.existsSync(summaryFile)` (`edit.mjs:92`) and returns success immediately — so a leftover
`docs-sync-out/edit-summary-<n>.json` from the previous round short-circuits the round. Leftover
doc edits in `packages/kilo-docs` additionally change the agent's starting state (it will skip
already-documented PRs), breaking comparability between rounds.

**Fix:** Between rounds, in the kilocode worktree:
`rm -rf docs-sync-out && git checkout -- packages/kilo-docs`, then re-copy the fixtures
(`worthy.json`, `triage.json`) per the handoff setup. Also delete any stray
`edit-summary-*.json` / `.docs-sync-summary.json` at the repo root (the agent sometimes drops the
`docs-sync-out/` prefix; the script tolerates and renames those, see edit.mjs:94-97).

Verified 2026-07-28 in the docs-sync-cli-47f4 repro (kilocode worktree, CLI 7.4.16).
