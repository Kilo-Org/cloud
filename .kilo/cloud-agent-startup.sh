#!/usr/bin/env bash
set -Eeuo pipefail

trap 'printf "Startup failed at line %s. Check dev/logs/ and pnpm dev:status --json.\n" "$LINENO" >&2' ERR

cd "$(dirname "${BASH_SOURCE[0]}")/.."
export CI=true
export KILO_PORT_OFFSET="${KILO_PORT_OFFSET:-auto}"
export NEXT_TELEMETRY_DISABLED=1
export SKIP_STRIPE_API="${SKIP_STRIPE_API:-true}"
export GOMAXPROCS="${GOMAXPROCS:-2}"
export RAYON_NUM_THREADS="${RAYON_NUM_THREADS:-2}"
export KILO_ENV_SYNC_CONCURRENCY=1
export NODE_OPTIONS=--max-old-space-size=512
if (( $# == 0 )); then
  set -- app
fi
cloud_agents=false
if [[ "$*" != app ]]; then
  cloud_agents=true
fi
export KILO_STARTUP_MEMORY_MB="${KILO_STARTUP_MEMORY_MB:-$([[ $cloud_agents == true ]] && printf 6144 || printf 5120)}"

if [[ $(uname -s) != Linux ]] || ! command -v apt-get >/dev/null; then
  printf 'This startup script requires a Debian/Ubuntu Linux sandbox.\n' >&2
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

if [[ ! $KILO_STARTUP_MEMORY_MB =~ ^[0-9]+$ ]] || (( KILO_STARTUP_MEMORY_MB < 3072 )); then
  printf 'KILO_STARTUP_MEMORY_MB must be an integer of at least 3072 MiB.\n' >&2
  exit 1
fi
export KILO_STARTUP_CGROUP="/sys/fs/cgroup/kilo-workloads/kilo-dev-$(basename "$PWD")"
if [[ ! -f /sys/fs/cgroup/kilo-workloads/memory.max ]]; then
  printf 'Memory-safe startup requires the sandbox\x27s delegated cgroup v2 memory controller. No workloads were started.\n' >&2
  exit 1
fi
node -e '
  const fs = require("node:fs");
  const parent = "/sys/fs/cgroup/kilo-workloads";
  function protectedMemory(directory) {
    const stat = Object.fromEntries(fs.readFileSync(directory + "/memory.stat", "utf8").trim().split("\n").map(line => line.split(" ")));
    const current = Number(fs.readFileSync(directory + "/memory.current", "utf8"));
    return current - Number(stat.inactive_file || 0) + Number(stat.file_dirty || 0) + Number(stat.file_writeback || 0);
  }
  const maximum = Number(fs.readFileSync(parent + "/memory.max", "utf8"));
  const available = Number(fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)/m)[1]) * 1024;
  const protectedBytes = protectedMemory(parent);
  const existing = fs.existsSync(process.env.KILO_STARTUP_CGROUP + "/memory.current") ? protectedMemory(process.env.KILO_STARTUP_CGROUP) : 0;
  const additional = Math.max(0, Number(process.env.KILO_STARTUP_MEMORY_MB) * 1048576 - existing);
  const safeBytes = Math.min(available, Number.isFinite(maximum) ? maximum - protectedBytes : available) - 2048 * 1048576;
  if (additional > safeBytes) throw new Error("Insufficient memory headroom: use the app profile, stop other workloads, or use a larger sandbox");
