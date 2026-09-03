# Isolate Review — Live E2E Guide

Manual, scripted, **not CI**. One operator (an agent is fine) runs it end to
end. It costs a small amount of real inference spend and takes a few minutes.

The run proves the worker can drive a real Think agentic loop — a live model,
real workspace and GitHub tools, the **production** GitHub review prompt — while
never touching `github.com`, never needing a GitHub PAT, and never publishing.

Do **not** add this to `pnpm test` or CI.

---

## 1. What it proves

| Claim | Evidence |
|---|---|
| Think actually loops | Transcript interleaves LLM turns with tool calls |
| Workspace tools work | A `read`/`grep`/`list`/`find` succeeds against a real tree |
| GitHub tools work | A `pr_*` call returns fixture data; `upsert_summary` is called |
| The live prompt is used | First user message is production `generateReviewPrompt` + skill cue + runtime bridge |
| Real code is reviewed | Multi-file public-repo snapshot; tool paths exist in that tree |
| Nothing is published | `dryRun: true`, fixture write log empty, `published` unset |

Out of scope: the clone OOM ceiling, incremental/council/roast reviews,
Bitbucket/GitLab, and comment quality as a hard fail.

---

## 2. Run it

```sh
# 1. Before starting Wrangler, put these exact non-secret values in the
#    gitignored services/isolate-review/.dev.vars:
GITHUB_API_URL=http://127.0.0.1:8877
GIT_CLONE_URL_TEMPLATE=http://127.0.0.1:8877/{owner}/{repo}.git

# 2. Stack — nextjs (gateway proxy), postgres, cloudflare-isolate-review, auto-routing
KILO_PORT_OFFSET=auto pnpm dev:start isolate-review auto-routing
pnpm dev:status --json

# 3. A worktree on a port offset has an empty DB
pnpm test:db

# 4. Identity with credits, then a token
pnpm dev:seed app:create-user "Isolate E2E" kilo-evgeny-isolate-e2e@example.com
pnpm dev:seed app:add-credits <user-id> 10
export KILO_TOKEN=$(pnpm -s dev:seed app:api-token kilo-evgeny-isolate-e2e@example.com \
  --expires-days=1 --json | jq -r .token)

# 5. Run
pnpm exec tsx services/isolate-review/scripts/run-e2e.ts
```

Blank values select the public GitHub defaults and are unsafe for this E2E.
The fixture does not need to be listening when Wrangler starts; `run-e2e.ts`
starts it on port 8877 immediately before submitting the review. If you change
either `.dev.vars` value, restart the Worker with:

```sh
pnpm dev:restart cloudflare-isolate-review
```

A reused stack must already have been started or restarted with these values.
The harness fails before the POST if the on-disk configuration does not match.

Exit 0 means every hard check passed. There is no `package.json` script — invoke
the harness directly.

**Reuse an existing session if it already has those services.** Do not start a
competing stack; if a service is missing, stop and recreate. Read ports from
`.dev-port`, `pnpm dev:status --json`, or `dev/logs/manifest.json` — never
assume 3000 or 8819.

`auto-routing` is only needed so `kilo-auto/efficient` can `/decide`. If
`/decide` fails or times out (2s), the gateway falls back to balanced Qwen —
still a real LLM. The harness warns and logs which model actually ran.

Inference uses the real provider keys already in this worktree's `.env.local`.
There is no mock LLM.

### Environment

| Variable | Source | Purpose |
|---|---|---|
| `KILO_TOKEN` | `dev:seed app:api-token` | Bearer for `/reviews` **and** the gateway credential |
| `INTERNAL_API_SECRET` | env, else read from the worker's `.dev.vars` | `x-internal-api-key` header |
| `ISOLATE_E2E_REQUIRE_TASK=1` | optional | Adds the sub-agent hard checks (§5) |

Both secrets must match what Next.js and isolate-review are configured with.

### What the harness does

