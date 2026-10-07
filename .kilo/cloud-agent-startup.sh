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

"${root[@]}" apt-get update
"${root[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates chromium curl git git-lfs openssl sudo unzip tmux docker.io docker-compose

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
export AGENT_BROWSER_SOCKET_DIR="${AGENT_BROWSER_SOCKET_DIR:-/tmp/kilo-browser}"

if ! docker info >/dev/null 2>&1; then
  if [[ -n ${DOCKER_HOST:-} ]] || [[ -S /var/run/docker.sock ]]; then
    printf 'The supplied Docker daemon is inaccessible; fix Docker access and rerun.\n' >&2
    exit 1
  fi
  # Cloudflare sandboxes mount /proc/sys read-only and cannot use overlay-on-overlay.
  "${root[@]}" tmux new-session -d -s kilo-startup-docker \
    'env DOCKER_ALLOW_IPV6_ON_IPV4_INTERFACE=1 dockerd --storage-driver=vfs --ip-forward=false'
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
export WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST=1
if [[ -n ${NODE_EXTRA_CA_CERTS:-} && -f $NODE_EXTRA_CA_CERTS ]]; then
  mkdir -p .wrangler/kilo-startup
  export WRANGLER_DOCKER_BIN="$PWD/.wrangler/kilo-startup/sandbox-docker.cjs"
  cat > "$WRANGLER_DOCKER_BIN" <<'JS'
#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const stdinDockerfile = args[0] === 'build' && args.some((arg, i) =>
  (arg === '-f' || arg === '--file') && args[i + 1] === '-');
function run(input) {
  const child = spawn('docker', args, { stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'] });
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
    const cert = fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS).toString('base64');
    // Trust the sandbox's HTTPS interception CA inside development images, not production sources.
    dockerfile = dockerfile.replace(/^FROM (?:docker.io\/)?cloudflare\/sandbox:[^\n]+/m, from =>
      `${from}\nRUN mkdir -p /usr/local/share/ca-certificates && printf '%s' '${cert}' | base64 -d > /usr/local/share/ca-certificates/kilo-sandbox.crt && update-ca-certificates\nENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/kilo-sandbox.crt`);
    run(dockerfile);
  });
}
JS
  chmod +x "$WRANGLER_DOCKER_BIN"
fi
if tmux list-sessions >/dev/null 2>&1; then
  tmux set-environment -g WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST 1
  tmux set-environment -g GOMAXPROCS "$GOMAXPROCS"
  tmux set-environment -g RAYON_NUM_THREADS "$RAYON_NUM_THREADS"
  if [[ -n ${WRANGLER_DOCKER_BIN:-} ]]; then
    tmux set-environment -g WRANGLER_DOCKER_BIN "$WRANGLER_DOCKER_BIN"
    tmux set-environment -g NODE_EXTRA_CA_CERTS "$NODE_EXTRA_CA_CERTS"
  fi
fi

pnpm install --frozen-lockfile
if [[ ! -s .env.local ]]; then
  (umask 077; pnpm dev:setup-env --ci)
  printf 'Created local-only credentials. Real payment, model, and Git integrations require supplied secrets.\n'
fi

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

if (( $# == 0 )); then
  set -- cloud-agent
fi
pnpm dev:start --no-attach --reuse-running "$@"
pnpm test:db

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

pnpm dev:status --json
printf '\nWeb app: %s\nFake test-account login: %s/users/sign_in?fakeUser=kilo-%s-%s%%2Bstytchpass@example.com&callbackPath=/profile\n' \
  "$web_url" "$web_url" "$(basename "$HOME")" "$(date -u +%Y%m%d%H%M%S)"
printf 'Browser setup: export AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium AGENT_BROWSER_SOCKET_DIR=%q\n' "$AGENT_BROWSER_SOCKET_DIR"
printf 'Browser: agent-browser open <login-url>, then agent-browser snapshot -i\n'
printf 'Cloud Agent testing: select kilo/fake-deterministic for local inference; real inference needs provider credentials.\n'
printf 'Manage services with pnpm dev:status, pnpm dev:restart <service>, and pnpm dev:stop.\n'