'
"${root[@]}" mkdir -p "$KILO_STARTUP_CGROUP"
printf '%s\n' "$(( KILO_STARTUP_MEMORY_MB * 1048576 ))" | "${root[@]}" tee "$KILO_STARTUP_CGROUP/memory.max" >/dev/null
printf '%s\n' "$(( KILO_STARTUP_MEMORY_MB * 1048576 * 95 / 100 ))" | "${root[@]}" tee "$KILO_STARTUP_CGROUP/memory.high" >/dev/null
printf '0\n' | "${root[@]}" tee "$KILO_STARTUP_CGROUP/memory.swap.max" >/dev/null
printf '1\n' | "${root[@]}" tee "$KILO_STARTUP_CGROUP/memory.oom.group" >/dev/null
printf '+memory +cpu\n' | "${root[@]}" tee "$KILO_STARTUP_CGROUP/cgroup.subtree_control" >/dev/null
"${root[@]}" mkdir -p "$KILO_STARTUP_CGROUP/processes" "$KILO_STARTUP_CGROUP/containers"
printf '%s\n' "$$" | "${root[@]}" tee "$KILO_STARTUP_CGROUP/processes/cgroup.procs" >/dev/null
printf 'Startup workload capped at %s MiB, with 2048 MiB reserved for other sandbox workloads.\n' "$KILO_STARTUP_MEMORY_MB"

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
  docker_packages+=(docker-compose)
fi
"${root[@]}" env DEBIAN_FRONTEND=noninteractive timeout --foreground 10m apt-get install -y --no-install-recommends \
  ca-certificates chromium curl fuse-overlayfs git git-lfs openssl sudo unzip tmux "${docker_packages[@]}"

if ! command -v node >/dev/null || [[ $(node -p 'process.versions.node.split(".")[0]') != 24 ]]; then
  printf 'The sandbox image must provide Node.js 24 and Corepack before running this script.\n' >&2
  exit 1
fi
"${root[@]}" corepack enable
corepack install

tools=()
command -v bun >/dev/null || tools+=(bun@1.3.13)
command -v agent-browser >/dev/null || tools+=(agent-browser@0.38.2)
if (( ${#tools[@]} )); then
  "${root[@]}" corepack pnpm add --global --global-dir /opt/kilo-startup-tools \
    --global-bin-dir /usr/local/bin "${tools[@]}"
fi
export AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
export AGENT_BROWSER_ENGINE=chrome
export AGENT_BROWSER_SOCKET_DIR="${AGENT_BROWSER_SOCKET_DIR:-/tmp/kilo-browser}"
export AGENT_BROWSER_ARGS="${AGENT_BROWSER_ARGS:---disable-gpu}"
export AGENT_BROWSER_DEFAULT_TIMEOUT="${AGENT_BROWSER_DEFAULT_TIMEOUT:-120000}"

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
  "${root[@]}" tmux new-session -d -s kilo-startup-docker \
    "env DOCKER_ALLOW_IPV6_ON_IPV4_INTERFACE=1 dockerd --storage-driver=$storage_driver --ip-forward=false --cgroup-parent=${KILO_STARTUP_CGROUP#/sys/fs/cgroup}/containers"
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
docker compose version
if [[ $(docker info --format '{{.Driver}}') == vfs ]]; then
  printf 'The existing Docker daemon uses vfs. Stop it and restart with overlay2 or fuse-overlayfs before running this workload.\n' >&2
  exit 1
fi
if tmux list-sessions >/dev/null 2>&1; then
  tmux_pid=$(tmux display-message -p '#{pid}')
  if ! node -e 'const fs = require("node:fs"); process.exit(fs.readFileSync("/proc/" + process.argv[1] + "/cgroup", "utf8").includes(process.env.KILO_STARTUP_CGROUP.replace("/sys/fs/cgroup", "") + "/processes") ? 0 : 1)' "$tmux_pid"; then
    printf 'The existing tmux server is outside the startup memory budget. Stop its sessions before running this script.\n' >&2
    exit 1
  fi
fi
mkdir -p .wrangler/kilo-startup/bin
real_docker=${KILO_STARTUP_REAL_DOCKER:-$(command -v docker)}
real_pnpm=${KILO_STARTUP_REAL_PNPM:-$(command -v pnpm)}
export KILO_STARTUP_REAL_PNPM="$real_pnpm"
cat > .wrangler/kilo-startup/compose.memory.yml <<YAML
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
cat > .wrangler/kilo-startup/bin/pnpm <<SH
#!/usr/bin/env bash
export NODE_OPTIONS=--max-old-space-size=512
web=false
if [[ \$PWD == */apps/web ]]; then
  web=true
fi
for arg in "\$@"; do
  if [[ \$arg == *apps/web* ]]; then
    web=true
  fi
done
if [[ \$web == true ]]; then
  export NODE_OPTIONS=--max-old-space-size=2048
  if [[ " \$* " == *" run dev "* ]]; then
    set -- "\$@" --webpack
  fi
fi
exec "$real_pnpm" "\$@"
SH
cat > .wrangler/kilo-startup/bin/kilo-shell <<'SH'
#!/usr/bin/env bash
if [[ ${1:-} == -lc ]]; then
  shift
  exec /bin/bash --noprofile --norc -c "$@"
fi
exec /bin/bash "$@"
SH
chmod +x .wrangler/kilo-startup/bin/pnpm .wrangler/kilo-startup/bin/kilo-shell
export WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST=1
export KILO_STARTUP_REAL_DOCKER="$real_docker"
export KILO_STARTUP_BUILDER="kilo-lowmem-$(basename "$PWD")"
export WRANGLER_DOCKER_BIN="$PWD/.wrangler/kilo-startup/sandbox-docker.cjs"
  cat > "$WRANGLER_DOCKER_BIN" <<'JS'
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
    dockerfile = dockerfile.replace(/^FROM (?:docker.io\/)?cloudflare\/sandbox:[^\n]+/m, from =>
      `${from}\n${trust}\n${limits}`);
    run(dockerfile);
  });
}
JS
chmod +x "$WRANGLER_DOCKER_BIN"
ln -sf "$WRANGLER_DOCKER_BIN" .wrangler/kilo-startup/bin/docker
export PATH="$PWD/.wrangler/kilo-startup/bin:$PATH"
export SHELL="$PWD/.wrangler/kilo-startup/bin/kilo-shell"
"$SHELL" -lc "cd $(printf '%q' "$PWD/apps/web") && pnpm exec node -e 'if (process.env.NODE_OPTIONS !== \"--max-old-space-size=2048\") throw new Error(\"Web heap budget is not applied\")'"
if [[ $cloud_agents == true ]]; then
  cat > .wrangler/kilo-startup/buildkitd.toml <<'TOML'
