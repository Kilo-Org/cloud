# Workflow-create benchmark driver

This driver measures how fast and how correctly the extension creates a
workflow for a pinned scenario in safe mode. It runs N identical attempts
with `kilo-auto/efficient` on the production gateway, records redacted
per-attempt JSON plus a batch summary, and exits 0/1/2.

The purpose is to pick optimization levers from measured evidence, not from
intuition. Every metric, definition, and scenario pin is fixed; see the A/B
protocol and honesty rules before changing anything.

## Scenarios

The golden-star scenarios live in
`src/shared/agent-workflow-bench-scenarios.ts`. Each is one realistic
"automate what I do in the browser" request on a public, login-free site.
Together they cover the common task shapes: SPA searches, query-parameter
searches, path-encoded lookups, filtered lists, GET forms, price/status
lookups, and a zero-param "just run it" workflow.

| Id | Site | Task |
|---|---|---|
| `flights` | Google Flights | business-class flights (destination, date) |
| `hn` | hn.algolia.com | stories about a topic |
| `wikipedia` | en.wikipedia.org | article summary for a topic |
| `github` | github.com | open issues by repo and label |
| `weather` | forecast.weather.gov | forecast for a city (GET form) |
| `youtube` | youtube.com | videos about a topic |
| `npm` | npmjs.com | package search |
| `mdn` | developer.mozilla.org | docs search |
| `stackoverflow` | stackoverflow.com | recent questions for a tag |
| `arxiv` | arxiv.org | recent papers about a topic |
| `openlibrary` | openlibrary.org | book search |
| `coingecko` | coingecko.com | cryptocurrency price |
| `merriam` | merriam-webster.com | word definition |
| `allrecipes` | allrecipes.com | recipes using an ingredient |
| `npr` | text.npr.org | today's headlines (zero params) |
| `github-trending` | github.com | trending repos for a language |
| `crates` | crates.io | Rust crate search |
| `timeanddate` | timeanddate.com | local time in a city |
| `stockanalysis` | stockanalysis.com | stock price by ticker |
| `remoteok` | remoteok.com | remote jobs for a keyword |

An attempt sends the scenario's create message, waits for a successful
save, then always sends the pinned follow-up run request. Correctness is
scored per scenario: the stored workflow's scope, params, and script
markers, plus a verifying run whose input binds the pinned values and whose
result carries the expected values and content (a price, points, a
forecast, …). The verifying run is the last valid real run, or a dry run
with real navigated content when no real run exists.

## Prerequisites

- Repository dependencies installed (`pnpm install` at the repo root).
- A valid production Kilo CLI token in `~/.local/share/kilo/auth.json`. The
  driver validates it against `https://app.kilo.ai/api/user` before any
  attempt. The token lives only inside the throwaway browser profile, which is
  deleted and verified after each attempt.
- Network access to `app.kilo.ai` and the scenario sites.
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
| `--scenario <id>` | Scenario id (see table above). Default `flights`. |
| `--out <dir>` | Output directory. Default: a fresh temp directory. |
| `--no-build` | Skip the self-build. The caller then owns build freshness. |
| `--timeout-ms <ms>` | Per-attempt agent-phase deadline. Default `900000`. |
| `--date <YYYY-MM-DD>` | Follow-up date. Default: today + 45 days. |
| `--append` | Extend an existing batch in `--out`. Refuses a different `gitHead`, scenario, follow-up date, or org hash. |

Examples:

```sh
# A faster probe batch of 2 attempts on the hn scenario.
pnpm exec tsx apps/extension/scripts/workflow-create-benchmark.ts --attempts 2 --scenario hn

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

### Raw debugging artifacts

`KILO_BENCH_RAW=1` additionally writes `attempt-<n>-raw.json` with the full
unredacted transcript and stored workflows. This is for local failure
analysis only. Never commit a raw artifact and never attach one to a PR: it
contains page content and model text verbatim.

## A/B protocol

Compare batches only when they share every variable except the one lever:

- Same `N`, the same `--scenario`, and the same `--date` (the baseline's
  follow-up date).
- Same scenario pins: page, message, model, mode, and settings.
- Same attempt-by-attempt rendering-mode sequence: the ordered headed/headless
  flags of both batches must match position by position, not just in
  aggregate. A batch whose attempts mix modes (`mixedModes: true` in its
  summary) is invalid for comparison and is rerun.
- One product variable per step.
- Compare against the latest accepted head's batch, never the original
  baseline after later changes landed.
- Judge by medians, and only keep a win: median `createToSavedSeconds`
  improves ≥ 10% over the comparison batch, every attempt passes the full
  correctness check, neither batch is mixed-mode and the mode sequences
  match attempt by attempt, and the after-median lies outside the overlap of
  both batches' min–max ranges.
- An inconclusive step — the after-median improves ≥ 10% but still lies
  inside the overlap of both batches' min–max ranges — extends each batch
  once with `--attempts 2 --append --out <same dir>` before deciding. A
  median improvement below 10% is not a win and gets no extension.

## Honesty rules

- Every batch records its `gitHead`; never compare batches recorded on
  different heads as if they were one population.
- Never tune the product for a benchmark site by name.
- Never edit the driver, the scenario, or the stored script between the
  compared arms of one A/B step.
