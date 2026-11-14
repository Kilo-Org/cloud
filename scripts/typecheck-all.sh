#!/usr/bin/env bash
set -euo pipefail

# Typecheck all workspace packages.
#
# Usage:
#   scripts/typecheck-all.sh                  # full (all workspace packages)
#   scripts/typecheck-all.sh --changes-only   # incremental (changed packages only)
#   scripts/typecheck-all.sh --group <name>   # CI: one group of KILO_AFFECTED
#
# Groups split the work across parallel CI jobs:
#   web       apps/web, scripts/web-env and storybook
#   trpc      the tRPC build and the apps that compile against it
#   packages  every other workspace package
#
# The incremental run and the groups read one selection document from
# scripts/affected-workspaces.mjs, which owns which workspaces a revision
# affects: every workspace whose files changed, and every workspace that reads
# one of them. KILO_AFFECTED is that document, computed by CI's changes job for
# the base the groups check.

PATH="node_modules/.bin:$PATH"

changes_only=false
group=""
case "${1:-}" in
  --changes-only) changes_only=true ;;
  --group) group="${2:?--group needs web, trpc or packages}" ;;
  "") ;;
  *) echo "Unknown option: $1" >&2; exit 1 ;;
esac

# Exclude the root package so the recursive workspace typecheck does not invoke
# this script again.
workspace_typecheck_filters=(--filter '!kilocode-monorepo' --filter '!web' --filter '!@kilocode/trpc')

# Whether the selection asks for a check of every workspace: `full` marks a
# change that no workspace owns, and `full_checks` names a check that must cover
# every workspace even when the change is attributable (a change to this script
# does that for typecheck).
selection_is_full() {
  node -e '
    const selection = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const full = selection.full === true || (selection.full_checks ?? []).includes("typecheck");
    process.stdout.write(full ? "true" : "false");
  '
}

# The selected workspace names, one per line.
selection_packages() {
  node -e '
    const selection = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    for (const name of selection.packages ?? []) console.log(name);
  '
}

# Whether the selection reaches a workspace directory. `dirs` is the list
# scripts/changed-workspaces.sh reads, so a directory in it is a directory that
# extension-ci.yml selects.
selection_reaches() {
  node -e '
    const selection = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    process.stdout.write((selection.dirs ?? []).includes(process.argv[1]) ? "true" : "false");
  ' "$1"
}

# Whether the detector read a base for this document. A base the checkout cannot
# read selects every workspace to stay safe, and that widening says nothing
# about what another workflow selects from its own fallback.
selection_base_valid() {
  node -e '
    const selection = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    process.stdout.write(selection.base_valid === true ? "true" : "false");
  '
}

# Whether a selected workspace declares a dependency on one whose built
# declarations it compiles against. Such a workspace typechecks against that
# package's dist, so the build must run even when the package's own sources did
# not change.
selection_reads() {
  node -e '
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const dependency = process.argv[1];
    const selection = JSON.parse(readFileSync(0, "utf8"));
    const reads = (selection.dirs ?? []).some(dir => {
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      } catch {
        return false;
      }
      const fields = [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ];
      return fields.some(field => Object.hasOwn(manifest[field] ?? {}, dependency));
    });
    process.stdout.write(reads ? "true" : "false");
  ' "$1"
}

