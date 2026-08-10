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
| `tmdb` | themoviedb.org | movie lookup |
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

## Task scenarios (use-case benchmark)

The workflow scenarios cover one use case: repeatable automation. The task
scenarios in `src/shared/agent-task-bench-scenarios.ts` cover the rest of
the most popular browser-agent use cases. The ranking is data-driven, from
install counts, feature-popularity reviews, and platform feature bets for
the top AI browser extensions and agentic browsers (Sider 5M installs,
Monica 3M, Merlin 900k, MaxAI 700k, Immersive Translate 20M+, Edge
Copilot, Gemini in Chrome, Perplexity Comet, HARPA AI):

1. Summarize the page — the lead feature of every top extension.
2. Page Q&A — the core sidebar function (chat grounded in the open tab).
3. Write and reply — draft text from page content.
4. Translate — full-page translation to the user's language.
5. AI search/research — search-grounded answers via the `web_search` tool.
6. Multi-tab compare — read several tabs (single-tab harness today; gap).
7. Agentic actions — fill forms, log in, operate the page.
8. Repeatable automation — the twenty workflow scenarios above.

Reading tasks (1, 2, 4) carry roughly 80% of real usage; acting tasks lead
the marketing but trail in adoption. Use case 6 remains a documented gap:
the harness reads only the selected tab.

| Id | Use case | Site | Mode | Task |
|---|---|---|---|---|
| `summarize-article` | summarize | paulgraham.com | safe | summarize a ~67k-char essay end to end |
| `qa-deep-fact` | page-qa | en.wikipedia.org | safe | a fact ~50k chars into the page |
| `extract-table` | extract | books.toscrape.com | safe | titles and prices as a markdown table |
| `translate-page` | translate | de.wikipedia.org | safe | English summary of a German page |
| `draft-reply` | draft | github.com | safe | grounded reply to a closed issue |
| `web-research` | research | example.com | safe | a fact the page cannot answer, via `web_search` |
| `action-login` | act | saucedemo.com | dangerous | log in, count products |
| `action-cart` | act | saucedemo.com | dangerous | log in, add to cart, read badge |

A task attempt sends one pinned message and scores the final assistant
answer: pinned content checks, a minimum length, and — for facts a model
could know from training — the same pattern must also appear in an ok tool
result (harness metadata strings such as the paging note and snapshotId
never count). That evidence rule exists because the truncation-era
baseline model answered a summarize task "from familiarity" with the essay
while presenting it as page content. A generative scenario may set
`minAnswerCheckPasses`: a model that provably read the whole page can
still pick its own top themes, so the summary needs a quorum of theme
checks, while evidence gates always stay mandatory. Action scenarios
additionally require one ok action exchange — `eval` or a real (non-dry)
`run_workflow`, both legitimate harness action paths. Task batches gate on
the turn total (`TASK_SPEED_LIMIT_SECONDS`, 120 s) instead of save timing.

The deep-content scenarios exist because the page snapshot text is a
bounded window (8000 chars). `summarize-article` and `qa-deep-fact` fail
on any harness that cannot read or search past that window; they hold the
fix honest (snapshot `textStart` paging plus full-page `find_in_page`).

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
| `--model <id>` | Gateway model id. Default `kilo-auto/efficient`. |
| `--append` | Extend an existing batch in `--out`. Refuses a different `gitHead`, scenario, model, follow-up date, or org hash. |

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

The transcript is redacted: user/assistant/thinking text becomes
`<text: N chars>`, `save_workflow` arguments keep pinned metadata with the
script reduced to its length, other tool arguments keep scalar values capped
at 120 characters (the benchmark's own pinned queries and ids — never page
content), page-content tool results keep only byte counts, `run_workflow`
results keep only `ok`, `pagesVisited`, and `resultChars`, and workflow or
memory tool results keep an allowlist of metadata keys plus content lengths.
No token and no raw storage value is persisted.

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
