# OpenClaw Upgrade Runbook

When a new OpenClaw release is published, an automated watcher opens a draft bump PR in this
repo and posts a Slack notification. This runbook tells you exactly what to do from that point
to a merged, production-deployed upgrade.

**Lab repo**: https://github.com/Kilo-Org/kiloclaw-openclaw-upgrade-lab
**Open bump PRs**: https://github.com/Kilo-Org/cloud/pulls?q=feat%2Fbump-openclaw+is%3Aopen

---

## Prerequisites (one-time setup)

1. Clone the lab repo:
   ```bash
   git clone git@github.com:Kilo-Org/kiloclaw-openclaw-upgrade-lab.git
   ```
   Keep it alongside your cloud checkout. The lab clones cloud read-only during a run, so
   they do not need to share a directory.

2. Confirm Docker is running and `grype` is installed:
   ```bash
   docker info >/dev/null
   grype version || brew install grype
   ```

3. Get a **dedicated free-model Kilo API key** (not your personal key). Obtain one from
   https://app.kilo.ai/profile (bottom of page). This is used only for the live smoke in
   Step 3. Store it somewhere you can export it when needed:
   ```bash
   export KILOCODE_API_KEY=<your-dedicated-free-model-key>
   ```

---

## When multiple bump PRs are open

The bump bot opens one PR per version. If several are open (for example 2026.6.9, 2026.6.10,
and 2026.6.11 are all open simultaneously), certify only the **highest version** — it
supersedes the others. Close the older PRs with a comment: "superseded by #NNNN". The
highest-version PR's automated assessment already covers the full span from the current
deployed pin.

---

## Step 1 — Read the automated assessment

Open the Slack notification and click **Review PR**. Read the assessment block in the PR body:

- **Scores**: Breaking changes, Security, Deployment, Behavior, Span — each Low / Medium / High.
- **Recommendation**: `Review carefully` or `Hold`.

If the recommendation is **Hold**: stop. The bump bot flagged a breaking change, a high
deployment risk, or a suspicious release body. Bring it to the team before proceeding.

If the recommendation is **Review carefully**: continue to Step 2.

---

## Step 2 — Run the lab certification (Phases 1–5)

The lab is an adversarial review agent. It reads every release note in the span, maps each
change to KiloClaw's 11 integration touchpoints, and reviews the actual diff in the bump PR.
You start it, then review its outputs at two human gates. You do not run the analysis phases
yourself — the agent does.

### 2a. Update the lab repo and note the PR details

```bash
cd kiloclaw-openclaw-upgrade-lab
git pull origin main
```

Note the PR number and the two version strings from the PR title, for example: PR #4335,
`2026.6.8` → `2026.6.11`.

### 2b. Open Kilo in the lab repo

Open a new Kilo session with the **lab repo** as the working directory.

### 2c. Start the certification run

Send the following message to Kilo, substituting the actual PR number and versions:

```
Run the kiloclaw-openclaw-upgrade certification for PR Kilo-Org/cloud#4335,
upgrading openclaw from 2026.6.8 to 2026.6.11. Clone the cloud repo read-only
and write all artifacts to history/2026.6.8-2026.6.11/.
```

The agent will:

- Clone the `cloud` repo read-only and check out the bump PR head
- Run **Phase 1**: build the full changelog matrix across every version in the span
- Run **Phase 2**: per-change impact analysis against all 11 KiloClaw touchpoints, with
  multi-pass convergence per change

This runs unattended. Expected duration:

| Span | Approximate time |
|---|---|
| 1–3 releases | 20–40 minutes |
| 4–10 releases | 1–1.5 hours |
| 10+ releases | 2–3 hours |

The agent writes everything to `history/{from}-{to}/` in the lab repo as it goes. You can
check progress by reading `history/{from}-{to}/LOG.md`.

### 2d. ITL Gate 1 — Review the Impact Report

The agent pauses and presents `history/{from}-{to}/IMPACT_REPORT.md`. Open that file and read
it. It answers: does any change in this span require a code fix to the KiloClaw controller,
Dockerfile, config writer, or bootstrap before it is safe to ship?

**If the report lists Required Changes:**

The bump branch needs fixes before proceeding. The lab cannot push to cloud (it has read-only
access), so you apply the fixes:

1. Check out the bump branch in your cloud clone:
   ```bash
   git fetch origin
   git switch feat/bump-openclaw-<TARGET>
   ```
2. Apply the fixes described in the impact report.
3. Commit and push to the bump branch.
4. Tell the lab agent: "Required changes are applied. Please re-run Phase 3 keyless
   validation and continue to Phase 4."

**If the report lists no Required Changes:**

Tell the lab agent: "Impact report approved. Please continue to Phase 4."

### 2e. Wait for Phases 3–5 (unattended)

