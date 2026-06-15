#!/usr/bin/env bash
set -euo pipefail

# Deterministic OpenClaw version bump for the KiloClaw image.
#
# The GitHub job runs this. Given a target version it edits the pinned
# touchpoints, regenerates the lockfile, and opens a DRAFT PR.
#
# Create-once and terminal: it queries all PR states for the org-owned bump
# branch. If an open PR exists the script does not bump again; instead it reports
# how far that PR got so the caller can resume: action=resume-assessment when the
# assessment is still pending, resume-notify when it is written but Slack has not
# posted, skip-open-pr when it is fully done. A closed PR means the version was
# already proposed and is not recreated (override with BUMP_FORCE_RECREATE=true).
# A leftover branch with no PR is not auto-recovered; delete it and re-run, or set
# BUMP_FORCE_RECREATE=true to clear it. There is no force push. Pin consistency is
# validated by scripts/check-plugin-openclaw-pin.sh before publishing, and by CI.
#
# Usage:
#   services/kiloclaw/scripts/openclaw-bump.sh <TARGET_VERSION>
#   TARGET_VERSION env var is also accepted.
#
# Requires: bash, git, gh (authenticated), pnpm, node, sed. Run from a clean
# checkout of main.
#
# Env:
#   BUMP_ALLOW_DIRTY=true     local edits-only mode: edit + validate, never remote.
#   BUMP_SIGN_COMMITS=false   disable commit signing (default is to require it).
#   BUMP_FORCE_RECREATE=true  recreate even if a closed PR exists for the version,
#                             and clear a leftover branch instead of stopping.
#   NODE_OPTIONS              passed to the lockfile step; defaults to
#                             --max-old-space-size=6144 if unset.

TARGET="${1:-${TARGET_VERSION:-}}"
REPO="${BUMP_REPO:-Kilo-Org/cloud}"
OWNER="${REPO%%/*}"
ASSIGNEES="${BUMP_ASSIGNEES:-St0rmz1,pandemicsyn}"
GIT_NAME="${BUMP_GIT_NAME:-github-actions[bot]}"
GIT_EMAIL="${BUMP_GIT_EMAIL:-github-actions[bot]@users.noreply.github.com}"
# Signing is required on the publish path by default. The workflow provisions the
# key; set BUMP_SIGN_COMMITS=false only for non-publishing local use.
BUMP_SIGN="${BUMP_SIGN_COMMITS:-true}"
ASSESSMENT_PLACEHOLDER="_Automated upgrade assessment pending._"
# Marker the notifier appends to the PR body after Slack posts. Its presence means
# the PR is fully handled; its absence on an assessed PR means notify is pending.
SLACK_MARKER="<!-- openclaw-bump: slack-notified -->"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

DOCKERFILE="services/kiloclaw/Dockerfile"
KILO_CHAT_PKG="services/kiloclaw/plugins/kilo-chat/package.json"
MORNING_PKG="services/kiloclaw/plugins/kiloclaw-morning-briefing/package.json"
E2E_DOC="services/kiloclaw/e2e/docker-image-testing.md"
CHANGELOG="apps/web/src/app/(app)/claw/components/changelog-data.ts"
# Single source of truth for the files the bump stages and commits.
BUMP_PATHS=("$DOCKERFILE" "$KILO_CHAT_PKG" "$MORNING_PKG" "$E2E_DOC" "$CHANGELOG" "pnpm-lock.yaml")

die() { echo "openclaw-bump: $*" >&2; exit 1; }

emit() {
  echo "$1=$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "$1=$2" >> "$GITHUB_OUTPUT"
  fi
}

emit_pr_result() {
  emit action "$1"
  emit current "$CURRENT"
  emit target "$TARGET"
  emit branch "$BRANCH"
  emit pr_url "$2"
}

# True (0) if version $1 is strictly greater than $2. Both are CalVer X.Y.Z with
# numeric segments, so compare segment by segment and avoid GNU-only `sort -V`
# (BSD sort on macOS has no -V).
version_gt() {
  local -a a b
  IFS=. read -r -a a <<< "$1"
  IFS=. read -r -a b <<< "$2"
  local i
  for i in 0 1 2; do
    if [ "${a[i]:-0}" -gt "${b[i]:-0}" ]; then return 0; fi
    if [ "${a[i]:-0}" -lt "${b[i]:-0}" ]; then return 1; fi
  done
  return 1
}

