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

resume=0
case ${1:-} in
  '') ;;
  --resume) resume=1 ;;
  *) printf 'Usage: %s [--resume]\n' "$0" >&2; exit 2 ;;
esac

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
bridge_gateway=172.17.0.1
# Part of the workload parent Docker can never take, matching the headroom the
# session wrapper keeps between its tools cgroup and the parent cap.
kilo_headroom_bytes=$(( 1536 * 1048576 ))

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

# The session wrapper owns memory containment: it caps the delegated
# kilo-workloads parent, protects the Kilo server, moves every agent tool
# process into its capped tools cgroup, and runs setup and start commands in
# kilo-setup. Docker needs a sibling of its own because container cgroups cannot
# nest under a cgroup that holds processes. A workspace tail snapshot restores
# files but not cgroups or daemons; --resume recreates both.
workload_parent=${KILO_WORKLOAD_CGROUP_ROOT:-/sys/fs/cgroup/kilo-workloads}
KILO_DOCKER_CGROUP="$workload_parent/kilo-docker"
build_mode=0
if [[ ${KILO_ENVIRONMENT_BUILD:-} == 1 ]]; then
  # The environment builder runs without the session wrapper, so it has no
  # delegated workload cgroup and stops every process before capture. Install
  # packages and warm Docker's image store for the snapshot; session setup
  # starts the daemons from the captured filesystem.
  build_mode=1
  if (( resume )); then
    printf -- '--resume is not supported in environment builds.\n' >&2
    exit 1
  fi
elif [[ ! -f $workload_parent/memory.max ]]; then
  printf 'Memory-safe setup requires the sandbox\x27s delegated cgroup v2 memory controller. No workloads were started.\n' >&2
  exit 1
fi
if (( resume )) && { [[ ! -f $env_file ]] || ! command -v dockerd >/dev/null \
  || ! grep -qF "$pnpm_wrapper_marker" "$(command -v pnpm)" 2>/dev/null; }; then
  printf 'This workspace was not fully set up; running full setup.\n' >&2
  resume=0
fi

docker_daemon_cgroup=
if (( ! build_mode )); then
  parent_max=$(< "$workload_parent/memory.max")
  docker_max=max
  if [[ $parent_max =~ ^[0-9]+$ ]]; then
    docker_max=$(( parent_max - kilo_headroom_bytes ))
  fi
  "${root[@]}" mkdir -p "$KILO_DOCKER_CGROUP"
  printf '%s\n' "$docker_max" | "${root[@]}" tee "$KILO_DOCKER_CGROUP/memory.max" >/dev/null
  printf '0\n' | "${root[@]}" tee "$KILO_DOCKER_CGROUP/memory.swap.max" >/dev/null
  printf '+memory +cpu\n' | "${root[@]}" tee "$KILO_DOCKER_CGROUP/cgroup.subtree_control" >/dev/null
  # dockerd, containerd and dnsmasq live in daemon/, so a Kilo runtime restart,
  # which kills its tools cgroup, does not take Docker or DNS down.
  docker_daemon_cgroup="$KILO_DOCKER_CGROUP/daemon"
  "${root[@]}" mkdir -p "$docker_daemon_cgroup" "$KILO_DOCKER_CGROUP/containers/builds"
  printf '+memory +cpu\n' | "${root[@]}" tee "$KILO_DOCKER_CGROUP/containers/cgroup.subtree_control" >/dev/null
  # Image build steps run in their own 2 GiB slice.
  printf '%s\n' "$(( 2048 * 1048576 ))" | "${root[@]}" tee "$KILO_DOCKER_CGROUP/containers/builds/memory.max" >/dev/null
  printf '0\n' | "${root[@]}" tee "$KILO_DOCKER_CGROUP/containers/builds/memory.swap.max" >/dev/null
fi
export KILO_DOCKER_CGROUP

# Run a command as root inside the Docker daemon cgroup (or unplaced in build mode).
as_docker_daemon() {
  "${root[@]}" bash -c '[[ -z $1 ]] || printf "%s\n" "$$" > "$1/cgroup.procs"; shift; exec "$@"' _ "$docker_daemon_cgroup" "$@"
}

