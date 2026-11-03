<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

ci: remove scheduled "Check for new OpenClaw release" workflow and update upgrade runbook

## Problem

Issue #8966 asks to remove the `Check for new OpenClaw release` GitHub Action. It lives in `.github/workflows/bump-openclaw.yml` and runs every 12 hours (or by manual dispatch). It compares the OpenClaw pin in `services/kiloclaw/Dockerfile` with the latest stable `openclaw/openclaw` tag. When a release is less than 24h old, it POSTs to the external `OPENCLAW_BUMP_WEBHOOK_URL`. That webhook starts the cloud agent, which opens the bump PR and posts to Slack. Separately, `services/kiloclaw/docs/openclaw-upgrade-runbook.md` (line 3) says an automated watcher opens the bump PR and posts to Slack.

## Evidence

- .github/workflows/bump-openclaw.yml line 1 is `name: Check for new OpenClaw release`. It has triggers `schedule` (cron `0 */12 * * *`) and `workflow_dispatch`, and a final step that curls `secrets.OPENCLAW_BUMP_WEBHOOK_URL` with `secrets.KILOCLAW_GITHUB_WEBHOOK_TRIGGER_TOKEN`.
- Searching for `bump-openclaw.yml` only finds historical notes in `.plans/monorepo-restructure*.md`. Searching `.github` for `openclaw` finds other hits only in `ci.yml` (plugin pin check), `deploy-kiloclaw.yml` and `push-dev-kiloclaw.yml`. Those read the Dockerfile pin and do not depend on this workflow.
- services/kiloclaw/docs/openclaw-upgrade-runbook.md line 3 says: 'an automated watcher opens a draft bump PR in this repo and posts a Slack notification'. Lines 38 and 53 refer to 'the bump bot'.
- services/kiloclaw/scripts/openclaw-bump.sh does the bump itself (`openclaw-bump.sh <TARGET_VERSION>`) and does not need the watcher workflow. services/kiloclaw/scripts/tests/openclaw-upgrade-validate.sh line 188 mentions the bump bot only in help text.

## Desired outcome

The repository no longer contains the scheduled OpenClaw release-watcher workflow, so GitHub stops running it and stops calling the bump webhook. The upgrade runbook no longer says a watcher in this repo opens bump PRs automatically.

## Scope

- Delete `.github/workflows/bump-openclaw.yml`.
- Change the opening paragraph of `services/kiloclaw/docs/openclaw-upgrade-runbook.md`. It should no longer say an in-repo automated watcher opens bump PRs. Instead it should say a bump PR is the starting point, and that one can be created with `services/kiloclaw/scripts/openclaw-bump.sh <TARGET_VERSION>`. Keep the rest of the runbook's process as it is.

## Exclusions

- No changes to `openclaw-bump.sh`, `openclaw-upgrade-validate.sh`, the lab repo, `deploy-kiloclaw.yml`, `push-dev-kiloclaw.yml`, or the plugin pin check in `ci.yml`.
- No edits to historical `.plans/monorepo-restructure*.md` notes.
- Retiring the GitHub secrets `OPENCLAW_BUMP_WEBHOOK_URL` and `KILOCLAW_GITHUB_WEBHOOK_TRIGGER_TOKEN`, and the external openclaw-bump webhook trigger configuration, can't be done from the repo. The maintainer does that as an out-of-repo follow-up.
- No replacement release-detection mechanism will be added.

## Approach

- Delete the workflow file outright. Nothing else in the repo references it, so no other code needs to change.
- Make a small edit to the runbook intro (lines 3–5) so it describes how a bump PR is created now (manually with `openclaw-bump.sh`). Leave the 'bump bot' wording later in the runbook alone, since the bump PR and its assessment still exist when produced by the script or agent.
- In the PR description, list the now-unused secrets and the external webhook trigger as manual follow-ups, and say that #6248's fork-guard scope no longer includes this file.

## Affected areas

- .github/workflows/bump-openclaw.yml (deleted)
- services/kiloclaw/docs/openclaw-upgrade-runbook.md (intro wording)

## Acceptance criteria

### ac-1: `.github/workflows/bump-openclaw.yml` is deleted, and no workflow under `.github/workflows` has the name `Check for new OpenClaw release` or posts to `OPENCLAW_BUMP_WEBHOOK_URL`.

**Verification:** Source review

### ac-2: The opening of the OpenClaw upgrade runbook no longer says an automated watcher in this repo opens bump PRs or posts Slack notifications. It points to `services/kiloclaw/scripts/openclaw-bump.sh <TARGET_VERSION>` as a way to create the bump PR, and the rest of the runbook steps are unchanged.

**Verification:** Source review

### ac-3: The other OpenClaw-related workflows (`ci.yml` plugin pin check, `deploy-kiloclaw.yml`, `push-dev-kiloclaw.yml`) and the bump and validate scripts are unchanged.

**Verification:** Code review

## Risks

- Bump PRs for new OpenClaw releases will no longer be opened automatically. Someone has to start upgrades by hand. This is the intended result of the issue.
- If a replacement watcher exists outside this repo, the new runbook wording may need a pointer to it. This is low risk and easy to fix later in the docs.
- The unused secrets and the external webhook trigger stay live until someone retires them by hand.

## Assumptions

- The issue means to retire automated release detection, not move it elsewhere. The title says 'Clean up/remove', and no successor workflow exists in the repo.
- Manual bumping with `openclaw-bump.sh` remains the supported way to upgrade.

## Decisions

### d-1: Should the now-unused secrets and the external webhook trigger be retired as part of this change?

**Answer:** Not in the repo PR. They live outside the repository, so the PR description lists them as manual follow-ups for the maintainer.

**Blocking:** no

### d-2: Should the runbook be updated along with the workflow deletion?

**Answer:** Yes, but only the intro paragraph, so the docs don't describe a watcher that no longer exists.

**Blocking:** no
