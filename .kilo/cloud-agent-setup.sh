#!/usr/bin/env bash
set -Eeuo pipefail

on_error() {
  local status=$?
  printf 'Setup failed at line %s (exit %s).\n' "$1" "$status" >&2
  exit "$status"
}
trap 'on_error "$LINENO"' ERR

cd "$(dirname "${BASH_SOURCE[0]}")/.."
repo=$PWD
state_dir="$repo/.wrangler/kilo-startup"
startup_bin="$state_dir/bin"
env_file="$state_dir/env"
global_state_dir=/usr/local/lib/kilo-cloud-agent
pnpm_wrapper_marker='# kilo-cloud-agent-pnpm-wrapper'

clean_path=
IFS=: read -ra path_entries <<< "$PATH"
for entry in "${path_entries[@]}"; do
  [[ $entry == "$startup_bin" ]] || clean_path+=${clean_path:+:}$entry
done
PATH=$clean_path

export CI=true
export NEXT_TELEMETRY_DISABLED=1
export KILO_ENV_SYNC_CONCURRENCY=1
export SKIP_STRIPE_API="${SKIP_STRIPE_API:-true}"
export KILO_PORT_OFFSET="${KILO_PORT_OFFSET:-auto}"
KILO_STARTUP_RESERVE_MB=2048

if [[ $(uname -s) != Linux ]] || ! command -v apt-get >/dev/null; then
  printf 'This setup script requires a Debian/Ubuntu Linux sandbox.\n' >&2
  exit 1
fi

root=()
if (( EUID != 0 )); then
  if ! command -v sudo >/dev/null || ! sudo -n true; then
    printf 'Root or passwordless sudo is required to install sandbox prerequisites.\n' >&2
    exit 1
  fi
  root=(sudo -n)
fi

KILO_STARTUP_CGROUP="/sys/fs/cgroup/kilo-workloads/kilo-dev-$(basename "$repo")"
export KILO_STARTUP_CGROUP KILO_STARTUP_RESERVE_MB
if [[ ! -f /sys/fs/cgroup/kilo-workloads/memory.max ]]; then
  printf 'Memory-safe setup requires the sandbox\x27s delegated cgroup v2 memory controller. No workloads were started.\n' >&2
  exit 1