# --resume restarts what a workspace tail snapshot does not restore (Docker,
# dnsmasq, the DNS redirect) from the installed filesystem, skipping installs and builds.
if (( ! resume )); then
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
  ca-certificates chromium curl dnsmasq-base fuse-overlayfs git git-lfs openssl sudo unzip tmux "${docker_packages[@]}"
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
  if [[ ! -L $global_pnpm ]]; then
    # The wrapper replaces this path, so move a standalone pnpm binary out of the way first.
    "${root[@]}" mkdir -p "$global_state_dir"
    "${root[@]}" mv "$global_pnpm" "$global_state_dir/pnpm"
    real_pnpm="$global_state_dir/pnpm"
  fi
fi
if [[ ! -x $real_pnpm ]] || grep -qF "$pnpm_wrapper_marker" "$real_pnpm"; then
  printf 'Could not locate the real pnpm executable (resolved %s).\n' "$real_pnpm" >&2
  exit 1
fi

tools=()
command -v bun >/dev/null || tools+=(bun@1.4.4)
command -v agent-browser >/dev/null || tools+=(agent-browser@0.38.2)
if (( ${#tools[@]} )); then
  "${root[@]}" npm install --global --no-audit --no-fund "${tools[@]}"
fi

mkdir -p "$startup_bin"
rm -f "$startup_bin/pnpm" "$state_dir/browser.env" "$state_dir/selection" "$state_dir/memory-mb" "$state_dir/memory-mb.lock" "$state_dir/resume.lock"
real_docker=$(readlink -f "$(command -v docker)")
# Containers land in kilo-docker/containers through dockerd's --cgroup-parent.
cat > "$state_dir/compose.memory.yml" <<YAML
services:
  postgres:
    mem_limit: 768m
    memswap_limit: 768m
    shm_size: 128m
  redis:
    mem_limit: 128m
    memswap_limit: 128m
  redis-http:
    mem_limit: 256m
    memswap_limit: 256m
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
  // dockerd's own BuildKit keeps images in the daemon store, so unchanged images rebuild from cache in seconds.
  const builds = process.env.KILO_DOCKER_CGROUP && path.join(process.env.KILO_DOCKER_CGROUP, 'containers/builds');
  if (build && builds && fs.existsSync(builds)) args.splice(1, 0, `--cgroup-parent=${builds.replace('/sys/fs/cgroup', '')}`);
  const command = build ? 'flock' : process.env.KILO_STARTUP_REAL_DOCKER;
  const commandArgs = build ? [path.join(__dirname, 'image-build.lock'), process.env.KILO_STARTUP_REAL_DOCKER, ...args] : args;
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
  for name in NEXT_TELEMETRY_DISABLED SKIP_STRIPE_API KILO_PORT_OFFSET KILO_ENV_SYNC_CONCURRENCY KILO_DOCKER_CGROUP; do
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
  # The full agents stack does not fit the sandbox budget; these are not needed for fake-LLM sessions on public repositories.
  env_default KILO_DEV_WITHOUT notifications,event-service,cloudflare-webhook-agent-ingest,container-usage-meter,cloudflare-git-token-service
  # Bound the web dev server's Turbopack memory. The cgroup cap sits below the
  # sandbox's MemTotal, so Turbopack's OS pressure feedback never sees the cap
  # and its `auto` eviction does not trigger; `full` evicts its persistent cache
  # to disk instead of holding it in RAM. Only this env var is set here; the app
  # config keeps `auto` everywhere else.
  env_default KILO_TURBOPACK_MEMORY_EVICTION full
  if [[ -n ${NODE_EXTRA_CA_CERTS:-} ]]; then
    env_default NODE_EXTRA_CA_CERTS "$NODE_EXTRA_CA_CERTS"
  fi
} > "$env_file"

"${root[@]}" rm -f "$global_state_dir/dev-cgroup"
"${root[@]}" mkdir -p "$global_state_dir"
printf '%s\n' "$real_pnpm" | "${root[@]}" tee "$global_state_dir/real-pnpm" >/dev/null
{
  printf '#!/usr/bin/env bash\n%s\n' "$pnpm_wrapper_marker"
  printf 'repo=%q\nenv_file=%q\n' "$repo" "$env_file"
  cat <<'SH'
real_pnpm=$(< /usr/local/lib/kilo-cloud-agent/real-pnpm)
if [[ ($PWD == "$repo" || $PWD == "$repo"/*) && -f $env_file ]]; then
  source "$env_file"
fi
exec "$real_pnpm" "$@"
SH
} > "$state_dir/pnpm-wrapper"
"${root[@]}" install -m 0755 "$state_dir/pnpm-wrapper" "${global_pnpm:-/usr/local/bin/pnpm}"
hash -r
fi
source "$env_file"

started_docker=0
if ! docker info >/dev/null 2>&1; then
  if [[ -z ${DOCKER_HOST:-} && -f /var/run/docker.pid ]] \
    && ! pgrep -x dockerd >/dev/null && ! mountpoint -q /var/run/docker.sock; then
    # A restored disk keeps the socket and pid file of a daemon that no longer exists.
    "${root[@]}" rm -f /var/run/docker.sock /var/run/docker.pid
  fi
  if [[ -n ${DOCKER_HOST:-} ]] || [[ -S /var/run/docker.sock ]]; then
    printf 'The supplied Docker daemon is inaccessible; fix Docker access and rerun.\n' >&2
    exit 1
  fi
  # These sandboxes mount /proc/sys read-only; overlay2 is supported by the current kernel.
  storage_driver="${KILO_STARTUP_DOCKER_STORAGE_DRIVER:-overlay2}"
  if [[ $storage_driver != overlay2 && $storage_driver != fuse-overlayfs ]]; then
    printf 'Only overlay2 or fuse-overlayfs are allowed; vfs layer copies are unsafe for this sandbox.\n' >&2
    exit 1
  fi
  dockerd_args=(--group="$(id -gn)" --storage-driver="$storage_driver" --ip-forward=false
    --bip="$bridge_gateway/16" --registry-mirror=https://mirror.gcr.io)
  if (( ! build_mode )); then
    dockerd_args+=(--cgroup-parent="${KILO_DOCKER_CGROUP#/sys/fs/cgroup}/containers")
  fi
  # Own the socket by the invoking user's group so a non-root sandbox can use the daemon it starts.
  dockerd_log="$state_dir/dockerd.log"
  mkdir -p "$state_dir"
  as_docker_daemon setsid env DOCKER_ALLOW_IPV6_ON_IPV4_INTERFACE=1 dockerd "${dockerd_args[@]}" \
    > "$dockerd_log" 2>&1 < /dev/null &
  started_docker=1
  for (( attempt=0; attempt<30; attempt++ )); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
  if ! docker info >/dev/null 2>&1; then
    printf 'Docker could not start. This sandbox must support nested containers or supply a Docker socket.\n' >&2
    tail -20 "$dockerd_log" >&2 || true
    exit 1
  fi
fi
if pgrep -a -x dockerd | grep -qF -- "--bip=$bridge_gateway/16"; then
  # Without IP forwarding, bridge containers reach only the host. Workerd pins sandbox
  # containers to public resolvers, so redirect all their DNS to a forwarder on the gateway.
  if ! pgrep -f "dnsmasq .*--listen-address=$bridge_gateway" >/dev/null; then
    # dnsmasq reads resolv.conf only once its mtime advances, and the sandbox's file is
    # dated 1970, so it would answer REFUSED. Pass the upstream servers explicitly.
    dns_servers=()
    while read -r key value _; do
      [[ $key == nameserver && -n $value ]] && dns_servers+=(--server="$value")
    done < /etc/resolv.conf
    (( ${#dns_servers[@]} )) || dns_servers=(--server=1.1.1.1 --server=8.8.8.8)
    as_docker_daemon dnsmasq --conf-file=/dev/null --no-hosts --no-resolv "${dns_servers[@]}" \
      --bind-interfaces --listen-address="$bridge_gateway"
  fi
  for proto in udp tcp; do
    dns_redirect=(PREROUTING -i docker0 -p "$proto" --dport 53 -j DNAT --to-destination "$bridge_gateway:53")
    "${root[@]}" iptables -t nat -C "${dns_redirect[@]}" 2>/dev/null || "${root[@]}" iptables -t nat -I "${dns_redirect[@]}"
  done
fi
if [[ $(docker info --format '{{.Driver}}') == vfs ]]; then
  printf 'The existing Docker daemon uses vfs. Stop it and restart with overlay2 or fuse-overlayfs before running this workload.\n' >&2
  exit 1
fi
if (( ! build_mode )) && tmux list-sessions >/dev/null 2>&1; then
  while IFS= read -r line; do
    tmux set-environment -g "${line%%=*}" "${line#*=}"
  done < <(bash -c 'source "$1"; for name in PATH SHELL KILO_PORT_OFFSET KILO_DOCKER_CGROUP KILO_STARTUP_REAL_DOCKER WRANGLER_DOCKER_BIN WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST NODE_EXTRA_CA_CERTS; do [[ -n ${!name:-} ]] && printf "%s=%s\n" "$name" "${!name}"; done' _ "$env_file")
fi

legacy_builder="kilo-lowmem-$(basename "$repo")"
if docker buildx inspect "$legacy_builder" >/dev/null 2>&1; then
  docker buildx rm --force "$legacy_builder" >/dev/null
fi

if (( resume )); then
  printf 'Resumed: Docker and DNS forwarding running in %s.\n' "$KILO_DOCKER_CGROUP"
  exit 0
fi

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

if (( ! build_mode )); then
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
fi

# wrangler dev builds every Cloud Agent sandbox image on start. Build them now so dev:start only hits the cache.
if [[ ${KILO_STARTUP_SANDBOX_IMAGES:-1} != 0 ]]; then
  printf 'Building Cloud Agent sandbox images (about 10 minutes on a new machine, under a minute when cached).\n'
  images_log="$state_dir/sandbox-images.log"
  setsid bash -c 'source "$1"; cd services/cloud-agent-next; exec pnpm run dev --port 28794 --inspector-port 38794 --ip 127.0.0.1' \
    _ "$env_file" > "$images_log" 2>&1 < /dev/null &
  images_pid=$!
  images_deadline=$(( SECONDS + 2400 ))
  until grep -qF 'Container image(s) ready' "$images_log"; do
    if ! kill -0 "$images_pid" 2>/dev/null || (( SECONDS > images_deadline )); then
      kill -KILL -- "-$images_pid" 2>/dev/null || true
      tail -20 "$images_log" >&2
      printf 'Building Cloud Agent sandbox images failed; see %s. Rerun setup, or set KILO_STARTUP_SANDBOX_IMAGES=0 to skip.\n' "$images_log" >&2
      exit 1
    fi
    sleep 5
  done
  kill -TERM -- "-$images_pid"
  wait "$images_pid" 2>/dev/null || true
fi

if (( build_mode )); then
  if (( started_docker )); then
    printf 'Stopping the Docker daemon before snapshot capture.\n'
    "${root[@]}" kill -TERM "$(< /var/run/docker.pid)" 2>/dev/null || true
    for (( attempt=0; attempt<20; attempt++ )); do
      docker info >/dev/null 2>&1 || break
      sleep 1
    done
  fi
  printf '\nEnvironment build complete. Docker packages and sandbox images are captured in the snapshot.\n'
  printf 'Session setup starts Docker and the dev database from that filesystem.\n'
else
  printf '\nSetup complete. Docker memory peak so far: %s MiB.\n' \
    "$(( $(< "$KILO_DOCKER_CGROUP/memory.peak") / 1048576 ))"
  printf 'Run from %s (pnpm there loads %s):\n' "$repo" "$env_file"
  printf '  pnpm dev:start --no-attach app                 # web app\n'
  printf '  pnpm dev:start --no-attach agents fake-llm     # Cloud Agents with local fake inference\n'
  printf 'KILO_DEV_WITHOUT skips services the sandbox does not need; pass --without= to start everything.\n'
  printf 'Then pnpm dev:status for ports; log in at http://localhost:<nextjs port>/users/sign_in?fakeUser=%s&callbackPath=/profile\n' "$test_email"
  printf 'Other shells (docker, agent-browser): source %q\n' "$env_file"
  printf 'Usage, limits, and troubleshooting: .kilo/skills/cloud-agent-sandbox/SKILL.md\n'
fi
