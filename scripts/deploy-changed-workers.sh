#!/usr/bin/env bash
# Select the Workers that deploy-workers.yml deploys for one release.
#
# A Worker redeploys when its own files change, or when a workspace it depends
# on changes (scripts/affected-workspaces.mjs). A change to an unrelated shared
# package must not restart the worker: a rollout kills in-flight containers. If
# detection fails, selects everything, or the worker is not a workspace, use the
# broad rule.
#
# A Markdown edit alone does not deploy a Worker unless that Worker reads the
# file at runtime. Only `services/kiloclaw/container/` ships Markdown into the
# Worker: its Dockerfile stages `container/TOOLS.md`, which bootstrap.ts copies
# into the agent workspace, and the Docker build hashes that tree. The
# remaining Workers were checked in this tree and none imports or reads a
# repository Markdown file at runtime, so their documentation edits do not
# redeploy. A Worker that later ships Markdown must be added here. That list is
# the committed sources only: a Worker can also write generated Markdown into a
# workspace, and git diff never sees that.
#
# Reads BASE_SHA and TARGET_ENVIRONMENT. Writes the matrix, the ordered
# cloud-agent-next output and a summary to stdout, and GITHUB_OUTPUT when set.
set -euo pipefail

BASE_SHA="${BASE_SHA:?BASE_SHA is required}"
TARGET_ENVIRONMENT="${TARGET_ENVIRONMENT:?TARGET_ENVIRONMENT is required}"

# Built by the Docker image in deploy-kiloclaw.yml, not by the Wrangler upload.
EXCLUDED=(
  services/kiloclaw   # Docker-based deploy in deploy-kiloclaw.yml (manual-only)
  services/gastown    # Deployed separately
  services/wasteland  # Deployed separately
  services/user-data-export # Automatic deploy suspended
)
# Markdown these Workers ship to the running Worker.
RUNTIME_MARKDOWN=('services/kiloclaw/container')
# Paths whose change redeploys every Worker through the broad rule.
SHARED_PATHS=(packages pnpm-lock.yaml pnpm-workspace.yaml patches)

has_named_environment() {
  node - "$1" "$TARGET_ENVIRONMENT" <<'NODE'
const fs = require('node:fs');

const [file, targetEnvironment] = process.argv.slice(2);

function stripJsonComments(value) {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const next = value[index + 1];

    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') inString = false;
      continue;
    }

    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }

    if (current === '/' && next === '/') {
      while (index < value.length && value[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }

    if (current === '/' && next === '*') {
      index += 2;
      while (index < value.length && !(value[index] === '*' && value[index + 1] === '/')) {
        if (value[index] === '\n') output += '\n';
        index += 1;
      }
      index += 1;
      continue;
    }

    output += current;
  }

  return output;
}

const rawConfig = fs.readFileSync(file, 'utf8');
const config = JSON.parse(stripJsonComments(rawConfig).replace(/,\s*([}\]])/g, '$1'));
process.exit(config.env && Object.hasOwn(config.env, targetEnvironment) ? 0 : 1);
NODE
}

# Discover all workers with a wrangler.jsonc and drop the excluded ones.
DEPLOYABLE=()
while IFS= read -r cfg; do
  dir=$(dirname "$cfg")
  skip=false
  for excluded in "${EXCLUDED[@]}"; do
    if [[ "$dir" == "$excluded" ]]; then
      skip=true
      break
    fi
  done
  if [[ "$skip" == false ]]; then
    DEPLOYABLE+=("$dir")
  fi
done < <(find services -name "wrangler.jsonc" -not -path "*/node_modules/*" -not -path "*/test/fixtures/*" | sort)