fi
KILO_STARTUP_MEMORY_MB=$(node -e '
  const fs = require("node:fs");
  const MiB = 1048576;
  const parent = "/sys/fs/cgroup/kilo-workloads";
  function fail(message) {
    console.error(message + " No workloads were started.");
    process.exit(1);
  }
  function protectedMemory(directory) {
    const stat = Object.fromEntries(fs.readFileSync(directory + "/memory.stat", "utf8").trim().split("\n").map(line => line.split(" ")));
    const current = Number(fs.readFileSync(directory + "/memory.current", "utf8"));
    return current - Number(stat.inactive_file || 0) + Number(stat.file_dirty || 0) + Number(stat.file_writeback || 0);
  }
  const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
  const meminfoBytes = key => Number(meminfo.match(new RegExp("^" + key + ":\\s+(\\d+)", "m"))[1]) * 1024;
  const parentMax = Number(fs.readFileSync(parent + "/memory.max", "utf8"));
  const total = Math.min(meminfoBytes("MemTotal"), Number.isFinite(parentMax) ? parentMax : Infinity);
  const reserve = Number(process.env.KILO_STARTUP_RESERVE_MB) * MiB;
  const requested = process.env.KILO_STARTUP_MEMORY_MB;
  if (requested !== undefined && !/^[0-9]+$/.test(requested)) fail("KILO_STARTUP_MEMORY_MB must be an integer number of MiB.");
  const limit = requested === undefined ? Math.floor((total - reserve) / MiB) * MiB : Number(requested) * MiB;
  if (limit < 3072 * MiB) fail("The dev workload needs at least 3072 MiB, but its cap is " + Math.floor(limit / MiB) + " MiB (" + Math.floor(total / MiB) + " MiB total, " + Math.floor(reserve / MiB) + " MiB reserve).");
  const existing = fs.existsSync(process.env.KILO_STARTUP_CGROUP + "/memory.current") ? protectedMemory(process.env.KILO_STARTUP_CGROUP) : 0;
  const others = Math.max(0, protectedMemory(parent) - existing);
  if (limit + others > total) fail("Insufficient memory headroom: other sandbox workloads hold " + Math.ceil(others / MiB) + " MiB, so a " + Math.floor(limit / MiB) + " MiB dev workload cap exceeds the " + Math.floor(total / MiB) + " MiB total. Stop other workloads or use a larger sandbox.");
  const additional = Math.max(0, limit - existing);
  if (additional > meminfoBytes("MemAvailable")) fail("Insufficient host memory: " + Math.ceil(additional / MiB) + " MiB additional capacity required, " + Math.floor(meminfoBytes("MemAvailable") / MiB) + " MiB available.");
  console.log(Math.floor(limit / MiB));
')
export KILO_STARTUP_MEMORY_MB
"${root[@]}" mkdir -p "$KILO_STARTUP_CGROUP"
printf '%s\n' "$(( KILO_STARTUP_MEMORY_MB * 1048576 ))" | "${root[@]}" tee "$KILO_STARTUP_CGROUP/memory.max" >/dev/null
printf '%s\n' "$(( KILO_STARTUP_MEMORY_MB * 1048576 * 95 / 100 ))" | "${root[@]}" tee "$KILO_STARTUP_CGROUP/memory.high" >/dev/null
printf '0\n' | "${root[@]}" tee "$KILO_STARTUP_CGROUP/memory.swap.max" >/dev/null
printf '1\n' | "${root[@]}" tee "$KILO_STARTUP_CGROUP/memory.oom.group" >/dev/null
printf '+memory +cpu\n' | "${root[@]}" tee "$KILO_STARTUP_CGROUP/cgroup.subtree_control" >/dev/null
"${root[@]}" mkdir -p "$KILO_STARTUP_CGROUP/processes" "$KILO_STARTUP_CGROUP/containers"
printf '%s\n' "$$" | "${root[@]}" tee "$KILO_STARTUP_CGROUP/processes/cgroup.procs" >/dev/null
printf 'Dev workload capped at %s MiB, with %s MiB reserved for other sandbox workloads.\n' "$KILO_STARTUP_MEMORY_MB" "$KILO_STARTUP_RESERVE_MB"

"${root[@]}" timeout --foreground 5m apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update
docker_packages=(docker.io)
for package in docker-cli docker-buildx; do
  if apt-cache show "$package" >/dev/null 2>&1; then
    docker_packages+=("$package")
  fi
done
if apt-cache show docker-compose-v2 >/dev/null 2>&1; then
  docker_packages+=(docker-compose-v2)
else
  # Debian trixie's docker-compose package ships Compose v2 as the docker CLI plugin.
  docker_packages+=(docker-compose)
fi
"${root[@]}" env DEBIAN_FRONTEND=noninteractive timeout --foreground 10m apt-get install -y --no-install-recommends \
  ca-certificates chromium curl fuse-overlayfs git git-lfs openssl sudo unzip tmux "${docker_packages[@]}"
if ! docker compose version >/dev/null 2>&1; then
  printf 'Docker Compose v2 (the docker compose CLI plugin) is required, but %s did not provide it.\n' "${docker_packages[-1]}" >&2
  exit 1
fi

if ! command -v node >/dev/null || [[ $(node -p 'process.versions.node.split(".")[0]') != 24 ]]; then
  printf 'The sandbox image must provide Node.js 24 and Corepack before running this script.\n' >&2
  exit 1
fi

global_pnpm=$(command -v pnpm || true)
if [[ -n $global_pnpm ]] && grep -qF "$pnpm_wrapper_marker" "$global_pnpm" 2>/dev/null; then
  real_pnpm=$(< "$global_state_dir/real-pnpm")
else
  if [[ -n $global_pnpm && $(readlink -f "$global_pnpm") == "$state_dir"/* ]]; then
    "${root[@]}" rm -f "$global_pnpm"
    global_pnpm=
  fi
  if [[ -z $global_pnpm ]]; then
    "${root[@]}" corepack enable
    corepack install
    global_pnpm=$(command -v pnpm)
  fi
  real_pnpm=$(readlink -f "$global_pnpm")
fi
if [[ ! -x $real_pnpm ]] || grep -qF "$pnpm_wrapper_marker" "$real_pnpm"; then
  printf 'Could not locate the real pnpm executable (resolved %s).\n' "$real_pnpm" >&2
  exit 1
fi

tools=()
command -v bun >/dev/null || tools+=(bun@1.3.13)
command -v agent-browser >/dev/null || tools+=(agent-browser@0.38.2)
if (( ${#tools[@]} )); then
  "${root[@]}" npm install --global --no-audit --no-fund "${tools[@]}"
fi

if tmux list-sessions >/dev/null 2>&1; then
  tmux_pid=$(tmux display-message -p '#{pid}')
  if ! node -e 'const fs = require("node:fs"); process.exit(fs.readFileSync("/proc/" + process.argv[1] + "/cgroup", "utf8").includes(process.env.KILO_STARTUP_CGROUP.replace("/sys/fs/cgroup", "") + "/processes") ? 0 : 1)' "$tmux_pid"; then
    printf 'The existing tmux server is outside the dev workload memory budget. Stop its sessions before running this script.\n' >&2
    exit 1
  fi
fi

mkdir -p "$startup_bin"
rm -f "$startup_bin/pnpm" "$state_dir/browser.env" "$state_dir/selection"
real_docker=$(readlink -f "$(command -v docker)")
KILO_STARTUP_BUILDER="kilo-lowmem-$(basename "$repo")"
cat > "$state_dir/compose.memory.yml" <<YAML
services:
  postgres:
    mem_limit: 768m
    memswap_limit: 768m
    shm_size: 128m
    cgroup_parent: ${KILO_STARTUP_CGROUP#/sys/fs/cgroup}/containers
  redis:
    mem_limit: 128m
    memswap_limit: 128m
    cgroup_parent: ${KILO_STARTUP_CGROUP#/sys/fs/cgroup}/containers
  redis-http:
    mem_limit: 256m
    memswap_limit: 256m
    cgroup_parent: ${KILO_STARTUP_CGROUP#/sys/fs/cgroup}/containers
    environment:
      ERL_FLAGS: "+S 2:2 +A 2"
YAML
cat > "$startup_bin/kilo-shell" <<'SH'
#!/usr/bin/env bash
if [[ ${1:-} == -lc ]]; then
  shift
  exec /bin/bash --noprofile --norc -c "$@"
fi
exec /bin/bash "$@"
SH
chmod +x "$startup_bin/kilo-shell"
cat > "$state_dir/sandbox-docker.cjs" <<'JS'
#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const stdinDockerfile = args[0] === 'build' && args.some((arg, i) =>
  (arg === '-f' || arg === '--file') && args[i + 1] === '-');
function run(input) {
  const build = args[0] === 'build';
  if (args[0] === 'compose') {
    const source = args.findIndex((arg, i) => arg === '-f' && path.resolve(args[i + 1]) === path.resolve(__dirname, '../../dev/docker-compose.yml'));
    if (source !== -1) args.splice(source + 2, 0, '-f', path.join(__dirname, 'compose.memory.yml'));
  }
  if (build) args.splice(0, 1, 'buildx', 'build', '--builder', process.env.KILO_STARTUP_BUILDER, '--allow=network.host');
  // Stop the builder after each build so its 2 GiB does not stay inside the dev workload budget; buildx restarts it on demand.
  const buildScript = '"$KILO_STARTUP_REAL_DOCKER" "$@"; status=$?; "$KILO_STARTUP_REAL_DOCKER" stop "buildx_buildkit_${KILO_STARTUP_BUILDER}0" >/dev/null 2>&1; exit $status';
  const command = build ? 'flock' : process.env.KILO_STARTUP_REAL_DOCKER;
  const commandArgs = build ? [path.join(__dirname, 'image-build.lock'), 'sh', '-c', buildScript, 'sandbox-docker-build', ...args] : args;
  const child = spawn(command, commandArgs, { stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'] });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  if (input !== undefined) child.stdin.end(input);
}
if (!stdinDockerfile) {
  run();
} else {
  let dockerfile = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { dockerfile += chunk; });
  process.stdin.on('end', () => {
    const cert = process.env.NODE_EXTRA_CA_CERTS && fs.existsSync(process.env.NODE_EXTRA_CA_CERTS) ? fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS).toString('base64') : null;
    // Trust the sandbox's HTTPS interception CA inside development images, not production sources.
    const trust = cert ? `RUN mkdir -p /usr/local/share/ca-certificates && printf '%s' '${cert}' | base64 -d > /usr/local/share/ca-certificates/kilo-sandbox.crt && (if command -v apt-get >/dev/null; then printf 'Acquire::http::Timeout "30";\\nAcquire::https::Timeout "30";\\nAcquire::Retries "2";\\n' > /etc/apt/apt.conf.d/99-kilo-startup-timeouts; fi) && (command -v update-ca-certificates || (apt-get update && apt-get install -y --no-install-recommends ca-certificates)) && update-ca-certificates\nENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/kilo-sandbox.crt` : '';
    const limits = 'ENV NODE_OPTIONS=--max-old-space-size=768 GOMAXPROCS=2 npm_config_jobs=1';
    dockerfile = dockerfile.replace(/^FROM (?:docker.io\/library\/)?(docker:dind-rootless|debian:trixie-slim)([^\n]*)/gm,
      (_, image, suffix) => `FROM mirror.gcr.io/library/${image}${suffix}\nUSER root\n${trust}\n${limits}`);
    dockerfile = dockerfile.replace(/^FROM (?:docker.io\/)?cloudflare\/sandbox:[^\n]+/m, from =>
      `${from}\n${trust}\n${limits}`);
    run(dockerfile);
  });
}
JS
chmod +x "$state_dir/sandbox-docker.cjs"
ln -sf "$state_dir/sandbox-docker.cjs" "$startup_bin/docker"

env_default() {
  printf '[[ -n ${%s:-} ]] || %s=%q; export %s\n' "$1" "$1" "$2" "$1"
}
{
  printf 'case ":$PATH:" in *:%q:*) ;; *) export PATH=%q:"$PATH" ;; esac\n' "$startup_bin" "$startup_bin"
  printf 'export SHELL=%q\n' "$startup_bin/kilo-shell"
  for name in NEXT_TELEMETRY_DISABLED SKIP_STRIPE_API KILO_PORT_OFFSET KILO_ENV_SYNC_CONCURRENCY KILO_STARTUP_CGROUP KILO_STARTUP_BUILDER; do
    env_default "$name" "${!name}"
  done
  env_default KILO_STARTUP_REAL_DOCKER "$real_docker"
  env_default WRANGLER_DOCKER_BIN "$state_dir/sandbox-docker.cjs"
  env_default WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST 1
  env_default AGENT_BROWSER_ENGINE chrome
  env_default AGENT_BROWSER_EXECUTABLE_PATH /usr/bin/chromium
  env_default AGENT_BROWSER_SOCKET_DIR /tmp/kilo-browser
  env_default AGENT_BROWSER_ARGS --disable-gpu
  env_default AGENT_BROWSER_DEFAULT_TIMEOUT 120000
  if [[ -n ${NODE_EXTRA_CA_CERTS:-} ]]; then
    env_default NODE_EXTRA_CA_CERTS "$NODE_EXTRA_CA_CERTS"
  fi
} > "$env_file"

cgroup_writer=(tee)
if (( ${#root[@]} )); then
  cgroup_writer=("${root[@]}" tee)
fi
"${root[@]}" mkdir -p "$global_state_dir"
printf '%s\n' "$real_pnpm" | "${root[@]}" tee "$global_state_dir/real-pnpm" >/dev/null
{
  printf '#!/usr/bin/env bash\n%s\n' "$pnpm_wrapper_marker"
  printf 'repo=%q\nenv_file=%q\n' "$repo" "$env_file"
  printf 'cgroup_writer=(%s)\n' "$(printf '%q ' "${cgroup_writer[@]}")"
  cat <<'SH'
real_pnpm=$(< /usr/local/lib/kilo-cloud-agent/real-pnpm)
if [[ ($PWD == "$repo" || $PWD == "$repo"/*) && -f $env_file ]]; then
  source "$env_file"
  cgroup=${KILO_STARTUP_CGROUP#/sys/fs/cgroup}
  if [[ $(< /proc/self/cgroup) != "0::$cgroup/"* ]]; then
    if [[ ! -d $KILO_STARTUP_CGROUP/processes ]]; then
      printf 'The sandbox dev memory cgroup is missing. Rerun bash %q/.kilo/cloud-agent-setup.sh.\n' "$repo" >&2
      exit 1
    fi
    printf '%s\n' "$$" | "${cgroup_writer[@]}" "$KILO_STARTUP_CGROUP/processes/cgroup.procs" >/dev/null
  fi
fi
exec "$real_pnpm" "$@"
SH
} > "$state_dir/pnpm-wrapper"
"${root[@]}" install -m 0755 "$state_dir/pnpm-wrapper" "${global_pnpm:-/usr/local/bin/pnpm}"
hash -r
source "$env_file"

if ! docker info >/dev/null 2>&1; then
  if [[ -n ${DOCKER_HOST:-} ]] || [[ -S /var/run/docker.sock ]]; then
    printf 'The supplied Docker daemon is inaccessible; fix Docker access and rerun.\n' >&2
    exit 1
  fi
  # These sandboxes mount /proc/sys read-only; overlay2 is supported by the current kernel.
  storage_driver="${KILO_STARTUP_DOCKER_STORAGE_DRIVER:-overlay2}"
  if [[ $storage_driver != overlay2 && $storage_driver != fuse-overlayfs ]]; then
    printf 'Only overlay2 or fuse-overlayfs is allowed; vfs layer copies are unsafe for this sandbox.\n' >&2
    exit 1
  fi
  # Own the socket by the invoking user's group so a non-root sandbox can use the daemon it starts.
  "${root[@]}" tmux new-session -d -s kilo-startup-docker \
    "env DOCKER_ALLOW_IPV6_ON_IPV4_INTERFACE=1 dockerd --group=$(id -gn) --storage-driver=$storage_driver --ip-forward=false --cgroup-parent=${KILO_STARTUP_CGROUP#/sys/fs/cgroup}/containers"
  for (( attempt=0; attempt<30; attempt++ )); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
  if ! docker info >/dev/null 2>&1; then
    printf 'Docker could not start. This sandbox must support nested containers or supply a Docker socket.\n' >&2
    "${root[@]}" tmux capture-pane -p -t kilo-startup-docker || true
    exit 1
  fi
fi
if [[ $(docker info --format '{{.Driver}}') == vfs ]]; then
  printf 'The existing Docker daemon uses vfs. Stop it and restart with overlay2 or fuse-overlayfs before running this workload.\n' >&2
  exit 1
fi
if tmux list-sessions >/dev/null 2>&1; then
  while IFS= read -r line; do
    tmux set-environment -g "${line%%=*}" "${line#*=}"
  done < <(bash -c 'source "$1"; for name in PATH SHELL KILO_PORT_OFFSET KILO_STARTUP_CGROUP KILO_STARTUP_BUILDER KILO_STARTUP_REAL_DOCKER WRANGLER_DOCKER_BIN WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST NODE_EXTRA_CA_CERTS; do [[ -n ${!name:-} ]] && printf "%s=%s\n" "$name" "${!name}"; done' _ "$env_file")
fi

cat > "$state_dir/buildkitd.toml" <<'TOML'
[worker.oci]
  max-parallelism = 1
  networkMode = "host"
[registry."docker.io"]
  mirrors = ["mirror.gcr.io"]
TOML
if [[ -n ${NODE_EXTRA_CA_CERTS:-} && -f $NODE_EXTRA_CA_CERTS ]]; then
  ca_path=$(node -p 'JSON.stringify(process.env.NODE_EXTRA_CA_CERTS)')
  printf '  ca = [%s]\n[registry."mirror.gcr.io"]\n  ca = [%s]\n' "$ca_path" "$ca_path" >> "$state_dir/buildkitd.toml"
fi
if ! docker buildx inspect "$KILO_STARTUP_BUILDER" >/dev/null 2>&1; then
  docker buildx create --name "$KILO_STARTUP_BUILDER" --driver docker-container \
    --driver-opt "image=mirror.gcr.io/moby/buildkit:v0.16.0,memory=2g,memory-swap=2g,network=host,cgroup-parent=${KILO_STARTUP_CGROUP#/sys/fs/cgroup}/containers" \
    --buildkitd-config "$state_dir/buildkitd.toml" \
    --buildkitd-flags '--allow-insecure-entitlement network.host'
fi
timeout 3m docker buildx inspect --bootstrap "$KILO_STARTUP_BUILDER" >/dev/null
docker inspect "buildx_buildkit_${KILO_STARTUP_BUILDER}0" --format '{{json .HostConfig}}' | node -e '
  let input = "";
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    const config = JSON.parse(input);
    const parent = process.env.KILO_STARTUP_CGROUP.replace("/sys/fs/cgroup", "") + "/containers";
    if (config.Memory !== 2147483648 || config.CgroupParent !== parent) throw new Error("BuildKit is not inside its required memory budget");
  });
'
docker stop "buildx_buildkit_${KILO_STARTUP_BUILDER}0" >/dev/null

timeout 15m pnpm install --frozen-lockfile --child-concurrency=1 --network-concurrency=4
if [[ ! -s .env.local ]]; then
  (umask 077; pnpm dev:setup-env --ci)
  printf 'Created local-only credentials. Real payment, model, and Git integrations require supplied secrets.\n'
fi
node -e '
  const fs = require("node:fs");
  const match = fs.readFileSync(".env.local", "utf8").match(/^POSTGRES_URL\s*=\s*(.*)$/m);
  const value = process.env.POSTGRES_URL || match?.[1].trim().replace(/^(["\x27])(.*)\1$/, (_, quote, inner) => inner);
  if (!value || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname)) {
    throw new Error("Sandbox setup requires a local POSTGRES_URL; remote databases will not be migrated or seeded");
  }
'

# Avoid Docker Hub's shared unauthenticated pull limit without changing Compose files.
while IFS= read -r image; do
  if docker image inspect "$image" >/dev/null 2>&1; then
    continue
  fi
  hub_image=${image#docker.io/}
  registry=${hub_image%%/*}
  if [[ $hub_image == */* && ($registry == *.* || $registry == *:* || $registry == localhost) ]]; then
    docker pull "$image"
    continue
  fi
  [[ $hub_image == */* ]] || hub_image="library/$hub_image"
  if docker pull "mirror.gcr.io/$hub_image"; then
    docker tag "mirror.gcr.io/$hub_image" "$image"
  else
    docker pull "$image"
  fi
done < <(docker compose -f dev/docker-compose.yml config --images | sort -u)

printf 'Preparing the local database (up to 5 minutes).\n'
timeout --foreground 5m pnpm test:db

test_email="kilo-$(basename "$HOME")-$(date -u +%Y%m%d%H%M%S)@example.com"
test_user_id=$(docker compose -f dev/docker-compose.yml exec -T postgres \
  psql -U postgres -d postgres -X -qAt -v ON_ERROR_STOP=1 -v email="$test_email" <<'SQL'
INSERT INTO kilocode_users (
  id, google_user_email, google_user_name, google_user_image_url, hosted_domain,
  stripe_customer_id, completed_welcome_form, has_validation_stytch, customer_source
) VALUES (
  gen_random_uuid()::text, :'email', 'Sandbox Test User', '', '@@fake@@',
  'cus_local_sandbox', true, true, 'dev-seed'
) RETURNING id;
SQL
)
pnpm dev:seed app:add-credits "$test_user_id" 100 --free
env_default KILO_TEST_USER_EMAIL "$test_email" >> "$env_file"

printf '\nSetup complete. Dev workload memory peak so far: %s MiB / %s MiB.\n' \
  "$(( $(< "$KILO_STARTUP_CGROUP/memory.peak") / 1048576 ))" "$KILO_STARTUP_MEMORY_MB"
printf 'Run from %s (pnpm there joins the capped cgroup and loads %s):\n' "$repo" "$env_file"
printf '  pnpm dev:start --no-attach app                 # web app\n'
printf '  pnpm dev:start --no-attach agents fake-llm     # Cloud Agents with local fake inference\n'
printf 'Then pnpm dev:status for ports; log in at http://localhost:<nextjs port>/users/sign_in?fakeUser=%s&callbackPath=/profile\n' "$test_email"
printf 'Other shells (docker, agent-browser): source %q\n' "$env_file"