[worker.oci]
  max-parallelism = 1
  networkMode = "host"
[registry."docker.io"]
  mirrors = ["mirror.gcr.io"]
TOML
  if [[ -n ${NODE_EXTRA_CA_CERTS:-} && -f $NODE_EXTRA_CA_CERTS ]]; then
    ca_path=$(node -p 'JSON.stringify(process.env.NODE_EXTRA_CA_CERTS)')
    printf '  ca = [%s]\n[registry."mirror.gcr.io"]\n  ca = [%s]\n' "$ca_path" "$ca_path" >> .wrangler/kilo-startup/buildkitd.toml
  fi
  if ! docker buildx inspect "$KILO_STARTUP_BUILDER" >/dev/null 2>&1; then
    docker buildx create --name "$KILO_STARTUP_BUILDER" --driver docker-container \
      --driver-opt "image=mirror.gcr.io/moby/buildkit:v0.16.0,memory=2g,memory-swap=2g,network=host,cgroup-parent=${KILO_STARTUP_CGROUP#/sys/fs/cgroup}/containers" \
      --buildkitd-config "$PWD/.wrangler/kilo-startup/buildkitd.toml" \
      --buildkitd-flags '--allow-insecure-entitlement network.host'
  fi
  timeout 3m docker buildx inspect --bootstrap "$KILO_STARTUP_BUILDER"
  docker inspect "buildx_buildkit_${KILO_STARTUP_BUILDER}0" --format '{{json .HostConfig}}' | node -e '
    let input = "";
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      const config = JSON.parse(input);
      const parent = process.env.KILO_STARTUP_CGROUP.replace("/sys/fs/cgroup", "") + "/containers";
      if (config.Memory !== 2147483648 || config.CgroupParent !== parent) throw new Error("BuildKit is not inside its required memory budget");
    });
  '