Starts the fixture itself (`startFixture` from `e2e-fixture-server.ts` — do not
launch it separately), renders the live prompt, `POST`s `/reviews`, polls
`GET /reviews/:runId` every 5s for up to 10 minutes, fetches
`GET /reviews/:runId/messages`, evaluates the checks, writes artifacts, stops the
fixture, and leaves the stack running.

Request body: fixture `owner`/`repo`/`pullNumber`/`headSha` from `meta.json`,
`gitToken: "e2e-not-a-github-token"`, `model: "kilo-auto/efficient"` (not
`kilo/auto-efficient`), `dryRun: true`, and the rendered `userPrompt`.

### Artifacts

`services/isolate-review/scripts/last-e2e/` (gitignored):
`prompt.txt`, `status.json`, `transcript.json`, `writes.json`, `elapsed-ms.txt`,
`verdict.json`.

---

## 3. Why it is built this way

**No GitHub network.** The worker talks only to a local fixture. Hitting public
GitHub is out of scope, and a `dryRun` bug would otherwise post to a real PR.

**`gitToken` is the offline seam, not the auth path.** `Authorization: Bearer`
is always the seeded Kilo JWT. The dummy `gitToken` is accepted only because
`ENVIRONMENT=development`; production omits it and mints a repository-scoped
token through `GIT_TOKEN_SERVICE`.

**Real code, not a toy file.** The fixture is a `tj/commander.js` snapshot —
dozens of files, a real PR diff. A two-line planted null-deref would not force
the agent to read the tree.

**`pr_diff` still `fetch`es.** The production code path is preserved; only the
URL changes. Production clones head-only (`depth: 1`) and cannot derive a PR
diff from git, so the fixture keeps both base and head. Never call
`api.github.com` at harness setup either — the diff is vendored.

**Writes never leave the machine.** `dryRun: true` is sent explicitly;
`submit_review`/`upsert_summary` return `{ dryRun, wouldSend }` without
`fetch`ing. The fixture still implements `POST`/`PATCH` and records them — a
non-empty log means dry-run is broken and the run fails. **Never set
`dryRun: false` for this e2e.**

**Two prompt adapters, and only two.** The user message is exactly what
production sends, plus (1) a cue to `activate_skill` with
`{"name":"github-cloud-review"}` before the first `pr_*` call, and (2) a short
runtime bridge listing the real tools and mapping `gh`/`git`/`bash` examples onto
`pr_view`/`pr_diff`/`pr_comments`/`submit_review`/`upsert_summary` and
`read`/`grep`/`list`/`find`, noting the repo is at `/workspace` with
repo-relative comment paths. Without (2) this becomes "does the live prompt fail
on isolate?", a different experiment.

The **system** prompt stays exactly as shipped. Isolate's own
`src/prompt/review-policy.md` is deliberately *not* the user message here — a
hard check asserts it isn't.

---

## 4. The fixture

Already vendored under `scripts/fixtures/` — nothing is fetched at run time:

```
review-fixture.bundle      git bundle, unpacked to .work/ (gitignored) on start
github/repo.json           GET /repos/:o/:r  → small size
github/pull.json           GET /repos/:o/:r/pulls/1
github/pull.diff           Accept: application/vnd.github.diff
github/files.json          GET .../pulls/1/files
github/{comments,issue-comments,reviews}.json   all []
meta.json                  owner, repo, pullNumber, headSha, baseSha, source
```

Subject: `tj/commander.js`, base `201d9324`, head `c635fad5`, served as
`kilo-e2e/review-fixture` PR 1. The bundle is unpacked and served over git smart
HTTP so the clone URL template substitution works; the Bearer token is ignored.
`POST`/`PATCH` to anything is recorded and answered `200`.

To re-snapshot from a different PR: edit the SHAs in
`scripts/snapshot-fixture.ts` and run it. It clones anonymously over HTTPS, keeps
base and head, computes the diff and file list locally, and rewrites
`meta.json`.

