# Workflow-create benchmark driver

This driver measures how fast the extension can create a workflow for a fixed
scenario in safe mode. It runs N identical attempts against Google Flights
with `kilo-auto/efficient` on the production gateway, records redacted
per-attempt JSON plus a batch summary, and exits 0/1/2.

The purpose is to pick optimization levers from measured evidence, not from
intuition. Every metric, definition, and scenario pin is fixed; see the A/B
protocol and honesty rules before changing anything.

## Prerequisites

- Repository dependencies installed (`pnpm install` at the repo root).
- A valid production Kilo CLI token in `~/.local/share/kilo/auth.json`. The
  driver validates it against `https://app.kilo.ai/api/user` before any
  attempt. The token lives only inside the throwaway browser profile, which is
  deleted and verified after each attempt.
- Network access to `app.kilo.ai` and to Google.
- A display for headed Chromium. If the headed launch fails, the driver
  retries headless automatically and records which mode each attempt used.

## Run

One command, from the repo root:

```sh
pnpm exec tsx apps/extension/scripts/workflow-create-benchmark.ts
```

The driver self-builds the extension first (`pnpm run build` in
`apps/extension`) and refuses to start if the build output is missing.

Options:

| Flag | Meaning |
|---|---|
| `--attempts <n>` | Number of attempts. Default `3`, min `1`, max `10`. |
| `--out <dir>` | Output directory. Default: a fresh temp directory. |
| `--no-build` | Skip the self-build. The caller then owns build freshness. |
| `--timeout-ms <ms>` | Per-attempt agent-phase deadline. Default `900000`. |
| `--date <YYYY-MM-DD>` | Follow-up date. Default: today + 45 days. |
| `--append` | Extend an existing batch in `--out`. Refuses a different `gitHead` or follow-up date. |

Examples:

```sh
# A faster probe batch of 2 attempts.
pnpm exec tsx apps/extension/scripts/workflow-create-benchmark.ts --attempts 2

# Match an earlier batch's follow-up date.
pnpm exec tsx apps/extension/scripts/workflow-create-benchmark.ts --date 2026-09-21

# Extend an existing batch by 2 attempts in the same output directory.
pnpm exec tsx apps/extension/scripts/workflow-create-benchmark.ts --attempts 2 --append --out /path/to/batch
```

## Output

The driver writes into `--out`:

- `attempt-<n>.json` — one per attempt: scenario pins, `gitHead`, per-request
  gateway metrics, tool metrics, correctness predicates, and a redacted
  transcript.
- `summary.json` — the batch aggregate: `gitHead`, `startedAtIso`,
  `attempts`, `followUpDate`, scenario, `attemptsJson`, `successCount`,
  `speedGatePassed`, `mixedModes`, medians, and `maxCreateToSavedSeconds`.
- `blocker.json` — written and exit code `2` when the batch aborts on a
  blocker (build, auth, setup, non-production gateway URL, org hash
  mismatch, or cleanup failure).

Exit codes: `0` every attempt passed the correctness check; `1` at least one
attempt failed; `2` usage error or blocker.

The transcript is allowlist-redacted: user/assistant/thinking text becomes
`<text: N chars>`, tool arguments keep only pinned metadata and byte counts,
page-content tool results keep only byte counts, and `run_workflow` results
keep only `ok`, `pagesVisited`, and `resultChars`. No token, no raw storage
value, and no user content is persisted.

## A/B protocol

Compare batches only when they share every variable except the one lever:

- Same `N` and the same `--date` (the baseline's follow-up date).
- Same scenario: page, message, model, mode, and settings.
- One product variable per step.
- Compare against the latest accepted head's batch, never the original
  baseline after later changes landed.
- Judge by medians, and only keep a win: median `createToSavedSeconds`
  improves ≥ 10% over the comparison batch, every attempt passes the full
  correctness check, neither batch is mixed-mode, and the after-median lies
  outside the overlap of both batches' min–max ranges.
- An inconclusive step (median moved but the ranges overlap) extends each
  batch once with `--attempts 2 --append --out <same dir>` before deciding.

## Honesty rules

- Every batch records its `gitHead`; never compare batches recorded on
  different heads as if they were one population.
- Never tune the product for the benchmark page by name.
- Never edit the driver, the scenario, or the stored script between the
  compared arms of one A/B step.