# Portable in-place replace of every occurrence of the current version with the
# target. Dots in the search are escaped so they match literally.
replace_version() {
  local file="$1" from_esc tmp
  from_esc="${CURRENT//./\\.}"
  tmp="$(mktemp)"
  sed "s/${from_esc}/${TARGET}/g" "$file" > "$tmp" && mv "$tmp" "$file"
}

apply_edits() {
  # The version string appears only in openclaw pins and notes in these files,
  # so a whole-version replace updates every occurrence with nothing to miss.
  replace_version "$DOCKERFILE"
  replace_version "$KILO_CHAT_PKG"
  replace_version "$MORNING_PKG"
  replace_version "$E2E_DOC"

  # Bump the COPY cache-bust counter so the image layer rebuilds. Only the
  # bare-integer `RUN echo "N"` line matches, not the apt cache-bust line.
  local n new tmp
  n="$(grep -oE 'RUN echo "[0-9]+"' "$DOCKERFILE" | head -n1 | grep -oE '[0-9]+' || true)"
  [ -n "$n" ] || die "could not find the RUN echo cache-bust counter in $DOCKERFILE"
  new=$((n + 1))
  tmp="$(mktemp)"
  sed "s/RUN echo \"${n}\"/RUN echo \"${new}\"/" "$DOCKERFILE" > "$tmp" && mv "$tmp" "$DOCKERFILE"

  # Refresh the adjacent "# Build cache bust:" comment so its date and vN label do
  # not drift; AGENTS.md asks for the comment to be updated alongside the counter.
  # replace_version already updated the openclaw-<version> part of the comment.
  local cv newcv
  cv="$(grep -oE 'Build cache bust: [0-9]{4}-[0-9]{2}-[0-9]{2}-v[0-9]+' "$DOCKERFILE" | grep -oE 'v[0-9]+$' | grep -oE '[0-9]+' || true)"
  if [ -n "$cv" ]; then
    newcv=$((cv + 1))
    tmp="$(mktemp)"
    sed "s/\(Build cache bust: \)[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}-v[0-9]\{1,\}/\1$(date +%F)-v${newcv}/" "$DOCKERFILE" > "$tmp" && mv "$tmp" "$DOCKERFILE"
  fi

  # Insert a changelog entry at the top of the array. Assert the anchor exists
  # exactly once and that the entry lands, so a changed declaration cannot
  # silently produce a PR without the changelog update.
  local anchor='CHANGELOG_ENTRIES: ChangelogEntry\[\] = \['
  local anchor_count
  anchor_count="$(grep -cE "$anchor" "$CHANGELOG" || true)"
  [ "$anchor_count" = "1" ] || die "expected exactly one changelog anchor in $CHANGELOG, found $anchor_count"
  local entry_file
  entry_file="$(mktemp)"
  cat > "$entry_file" <<EOF
  {
    date: '$(date +%F)',
    description: 'Updated OpenClaw to ${TARGET}.',
    category: 'feature',
    deployHint: 'upgrade_required',
  },
EOF
  tmp="$(mktemp)"
  sed "/$anchor/r ${entry_file}" "$CHANGELOG" > "$tmp" && mv "$tmp" "$CHANGELOG"
  rm -f "$entry_file"
  grep -qF "Updated OpenClaw to ${TARGET}." "$CHANGELOG" \
    || die "changelog entry for $TARGET was not inserted into $CHANGELOG"
}

prepare_bump() {
  echo "openclaw-bump: editing touchpoints $CURRENT -> $TARGET"
  apply_edits
  echo "openclaw-bump: regenerating lockfile"
  # --no-frozen-lockfile because this is an intentional lockfile update; pnpm
  # defaults to frozen under CI=true, which would fail after the manifest edits.
  # Give Node generous heap: resolving the whole workspace can exceed the ~2GB
  # default and OOM (exit 134) in a constrained sandbox. Respect a caller-set
  # NODE_OPTIONS, otherwise default the heap size.
  NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}" \
    pnpm install --lockfile-only --no-frozen-lockfile
  echo "openclaw-bump: validating pin consistency"
  bash scripts/check-plugin-openclaw-pin.sh
}

