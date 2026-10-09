---
name: cloud-agent-sandbox
description: Sets up and runs this monorepo inside a memory-constrained Kilo Cloud Agent sandbox with `.kilo/cloud-agent-setup.sh`. Use when working in a Cloud Agent sandbox, before starting local services there, after a sandbox restart, or when debugging the dev memory cap, Docker, DNS, fake login, agent-browser, or fake-LLM Cloud Agent sessions in the sandbox.
---

# Cloud Agent sandbox

`.kilo/cloud-agent-setup.sh` prepares a Debian/Ubuntu Cloud Agent sandbox for
`pnpm dev:start`. It usually runs automatically when the machine starts. You can
run it at any time: reruns are safe and take about 20 s once the machine is set up.

Follow the `local-development` skill for ports, fake login, and service
management. This skill covers what is different in the sandbox.

## Is setup done?

Sandbox restarts wipe Docker, the pnpm wrapper, the memory cgroup, and
`.wrangler/kilo-startup/`. The repository and `node_modules` survive. Check
before starting services:

```bash
test -f .wrangler/kilo-startup/env \
  && grep -q kilo-cloud-agent-pnpm-wrapper "$(command -v pnpm)" \
  && docker info >/dev/null 2>&1 && echo ready
```

If this does not print `ready`, run setup from the repository root:

```bash
bash .kilo/cloud-agent-setup.sh
```

A restarted machine takes about 90 s, since `node_modules` survives. A machine
without dependencies takes about 4 minutes: apt packages, `pnpm install`,
Compose image pulls, and migrations. Setup stops at the first failure and prints
the line number.

## What setup does

- Creates a memory cgroup for all dev workloads, capped at the sandbox memory
  minus 2 GiB. Override the cap in MiB with `KILO_STARTUP_MEMORY_MB`; the
  minimum is 3072.
- Installs Docker, Compose v2, tmux, Chromium, agent-browser, and dnsmasq.
  Starts dockerd with its containers inside the cgroup and pulls images through
  `mirror.gcr.io`.
- Installs a global `pnpm` wrapper. Inside this repository it moves the command
  into the capped cgroup and loads `.wrangler/kilo-startup/env`. Outside the
  repository it runs the real pnpm, saved at
  `/usr/local/lib/kilo-cloud-agent/real-pnpm`, unchanged.
- Installs dependencies, creates `.env.local`, runs `pnpm test:db`, and seeds a
  fake-login user with credits.
- It does not start the dev stack.

`.wrangler/kilo-startup/env` only sets defaults. Override a value by exporting
it before running pnpm. Do not edit the file: setup rewrites it.

## Start services

Run every command from the repository root, so that pnpm is capped.

```bash
pnpm dev:start --no-attach app               # web app
pnpm dev:start --no-attach agents fake-llm   # Cloud Agents with local fake inference
pnpm dev:status                              # services and ports
pnpm dev:stop
```

- `KILO_DEV_WITHOUT` in the env file skips agents services that fake-LLM sessions
  on public repositories do not need: notifications, event-service,
  webhook-agent-ingest, container-usage-meter, and git-token-service. That
  leaves 7 services, about 3 GB when idle. Add services back with
  `--without=<smaller list>`. `--without=` starts everything, but the full agents
  stack does not fit in the cap.
- Expected warnings without those services: billing-heartbeat errors from the
  skipped usage meter. GitHub-backed repositories need git-token-service and
  GitHub App credentials, which the sandbox does not have.
- `--no-attach` returns once services are up: about 50 s for `app`. The first
  page load compiles with Turbopack and takes about 30 s more.
- The first agents start after a restart builds the Cloud Agent sandbox images.
  This can take 10 to 15 minutes. Later starts reuse them.
- `--reuse-running` currently refuses to reuse a session because the Stripe
  forwarder is always skipped. Check `pnpm dev:status` instead.

## Log in and use the browser

Setup seeds a verified user with credits. Its email is `KILO_TEST_USER_EMAIL` in
the env file. Shells outside the pnpm wrapper must load the env file first. It
also puts setup's `docker` wrapper on `PATH`, which keeps builds serialized and
inside the cap:

```bash
source .wrangler/kilo-startup/env
agent-browser --session main open "http://localhost:3000/users/sign_in?fakeUser=$KILO_TEST_USER_EMAIL&callbackPath=/profile"
```