if [ -n "$group" ]; then
  selection="${KILO_AFFECTED:?KILO_AFFECTED is required with --group}"
  full=$(selection_is_full <<< "$selection")
  selected_packages=$(selection_packages <<< "$selection")
  affects() {
    [ "$full" = true ] || grep -Fxq -- "$1" <<< "$selected_packages"
  }
  # Whether extension-ci.yml typechecks the extension for this run. That
  # workflow runs on a pull request and a main push and has no merge-queue
  # trigger; its `verify` job starts whenever its own selection reaches
  # apps/extension, which is the `dirs` list this document carries. One of the
  # two workflows owns the compile, never both. A document whose base the
  # detector could not read selects every workspace without attributing
  # anything, and that workflow resolves its own fallback base, so such a run
  # keeps the leg here too, as does any other event.
  extension_ci_typechecks() {
    case "${GITHUB_EVENT_NAME:-}" in
      pull_request | push) ;;
      *) return 1 ;;
    esac
    [ "$(selection_base_valid <<< "$selection")" = true ] &&
      [ "$(selection_reaches apps/extension <<< "$selection")" = true ]
  }
  case "$group" in
    web)
      if affects web; then
        # A full check: from main's build info, an edit to a shared module
        # rechecks more than a full check costs.
        tsgo --noEmit -p apps/web/tsconfig.json --incremental false
        tsgo --noEmit -p scripts/web-env/tsconfig.json
      fi
      if affects @kilocode/storybook; then
        pnpm --filter @kilocode/storybook run typecheck
      fi
      ;;
    trpc)
      # The row runs on every full typecheck, which `selectAffected` reports
      # whenever a change has no base, hits a GLOBAL path or this script,
      # moves root or unscoped dependencies, or holds a file it cannot
      # attribute to any workspace; `affects` then answers for every package.
      # The extension leg repeats the typecheck extension-ci.yml's `verify` job
      # runs. That workflow has no merge-queue trigger, so the merge queue needs
      # the leg here. A pull request or a main push whose selection reaches
      # apps/extension leaves the compile to `verify`; a full check of this
      # script alone selects no workspace there, so the leg stays. CI restores
      # or builds the declarations first and sets KILO_TYPECHECK_TRPC_BUILT=1.
      if [ "${KILO_TYPECHECK_TRPC_BUILT:-}" != 1 ]; then
        pnpm --filter @kilocode/trpc run build
        export KILO_TYPECHECK_TRPC_BUILT=1
      fi
      if affects kilo-extension && ! extension_ci_typechecks; then
        pnpm --filter kilo-extension run typecheck
      fi
      ;;
    packages)
      # The web, trpc and extension checks belong to their own groups.
      # kilo-app typechecks in kilo-app CI, which runs whenever kilo-app is
      # affected; its typecheck needs the compiled harness SDK, which this
      # group does not build.
      excluded=(
        --filter '!@kilocode/storybook'
        --filter '!kilo-app'
        --filter '!kilo-extension'
      )
      if [ "$full" = true ]; then
        pnpm -r "${workspace_typecheck_filters[@]}" "${excluded[@]}" run typecheck
        exit 0
      fi
      filters=()
      while IFS= read -r name; do
        [ -z "$name" ] && continue
        case "$name" in
          web | @kilocode/trpc | @kilocode/storybook | kilo-app | kilo-extension) ;;
          *) filters+=(--filter "$name") ;;
        esac
      done <<< "$selected_packages"
      if [ ${#filters[@]} -gt 0 ]; then
        pnpm -r "${filters[@]}" run typecheck
      fi
      ;;
    *) echo "Unknown group: $group" >&2; exit 1 ;;
  esac
  exit 0
fi

base=""
if $changes_only; then
  base=$(git merge-base origin/main HEAD 2>/dev/null || true)
  if [ -z "$base" ]; then
    echo "[typecheck] no merge base found, running full typecheck"
    changes_only=false
  # A change to the workspace membership list can alter the type surface across
  # packages, and the detector does not attribute it: run the full check.
  elif git diff --name-only "$base" -- pnpm-workspace.yaml | grep -q .; then
    echo "[typecheck] pnpm-workspace.yaml changed, running full typecheck"
    changes_only=false
  fi
fi

# The selection document, read once. Every decision below that depends on which
# workspaces this revision reaches reads it instead of selecting again.
selection=""
full=false
selected_packages=""
if $changes_only; then
  selection=$(node scripts/affected-workspaces.mjs "$base" --worktree) || {
    echo "[typecheck] the affected-workspace selection failed, running full typecheck"
    changes_only=false
  }
  if [ -n "$selection" ]; then
    full=$(selection_is_full <<< "$selection")
    selected_packages=$(selection_packages <<< "$selection")
  fi
fi

# 1. Build trpc (skip if --changes-only, no checked workspace reads it, and the
# selection is not a full check)
if $changes_only; then
  trpc_changed=$(git diff --name-only "$base" -- 'packages/trpc/src/**' 'packages/trpc/tsconfig.json' 'packages/trpc/tsconfig.build.json' 'packages/trpc/rollup.config.mjs' 'packages/trpc/package.json' | head -1 || true)
  if [ -n "$trpc_changed" ] || [ "$full" = true ] || [ "$(selection_reads @kilocode/trpc <<< "$selection")" = true ]; then
    echo "[typecheck] rebuilding trpc for the checked workspaces"
    pnpm --filter @kilocode/trpc run build
    export KILO_TYPECHECK_TRPC_BUILT=1
  else
    echo "[typecheck] trpc source unchanged and unchecked, skipping build"
  fi
else
  pnpm --filter @kilocode/trpc run build
  export KILO_TYPECHECK_TRPC_BUILT=1
fi

# 1b. Build the harness SDK, which the checked apps compile against (same rule
# as trpc)
if $changes_only; then
  harness_changed=$(git diff --name-only "$base" -- 'packages/harness-sdk/src/**' 'packages/harness-sdk/tsconfig.json' 'packages/harness-sdk/tsconfig.build.json' 'packages/harness-sdk/package.json' | head -1 || true)
  if [ -n "$harness_changed" ] || [ "$full" = true ] || [ "$(selection_reads @kilocode/harness-sdk <<< "$selection")" = true ]; then
    echo "[typecheck] rebuilding the harness SDK for the checked workspaces"
    pnpm --filter @kilocode/harness-sdk run build
  else
    echo "[typecheck] harness SDK source unchanged and unchecked, skipping build"
  fi
else
  pnpm --filter @kilocode/harness-sdk run build
fi

# 2. Root typechecks (always — they are fast with incremental tsgo)
tsgo --noEmit -p apps/web/tsconfig.json
tsgo --noEmit -p scripts/web-env/tsconfig.json

# 3. Workspace typecheck
if ! $changes_only || [ "$full" = true ]; then
  echo "[typecheck] checking all workspace packages"
  pnpm -r "${workspace_typecheck_filters[@]}" run typecheck
  exit 0
fi

# The selection names the changed workspaces and every workspace that reads
# them. The root checks above compile apps/web and scripts/web-env, and step 1
# builds @kilocode/trpc.
filters=()
while IFS= read -r name; do
  [ -z "$name" ] && continue
  case "$name" in
    web | @kilocode/trpc) continue ;;
  esac
  filters+=(--filter "$name")
done <<< "$selected_packages"

if [ ${#filters[@]} -eq 0 ]; then
  echo "[typecheck] no workspace packages affected, skipping workspace typecheck"
  exit 0
fi

echo "[typecheck] checking affected packages: ${filters[*]}"
pnpm -r "${filters[@]}" "${workspace_typecheck_filters[@]}" run typecheck