create_pr() {
  # Prints the PR URL on success; returns non-zero on failure. Failure must be
  # explicit because command substitution clears errexit.
  local body_file url
  body_file="$(mktemp)"
  cat > "$body_file" <<EOF
## Summary

Bumps the packaged OpenClaw version in the KiloClaw image from ${CURRENT} to ${TARGET}: the
Dockerfile pin, the bundled plugin peer and dev deps, the lockfile, the e2e runbook version,
and a changelog entry. Prepared by automation.

## Verification

Validate per the kiloclaw-openclaw-upgrade skill before marking this PR ready:

- [ ] Run the persisted-root live smoke: \`bash services/kiloclaw/scripts/controller-openclaw-upgrade-smoke-test.sh\`
- [ ] Run the skill's final submission gates (typecheck, tests, lint) and review plugin diagnostics.
- [ ] Record the upgrade evidence (before and after versions, smoke result, any diagnostics) in this PR.
- [ ] Mark this PR ready once the above pass.

## Visual Changes

N/A

## Reviewer Notes

${ASSESSMENT_PLACEHOLDER}
EOF
  if ! url="$(gh pr create \
      --repo "$REPO" \
      --draft \
      --head "$BRANCH" \
      --title "feat(kiloclaw): bump openclaw to version ${TARGET}" \
      --body-file "$body_file" \
      --assignee "$ASSIGNEES" 2>&1)"; then
    rm -f "$body_file"
    echo "openclaw-bump: gh pr create failed: $url" >&2
    return 1
  fi
  rm -f "$body_file"
  printf '%s' "$url"
}

publish() {
  git checkout -b "$BRANCH"
  git add "${BUMP_PATHS[@]}"
  echo "openclaw-bump: staged changes:"
  git status --short

  # Commit only the touchpoint paths (pathspec), never anything else in the index.
  local commit_args=(-c "user.name=$GIT_NAME" -c "user.email=$GIT_EMAIL")
  [ "$BUMP_SIGN" = "true" ] && commit_args+=(-c commit.gpgsign=true)
  git "${commit_args[@]}" \
    commit -m "feat(kiloclaw): bump openclaw to version $TARGET" -- "${BUMP_PATHS[@]}"

  # Nothing should remain modified after committing exactly the touchpoints; if a
  # future touchpoint is edited but missing from BUMP_PATHS, this catches it.
  if [ -n "$(git status --porcelain)" ]; then
    die "working tree is not clean after the bump commit; refusing to push:
$(git status --porcelain)"
  fi

  # If signing is required, the commit must actually be signed before we push.
  if [ "$BUMP_SIGN" = "true" ]; then
    case "$(git log -1 --format='%G?' HEAD)" in
      G|U) : ;;
      *) die "commit signing required but the commit is not signed (status $(git log -1 --format='%G?' HEAD)); refusing to push. Provision a signing key, or set BUMP_SIGN_COMMITS=false only for non-publishing use." ;;
    esac
  fi

  git push origin "HEAD:$BRANCH"

  local pr_url
  if ! pr_url="$(create_pr)"; then
    die "branch $BRANCH was pushed but gh pr create failed. Retry later, or delete the branch (git push origin --delete $BRANCH) and re-run."
  fi
  emit_pr_result created "$pr_url"
  echo "openclaw-bump: opened draft PR $pr_url"
}

ensure_clean_base() {
  if [ "${BUMP_ALLOW_DIRTY:-}" = "true" ]; then
    echo "openclaw-bump: BUMP_ALLOW_DIRTY=true, skipping clean-checkout guard"
    return
  fi
  # The push target (origin) must be the same repo gh queries and opens the PR in.
  local origin_url
  origin_url="$(git remote get-url origin 2>/dev/null || true)"
  case "$origin_url" in
    *"$REPO"*) : ;;
    *) die "origin ($origin_url) does not match BUMP_REPO ($REPO); refusing to push to one repo while opening the PR in another." ;;
  esac
  # Include untracked files: pnpm install --lockfile-only evaluates every workspace
  # package, so a stray untracked package could bleed into the lockfile.
  local dirty
  dirty="$(git status --porcelain)"
  if [ -n "$dirty" ]; then
    die "the checkout is not clean (tracked changes or untracked files); refusing to bump (set BUMP_ALLOW_DIRTY=true to override):
$dirty"
  fi
  git fetch origin main >/dev/null 2>&1 || die "could not fetch origin/main"
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse FETCH_HEAD)" ]; then
    die "HEAD is not at origin/main; the bump must branch from main (set BUMP_ALLOW_DIRTY=true to override)."
  fi
}

[ -n "$TARGET" ] || die "no target version given (pass as arg 1 or TARGET_VERSION)"
echo "$TARGET" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || die "target '$TARGET' is not a clean X.Y.Z version"

# Validate the checkout is clean and at origin/main BEFORE reading the current
# pin, so the no-op decision is made against main rather than a stale or dirty
# tree. In BUMP_ALLOW_DIRTY mode this is a no-op and the local pin is used.
ensure_clean_base

CURRENT="$(grep -oE 'openclaw@[0-9]+\.[0-9]+\.[0-9]+' "$DOCKERFILE" | head -n1 | sed 's/openclaw@//' || true)"
[ -n "$CURRENT" ] || die "could not read the current openclaw pin from $DOCKERFILE"
echo "openclaw-bump: current=$CURRENT target=$TARGET"

# No-op guard: only move forward.
if [ "$CURRENT" = "$TARGET" ]; then
  emit action noop-same
  echo "openclaw-bump: Dockerfile already pins $TARGET. Nothing to do."
  exit 0
fi
if ! version_gt "$TARGET" "$CURRENT"; then
  emit action noop-newer
  echo "openclaw-bump: Dockerfile pin $CURRENT is newer than target $TARGET. Nothing to do."
  exit 0
fi

BRANCH="feat/bump-openclaw-$TARGET"

# Dirty mode is local edits-only: edit and validate, then stop. It never reaches
# the create-once query, branch logic, commit, or push.
if [ "${BUMP_ALLOW_DIRTY:-}" = "true" ]; then
  prepare_bump
  emit action edits-only
  echo "openclaw-bump: BUMP_ALLOW_DIRTY=true; applied edits and lockfile locally, stopping before any remote action."
  exit 0
fi

# Create-once across all PR states, scoped to our org-owned exact branch so a fork
# cannot interfere.
open_url="$(gh pr list --repo "$REPO" --head "$BRANCH" --state open \
  --json url,headRefName,headRepositoryOwner \
  --jq "[.[] | select(.headRepositoryOwner.login == \"$OWNER\" and .headRefName == \"$BRANCH\")][0].url // \"\"")"
if [ -n "$open_url" ]; then
  # An open PR exists, so do not bump again. Read how far it got from its body and
  # report the resume point. Do not mask a read failure: a transient gh error must
  # stop the run (the caller treats a non-zero exit as "stop, do not notify"),
  # otherwise we could re-assess and re-post Slack on an already finished PR whose
  # marker we simply failed to observe. Classify only after a successful read.
  if ! open_body="$(gh pr view "$open_url" --repo "$REPO" --json body --jq .body)"; then
    die "could not read the body of open PR $open_url; not classifying its state. Retry later."
  fi
  if printf '%s' "$open_body" | grep -qF "$SLACK_MARKER"; then
    emit_pr_result skip-open-pr "$open_url"
    echo "openclaw-bump: open PR $open_url is assessed and notified. Nothing to do."
  elif printf '%s' "$open_body" | grep -qF "$ASSESSMENT_PLACEHOLDER"; then
    emit_pr_result resume-assessment "$open_url"
    echo "openclaw-bump: open PR $open_url still needs the assessment."
  else
    emit_pr_result resume-notify "$open_url"
    echo "openclaw-bump: open PR $open_url is assessed but not notified."
  fi
  exit 0
fi

closed_count="$(gh pr list --repo "$REPO" --head "$BRANCH" --state all \
  --json state,headRefName,headRepositoryOwner \
  --jq "[.[] | select(.headRepositoryOwner.login == \"$OWNER\" and .headRefName == \"$BRANCH\" and .state != \"OPEN\")] | length")"
if [ "$closed_count" -gt 0 ] && [ "${BUMP_FORCE_RECREATE:-}" != "true" ]; then
  emit action skip-closed-pr
  echo "openclaw-bump: a PR for $BRANCH was already opened and closed; not recreating (set BUMP_FORCE_RECREATE=true to override)."
  exit 0
fi

# A leftover branch with no open PR (for example a prior run whose PR creation
# failed after the push) is not auto-recovered; validating a stray branch is more
# fragile than regenerating. Delete it and re-run for a clean, complete bump.
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  if [ "${BUMP_FORCE_RECREATE:-}" = "true" ]; then
    echo "openclaw-bump: BUMP_FORCE_RECREATE=true; deleting leftover branch $BRANCH on origin before recreating."
    # Let git's output flow to the log; on failure its error is the useful context.
    git push origin --delete "$BRANCH" \
      || die "could not delete leftover branch $BRANCH on origin (see the git error above); delete it manually and re-run: git push origin --delete $BRANCH"
  else
    die "branch $BRANCH exists on origin with no open PR. Delete it and re-run to regenerate a clean bump (git push origin --delete $BRANCH), or set BUMP_FORCE_RECREATE=true to clear it automatically."
  fi
fi

prepare_bump
publish