- Read the real port from `pnpm dev:status`. It is 3000 unless an offset applies.
- The env file points agent-browser at the installed Chromium with a 120 s
  timeout. Confirm login with
  `agent-browser --session main eval '(async () => (await (await fetch("/api/auth/session")).json()).user?.email)()'`.
- If a click fails because the element is covered, focus the input and use
  `agent-browser press Enter`.
- Starting a Cloud Agent session from `/cloud` requires a connected GitHub or
  GitLab provider, which the sandbox cannot set up. Create sessions with the
  fake-LLM harness instead, then view them in the browser.

## Fake-LLM Cloud Agent sessions

Start `agents fake-llm`, then follow `services/cloud-agent-next/test/e2e/README.md`.
Ports below are the defaults; check `pnpm dev:status`.

```bash
WORKER_URL=http://localhost:8794 FAKE_LLM_URL=http://localhost:8811 \
  pnpm -s exec tsx services/cloud-agent-next/test/e2e/run.ts cold echo:hi
```

- Verified passing on the minimal stack: `cold echo:hi`, `cold-hot echo:hi`,
  `chunked-streaming slow:5:50`, `queue-while-busy`, and
  `--api=legacy cold-hot echo:legacy`. `llm-error boom` fails a retry-status
  assertion that is unrelated to the sandbox.
- Each run leaves a sandbox container of about 750 MB until it stops for being
  idle. Remove them between runs:
  `docker rm -f $(docker ps -q --filter name=workerd-cloud-agent-next-dev-Sandbox)`.
- The first session after `dev:start` can fail model validation with a 503
  ("Model availability could not be verified"). Turbopack is still compiling
  the validation route; retry once.
- To view harness sessions in the browser, set `E2E_USER_EMAIL` so runs reuse
  one driver user. Mark that user verified, then fake-login as it and open
  `/cloud/sessions`:

  ```bash
  docker compose -f dev/docker-compose.yml exec -T postgres psql -U postgres -d postgres -c \
    "UPDATE kilocode_users SET has_validation_stytch = true, completed_welcome_form = true WHERE google_user_email = '<driver email>'"
  ```

  Sending a message to a harness session from the UI fails with
  "Session not found".

## Memory

The cap is a hard limit with no swap. When the workload nears it, the kernel
reclaims memory instead of killing processes: everything slows, and
`docker`, `tmux`, and `pnpm dev:stop` can hang. Check pressure with:

```bash
cg=/sys/fs/cgroup/kilo-workloads/kilo-dev-$(basename "$PWD")
echo "$(( $(cat $cg/memory.current) / 1048576 )) MiB of $(( $(cat $cg/memory.max) / 1048576 )) MiB"
grep -E '^(high|max|oom_kill) ' $cg/memory.events
```

If the `max` count keeps rising, you are near the cap. Stop work you do not
need, remove idle sandbox containers, or start fewer services. Dev tooling is
heavy: wrangler and workerd use about 3 GB, and the pnpm parents and log filters
about 2 GB. Redis is not the problem; it idles under 1% CPU.

Run heavy commands such as builds, tests, and typechecks from inside the
repository, so that the wrapper caps them. pnpm outside the repository and
direct `node` or `npx` processes are not capped.

## Docker networking and DNS

`/proc/sys` is read-only, so dockerd runs with `--ip-forward=false`: bridge
containers can reach only the host. Workerd also pins sandbox containers to
1.1.1.1 and 8.8.8.8. Setup runs dnsmasq on the bridge gateway, 172.17.0.1, and
uses iptables to redirect all DNS from `docker0` to it.

A `git_network_failed` clone failure, or `Could not resolve host` inside a
sandbox, means this redirect is missing. Rerun setup, then check:

```bash
iptables -t nat -S PREROUTING | grep 'dport 53'
pgrep -a dnsmasq
docker exec <sandbox container> git ls-remote https://github.com/octocat/Hello-World.git
```

## Pitfalls

- `pkill -f next-server` also matches the shell that runs it. Use
  `pkill -f '[n]ext-server'`.
- Do not prune Docker images, volumes, or the BuildKit builder. Rebuilding the
  Cloud Agent images costs 10 to 15 minutes.
- Lint setup changes with `shellcheck -S warning -e SC1090 .kilo/cloud-agent-setup.sh`.