The agent runs:

- **Phase 3 (keyless validation):** builds the candidate image, checks Dockerfile bundle patch
  guards, plugin pin alignment, config-shape validation, and a grype CVE scan. No API key
  needed.
- **Phase 4 (per-change adversarial review):** reviews each individual change in the bump diff.
- **Phase 5 (combined adversarial review):** reviews all changes together for cross-change
  interactions, version consistency, and completeness.

### 2f. ITL Gate 2 — Review the Review Reports

The agent pauses and presents `history/{from}-{to}/REVIEW_REPORT_PER_CHANGE.md` and
`history/{from}-{to}/REVIEW_REPORT_COMBINED.md`. Open both and read the overall verdicts.

- **Any FAIL**: there is a correctness or safety problem in the bump. Apply the fix in the
  cloud bump branch, then tell the agent: "Fix applied. Please re-run Phase 3 validation and
  re-review the affected change."
- **Any CONCERN**: engineering judgment call. A concern is addressable but not blocking.
  Decide whether to fix now or accept and note it.
- **All PASS**: tell the agent: "Review approved. Certification complete." The agent commits
  the certification record to the lab repo and opens a PR there.

---

## Step 3 — Run the local smoke (Phase 6)

Phase 6 is the only step you run directly from the cloud repo. Run it only after the lab
certification passes both ITL gates.

```bash
# From your cloud clone, on the bump branch:
git fetch origin
git switch feat/bump-openclaw-<TARGET>

export KILOCODE_API_KEY=<your-dedicated-free-model-key>
bash services/kiloclaw/scripts/tests/openclaw-upgrade-validate.sh
```

The script runs two phases automatically and streams output as it goes:

**Phase 1 (keyless, ~10 min):** builds the candidate image; checks bundle patch guards, plugin
pin alignment, and config-shape validation; runs a grype CVE scan.

**Phase 2 (credentialed, ~20 min):** builds the baseline image from `origin/main` and the
candidate image from `HEAD`. Boots the baseline on a fresh temporary `/root`, stops it, then
boots the candidate on the **same `/root`** — this is the persisted-root upgrade test, which
exercises `openclaw doctor` booting against a baseline-generated config. Runs a full assertion
suite including a live agent turn through Auto Free.

The script prints a summary at the end:

```
Phase 1 (keyless verification): passed  (N passed, 0 failed)
  grype CVE scan: Critical=0 High=N Medium=N ...
Phase 2 (credentialed smoke):   passed  (N passed, 0 failed)
```

Both phases must pass before continuing. If either fails, read the output above the summary
line, fix the issue on the bump branch, and re-run the script.

---

## Step 4 — Run submission gates

```bash
# Ensure Postgres is running for the test suite:
docker compose -f dev/docker-compose.yml ps postgres
# If not running:
pnpm test:db

pnpm typecheck && pnpm test && pnpm lint
```

All three must pass.

---

## Step 5 — Post evidence on the PR and mark ready

Add a comment to the bump PR with:

- Before and after OpenClaw versions
- Phase 1 pass/fail count and grype CVE severity totals (no raw findings, no file paths)
- Phase 2 pass/fail count and confirmation that the live agent turn passed
- Any diagnostics that surfaced and their assessed impact
- Link to the lab certification record in the lab repo

Example:

```
## Smoke results — openclaw 2026.6.8 -> 2026.6.11

Phase 1 (keyless): 7 passed, 0 failed
  grype: Critical=0  High=4  Medium=22  Low=18

Phase 2 (credentialed persisted-root): 14 passed, 0 failed
  Live Auto Free agent turn: passed

Lab certification: Kilo-Org/kiloclaw-openclaw-upgrade-lab — history/2026.6.8-2026.6.11/
  Impact report: no Required Changes
  Per-change review: PASS
  Combined review: PASS
```

Never paste API keys, gateway tokens, raw provider responses, or full container logs into the
PR.

Mark the PR as **ready for review** (remove draft status). Assign a second engineer. The second
engineer merges.

After merge, CI builds and publishes the image. The image is registered at
`rollout_percent = 0` and is not served to instances until promoted. See `DEVELOPMENT.md`
"Promoting a published image" for the promotion steps.

---

## Reference: what each repo owns

| Concern | Repo |
|---|---|
| Bump mechanics, Dockerfile, controller code | `cloud` |
| Smoke and validate scripts | `cloud` (`services/kiloclaw/scripts/tests/`) |
| Adversarial review methodology, touchpoint index | `kiloclaw-openclaw-upgrade-lab` |
| Per-release certification records | `kiloclaw-openclaw-upgrade-lab` `history/` |

The lab always operates against `cloud` read-only. It never pushes to `cloud`. Every fix the
lab identifies is a recommendation you apply manually to the bump branch.