---

## 5. Pass / fail

**Hard — all must pass:**

- `202`, then a terminal `status === "completed"`, `error` absent
- `published` not `true`, `publishedAt` absent
- Fixture `POST`/`PATCH` log empty
- A successful `pr_view` / `pr_diff` / `pr_comments` call
- A successful `read` / `grep` / `list` / `find` call, and at least one
  `read`/`grep` path that exists in the fixture tree (not hallucinated)
- `upsert_summary` present, `output.dryRun === true`, `wouldSend` body starts
  with `<!-- kilo-review -->`
- If `submit_review` is present: `dryRun === true` and every comment `path` is
  repo-relative (no `/workspace/` prefix)
- No tool named `write`, `edit`, `delete`, or `bash`
- First user message contains `gh pr view`, `HARD CONSTRAINTS`, and
  `<!-- kilo-review -->`, and does **not** start with isolate's own policy
  paragraph

With `ISOLATE_E2E_REQUIRE_TASK=1`, five more: exactly one completed `task`
delegation; it targets the concrete `lib/argument.js` / `lib/option.js` area;
the child returns a non-empty verdict in both structured metadata and the
completed XML envelope; the parent continues reviewing afterwards; and the
dry-run summary agrees with the child's verdict and assigned files.

The default fixture is a **Small** review (5 files, <100 changed lines), so the
policy permits at most one sub-agent. `ISOLATE_E2E_REQUIRE_TASK=1` adds a
test-only instruction delegating one risky area; default behavior is unchanged.

**Soft — logged, never fatal:** whether a real defect was flagged on a changed
line; whether `submit_review` lines exist on `pull.diff`'s RIGHT side; wall
clock, tool-call and message counts; which concrete model `/decide` chose;
whether "No Issues Found"; any tool error the agent recovered from.

A clean "No Issues Found" is a valid hard pass if the tools were used on the
real tree.

---

## 6. Triage

| Symptom | Likely cause |
|---|---|
| `status: cloning` then a GitHub/401 error | Worker still pointing at `api.github.com`; check `GITHUB_API_URL` / `GIT_CLONE_URL_TEMPLATE` |
| `RepoTooLargeError` | Fixture `repo.json` `size` is wrong |
| `Think rejected the review submission` | `userPrompt`, token, or model missing |
| `401` from the gateway, or "kiloToken may have expired" | Bad JWT, no credits, or `KILO_GATEWAY_URL` not pointing at the local Next proxy |
| Completes with zero tool calls | Live prompt without the runtime bridge, or tools missing from `beforeTurn` |
| Only `gh`-shaped failures, no `pr_*` | Bridge missing, or the model never switched tools |
| Fixture write log non-empty | `dryRun` not applied — check `isDryRun` and that input was persisted |
| `published: true` | `markPublished` ran; the dry-run short-circuit is broken |
| Timeout at 10 min | Watch `dev/logs/cloudflare-isolate-review.log`; check `maxSteps` and the gateway |
| Clone fails at runtime with a missing-module error | `@platformatic/vfs` not installed — Computer's git adapter imports it lazily |

Env changes to the worker need a restart, not a new session:
`pnpm dev:restart cloudflare-isolate-review`.

---

## 7. Last recorded run

2026-08-23 — **PASS** in 80s, 18 tool calls, run
`a1f0cb72-b4b5-4442-a025-d000a72b6c8b`. All hard checks passed. Soft: "No Issues
Found", no `submit_review`. Tools hit the real tree (`lib/argument.js`,
`lib/command.js`, `lib/option.js`, tests). Fixture write log empty.

The first attempt failed on a Next.js `/api/openrouter` 500 for a missing
`USER_DELETION_AUDIT_HMAC_KEY`; adding the dummy keys from `.env.local.example`
and restarting nextjs fixed it.

See `DESIGN.md` for how the service itself works.