fi
if tmux list-sessions >/dev/null 2>&1; then
  tmux set-environment -g WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST 1
  tmux set-environment -g GOMAXPROCS "$GOMAXPROCS"
  tmux set-environment -g RAYON_NUM_THREADS "$RAYON_NUM_THREADS"
  tmux set-environment -g NODE_OPTIONS "$NODE_OPTIONS"
  tmux set-environment -g SHELL "$SHELL"
  tmux set-environment -g KILO_ENV_SYNC_CONCURRENCY 1
  tmux set-environment -g KILO_STARTUP_BUILDER "$KILO_STARTUP_BUILDER"
  tmux set-environment -g KILO_STARTUP_REAL_DOCKER "$KILO_STARTUP_REAL_DOCKER"
  if [[ -n ${WRANGLER_DOCKER_BIN:-} ]]; then
    tmux set-environment -g WRANGLER_DOCKER_BIN "$WRANGLER_DOCKER_BIN"
    if [[ -n ${NODE_EXTRA_CA_CERTS:-} ]]; then
      tmux set-environment -g NODE_EXTRA_CA_CERTS "$NODE_EXTRA_CA_CERTS"
    fi
  fi
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
    throw new Error("Sandbox startup requires a local POSTGRES_URL; remote databases will not be migrated or seeded");
  }
'

# Avoid Docker Hub's shared unauthenticated pull limit without changing Compose files.
while IFS= read -r image; do
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    if docker pull "mirror.gcr.io/$image"; then
      docker tag "mirror.gcr.io/$image" "$image"
    else
      docker pull "$image"
    fi
  fi
done < <(docker compose -f dev/docker-compose.yml config --images | sort -u)

mkdir -p .wrangler/kilo-startup
selection=$(printf '%s\n' "$@")
status=$(pnpm -s dev:status --json)
if node -e 'process.exit(JSON.parse(process.argv[1]).services.length ? 0 : 1)' "$status"; then
  if [[ ! -f .wrangler/kilo-startup/selection || $(< .wrangler/kilo-startup/selection) != "$selection" ]]; then
    printf 'A different dev stack is already running. Stop it with pnpm dev:stop before changing the selection.\n' >&2
    exit 1
  fi
  printf 'Reusing this sandbox startup script\x27s existing dev stack.\n'
  while IFS= read -r service; do
    printf 'Restarting unavailable service: %s\n' "$service"
    timeout 1m pnpm dev:restart "$service"
  done < <(node -e 'for (const s of JSON.parse(process.argv[1]).services) if (s.status !== "up") console.log(s.name)' "$status")
else
  timeout --foreground 5m pnpm dev:start --no-attach "$@"
  printf '%s\n' "$selection" > .wrangler/kilo-startup/selection
fi
printf 'Preparing the local database (up to 5 minutes).\n'
timeout --foreground 5m pnpm test:db

web_port=$(node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync("dev/logs/manifest.json", "utf8"));
  const service = manifest.services.find(service => service.name === "nextjs");
  if (!service?.port) throw new Error("The selected stack must include nextjs");
  console.log(service.port);
')
web_url="http://localhost:$web_port"
ready=false
for (( attempt=0; attempt<90; attempt++ )); do
  if curl --fail --silent --output /dev/null --max-time 10 "$web_url/users/sign_in"; then
    ready=true
    break
  fi
  sleep 2
done
if [[ $ready != true ]]; then
  printf 'Web app did not become ready at %s.\n' "$web_url" >&2
  pnpm dev:status --json
  exit 1
fi