# Whether "$dir" has a deployable change since BASE_SHA.
#
# `git diff -z` writes a NUL-separated status, then the path, then a second path
# for a rename or a copy, which is the previous name. A record is skipped only
# when its paths are Markdown and the directory is not one the Worker reads at
# runtime. A deletion always deploys, because a runtime asset can leave the tree
# that way, and so does a rename that involves any other path.
dir_changed() {
  local dir="$1"
  local runtime=false
  local markdown
  for markdown in "${RUNTIME_MARKDOWN[@]}"; do
    if [[ "$dir" == "$markdown" ]]; then runtime=true; break; fi
  done

  local status path markdown_paths=0
  while IFS= read -r -d '' status && IFS= read -r -d '' path; do
    if [[ "$runtime" == true || "$status" == D* ]]; then return 0; fi
    markdown_paths=0
    [[ "$path" == *.md ]] && markdown_paths=$((markdown_paths + 1))
    if [[ "$status" == R* || "$status" == C* ]]; then
      # A rename or a copy adds its old path first, then its new one.
      IFS= read -r -d '' path || path=""
      [[ "$path" == *.md ]] && markdown_paths=$((markdown_paths + 1))
      if [[ "$markdown_paths" == 2 ]]; then continue; fi
    elif [[ "$markdown_paths" == 1 ]]; then
      continue
    fi
    return 0
  done < <(git diff -z --name-status "$BASE_SHA" HEAD -- "$dir/")

  # The base revision is not in this clone: keep the broad, always-deploy result.
  if ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then return 0; fi
  return 1
}

AFFECTED_DIRS=""
NARROW=false
if affected=$(node scripts/affected-workspaces.mjs "$BASE_SHA") \
  && [ "$(jq -r '.full' <<< "$affected")" = false ] \
  && AFFECTED_DIRS=$(jq -r '.dirs[]' <<< "$affected") \
  && WORKSPACE_DIRS=$(set -o pipefail; pnpm ls -r --depth -1 --json | jq -r --arg root "$(pwd -P)/" '.[].path | ltrimstr($root)'); then
  NARROW=true
else
  echo "Workspace detection unavailable or selected everything; using the broad rule"
fi

CHANGED=()
for dir in "${DEPLOYABLE[@]}"; do
  if [ "$TARGET_ENVIRONMENT" != "production" ] && ! has_named_environment "$dir/wrangler.jsonc"; then
    echo "Skipping $dir: wrangler.jsonc does not define env.$TARGET_ENVIRONMENT"
  elif dir_changed "$dir"; then
    CHANGED+=("$dir")
  elif [ "$NARROW" = true ] && grep -Fxq "$dir" <<< "$WORKSPACE_DIRS"; then
    if grep -Fxq "$dir" <<< "$AFFECTED_DIRS"; then
      CHANGED+=("$dir")
    fi
  elif ! git diff --quiet "$BASE_SHA" HEAD -- "${SHARED_PATHS[@]}"; then
    CHANGED+=("$dir")
  fi
done

DEPLOY_CLOUD_AGENT_AFTER_SESSION_INGEST=false
if [ "$TARGET_ENVIRONMENT" = production ] && [ "$NARROW" = true ] \
  && grep -Fxq services/session-ingest <<< "$AFFECTED_DIRS" \
  && grep -Fxq services/cloud-agent-next <<< "$AFFECTED_DIRS"; then
  DEPLOY_CLOUD_AGENT_AFTER_SESSION_INGEST=true
fi

FILTERED=()
for dir in "${CHANGED[@]}"; do
  if [ "$DEPLOY_CLOUD_AGENT_AFTER_SESSION_INGEST" != true ] \
    || [ "$dir" != services/cloud-agent-next ]; then
    FILTERED+=("$dir")
  fi
done
CHANGED=("${FILTERED[@]}")

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "deploy-cloud-agent-after-session-ingest=$DEPLOY_CLOUD_AGENT_AFTER_SESSION_INGEST" >> "$GITHUB_OUTPUT"
  if [ ${#CHANGED[@]} -eq 0 ]; then
    echo "matrix=[]" >> "$GITHUB_OUTPUT"
  else
    MATRIX=$(printf '%s\n' "${CHANGED[@]}" | jq -R . | jq -sc .)
    echo "matrix=$MATRIX" >> "$GITHUB_OUTPUT"
  fi
fi

if [ ${#CHANGED[@]} -eq 0 ]; then
  echo "Workers to deploy: none"
else
  printf 'Workers to deploy: %s\n' "${CHANGED[@]}"
fi