if node -e 'const m = require("./dev/logs/manifest.json"); process.exit(m.services.some(s => s.name === "cloud-agent-next") ? 0 : 1)'; then
  printf 'Waiting for Cloud Agent images (up to 15 minutes). Build output: dev/logs/cloud-agent-next.log\n'
  ready=false
  for (( attempt=0; attempt<450; attempt++ )); do
    if grep -Fq 'Container image(s) ready' dev/logs/cloud-agent-next.log; then
      ready=true
      break
    fi
    if grep -Fq '[ERROR]' dev/logs/cloud-agent-next.log; then
      printf 'Cloud Agent image preparation failed. See dev/logs/cloud-agent-next.log.\n' >&2
      exit 1
    fi
    if (( attempt > 0 && attempt % 30 == 0 )); then
      printf 'Cloud Agent image preparation is still running (%s seconds).\n' "$(( attempt * 2 ))"
    fi
    sleep 2
  done
  if [[ $ready != true ]]; then
    printf 'Cloud Agent images did not become ready within 15 minutes. See dev/logs/cloud-agent-next.log.\n' >&2
    exit 1
  fi
  docker stop "buildx_buildkit_${KILO_STARTUP_BUILDER}0"
fi

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

status=$(pnpm -s dev:status --json)
node -e '
  const status = JSON.parse(process.argv[1]);
  const unavailable = status.services.filter(service => service.status !== "up");
  if (unavailable.length) throw new Error("Services are not ready: " + unavailable.map(s => s.name).join(", "));
' "$status"
printf '%s\n' "$status"
export KILO_DEV_WEB_URL="$web_url"
export KILO_TEST_LOGIN_URL="$web_url/users/sign_in?fakeUser=$test_email&callbackPath=/profile"
printf 'export AGENT_BROWSER_ENGINE=%q AGENT_BROWSER_EXECUTABLE_PATH=%q AGENT_BROWSER_SOCKET_DIR=%q AGENT_BROWSER_ARGS=%q AGENT_BROWSER_DEFAULT_TIMEOUT=%q KILO_DEV_WEB_URL=%q KILO_TEST_LOGIN_URL=%q PATH=%q KILO_STARTUP_REAL_DOCKER=%q KILO_STARTUP_REAL_PNPM=%q KILO_STARTUP_BUILDER=%q NODE_OPTIONS=%q SHELL=%q\n' \
  "$AGENT_BROWSER_ENGINE" \
  "$AGENT_BROWSER_EXECUTABLE_PATH" "$AGENT_BROWSER_SOCKET_DIR" "$AGENT_BROWSER_ARGS" \
  "$AGENT_BROWSER_DEFAULT_TIMEOUT" "$KILO_DEV_WEB_URL" "$KILO_TEST_LOGIN_URL" \
  "$PATH" "$KILO_STARTUP_REAL_DOCKER" "$KILO_STARTUP_REAL_PNPM" "$KILO_STARTUP_BUILDER" "$NODE_OPTIONS" "$SHELL" \
  > .wrangler/kilo-startup/browser.env
if [[ ${KILO_STARTUP_BROWSER_SMOKE:-true} == true ]]; then
  agent-browser --session kilo-startup batch --bail \
    'cookies clear' \
    "open $KILO_TEST_LOGIN_URL" \
    "wait --fn 'window.location.pathname === \"/profile\" && document.body.innerText.includes(\"$test_email\")'" \
    'snapshot -i' 'close'
fi
printf '\nWeb app: %s\nFake test-account login: %s/users/sign_in?fakeUser=%s&callbackPath=/profile\n' \
  "$web_url" "$web_url" "$test_email"
printf 'Browser setup: source .wrangler/kilo-startup/browser.env\n'
printf 'Browser: agent-browser --session kilo-startup open %q, then agent-browser --session kilo-startup snapshot -i\n' "$KILO_TEST_LOGIN_URL"
printf 'Cloud Agent testing: select kilo/fake-deterministic for local inference; real inference needs provider credentials.\n'
printf 'Default profile is app. For Cloud Agents: bash .kilo/cloud-agent-startup.sh agents fake-llm (after pnpm dev:stop).\n'
printf 'Memory peak: %s MiB / %s MiB hard limit.\n' "$(( $(< "$KILO_STARTUP_CGROUP/memory.peak") / 1048576 ))" "$KILO_STARTUP_MEMORY_MB"
printf 'Manage services with pnpm dev:status, pnpm dev:restart <service>, and pnpm dev:stop.\n'
