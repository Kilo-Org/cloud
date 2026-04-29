# Cloud Agent Next Dev Container Support Brainstorm

## Goal

Allow a cloud-agent-next session to use a user-provided dev container as the execution environment, so the Kilo server and agent loop run with the repository's declared OS packages, language runtimes, tools, and dependency setup.

The safest practical path is to keep the existing Cloudflare Sandbox as an outer control plane, run Docker-in-Docker inside it, create the user's dev container as an inner container, start only `kilo serve` inside that inner container, and keep the cloud-agent wrapper in the outer sandbox connected to Kilo over HTTP.

## Current Architecture Touchpoints

- `services/cloud-agent-next/wrangler.jsonc` defines fixed Cloudflare Sandbox container images for `Sandbox` and `SandboxSmall`.
- `services/cloud-agent-next/Dockerfile` builds one sandbox image with `@kilocode/cli`, `bun`, `gh`, `glab`, and the bundled wrapper.
- `services/cloud-agent-next/src/execution/orchestrator.ts` gets a sandbox, prepares the workspace, ensures the wrapper, downloads images, then sends the prompt.
- `services/cloud-agent-next/src/session-service.ts` clones repos, creates Cloudflare sandbox sessions, injects env vars, runs setup commands, writes auth/rules, and stores metadata.
- `services/cloud-agent-next/src/persistence/async-preparation.ts` performs async prepare: token resolution, clone, branch, setup commands, session import, wrapper start.
- `services/cloud-agent-next/src/kilo/wrapper-client.ts` assumes wrapper processes run directly in the Cloudflare sandbox and are reachable at `127.0.0.1:<port>` from that sandbox session.
- `services/cloud-agent-next/wrapper/src/main.ts` starts Kilo in-process through `createKilo()`, not by shelling out to `kilo serve`.

## Recommended Shape

### Runtime model

1. Outer container: Cloudflare Sandbox with rootless Docker daemon and devcontainer CLI installed.
2. Workspace clone: continue cloning the repository into the outer sandbox under `/workspace/.../sessions/<agent_session_id>`.
3. Dev container creation: run `devcontainer up --workspace-folder <outerWorkspacePath>` from the outer sandbox.
4. Tool injection: mount or copy a Kilo server bundle into the inner dev container.
5. Kilo server execution: start `kilo serve` inside the inner dev container, with its working directory set to the devcontainer `remoteWorkspaceFolder`.
6. Wrapper execution: start `kilocode-wrapper` in the outer sandbox image, where we control Bun/Node/runtime dependencies.
7. Prompt execution: keep worker -> wrapper HTTP flow unchanged; the wrapper connects to the inner Kilo server over HTTP.

This keeps Kilo's file tools, shell commands, MCP local processes, and package managers inside the same environment the user intended, while keeping the wrapper in a trusted and predictable runtime that does not depend on the user's image.

### Why not make each user devcontainer the Cloudflare Container image directly?

Cloudflare container images are declared in Wrangler config for a Durable Object class. That works well for a fixed service image, but not for arbitrary per-session images supplied at runtime. A direct image-per-session model would require build/push/orchestration infrastructure outside the current worker deployment model, plus dynamic routing to image-specific container classes. Docker-in-Docker inside the existing sandbox avoids that platform mismatch.

## Required Work

### 1. Add a Docker-enabled sandbox image

Create a new sandbox image variant, likely `Dockerfile.dind`, based on Cloudflare's Docker-in-Docker guidance:

- Base from `docker:dind-rootless`.
- Copy the Cloudflare sandbox binary from the matching `cloudflare/sandbox:<version>-musl` image.
- Start `dockerd` with `--iptables=false --ip6tables=false`.
- Install or copy:
  - `git`, `gh`, `glab`, `jq`, `curl`, `bash`
  - `@devcontainers/cli`
  - Kilo wrapper/tool bundle
  - enough runtime support to run the wrapper or a compiled wrapper binary
- Add a new container binding in `wrangler.jsonc`, or replace the current sandbox image behind a feature flag.

Key platform constraints:

- Rootless Docker only.
- No iptables support.
- Inner containers that need networking should run with host networking.
- Built images and inner containers are ephemeral when the outer sandbox sleeps, unless we add explicit persistence/cache.

### 2. Add devcontainer input and metadata

Extend prepare/update metadata with a devcontainer config, for example:

```ts
type DevcontainerConfig = {
  enabled: boolean;
  configPath?: string;
  selectedFolder?: string;
  source?: 'repo' | 'inline' | 'image';
  image?: string;
};
```

Start with repo-sourced configs:

- `.devcontainer/devcontainer.json`
- `.devcontainer.json`
- `.devcontainer/<folder>/devcontainer.json`

If multiple configs exist, require explicit selection. Later, allow backend-provided inline config or prebuilt image references.

Persist in:

- `MetadataSchema`
- `CloudAgentSessionState`
- `PreparationInputSchema`
- `ExecutionPlan` / init context
- `prepareSession`, `updateSession`, and internal callers

### 3. Introduce an execution runtime abstraction

Today code assumes `ExecutionSession` from `@cloudflare/sandbox` and the wrapper starts its own in-process Kilo server. Devcontainers need a split runtime because the wrapper should remain in the outer sandbox while Kilo runs inside the inner container.

Add something like:

```ts
type WorkspaceRuntime = {
  kind: 'sandbox' | 'devcontainer';
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  startProcess(command: string, options?: StartProcessOptions): Promise<ProcessHandle>;
  writeFile(path: string, content: string): Promise<void>;
  resolveWorkspacePath(hostPath: string): string;
  ensureKiloServer(agentSessionId: string, options: KiloServerOptions): Promise<{ url: string }>;
  stopKiloServer(agentSessionId: string): Promise<void>;
};
```

Implementations:

- `SandboxRuntime`: wraps the current Cloudflare sandbox session; behavior stays unchanged and can still use wrapper-created in-process Kilo.
- `DevcontainerRuntime`: starts and controls `kilo serve` via `docker exec` or `devcontainer exec` inside the inner container; maps outer workspace path to `remoteWorkspaceFolder`; tracks the Kilo server process and URL.

Then update:

- The wrapper to support an externally managed Kilo server URL instead of always calling `createKilo()`.
- `WrapperClient` or a new `KiloServerManager` to start/stop the inner Kilo server before starting the wrapper.
- `SessionService` and `async-preparation` to return both host session and active runtime.
- image attachment download logic to write files where the active runtime can read them.

### 4. Build a devcontainer manager

Add a `src/devcontainer/` module responsible for:

- Detecting config files after clone.
- Parsing and validating a safe subset of `devcontainer.json`.
- Generating a temporary merged/overlay config with Kilo-required settings.
- Running `devcontainer read-configuration` for resolved metadata.
- Running `devcontainer up` and capturing:
  - container ID
  - remote user
  - remote workspace folder
  - config hash
  - image tag or build cache key
- Running lifecycle commands during prepare.
- Recreating the devcontainer on cold resume if the inner container is missing.
- Cleaning up containers/images/volumes by labels.

MVP supported properties:

- `image`
- `build.dockerfile`
- `build.context`
- `build.args` with strict secret rules
- `features` if the devcontainer CLI handles them cleanly in DIND
- `containerEnv`
- `remoteEnv`
- `remoteUser`
- `containerUser`
- `workspaceFolder`
- lifecycle commands: `onCreateCommand`, `updateContentCommand`, `postCreateCommand`, `postStartCommand`

MVP rejected or deferred properties:

- `dockerComposeFile`
- `privileged`
- unsafe `capAdd` / `securityOpt`
- bind mounts outside the session workspace/home/cache allowlist
- Docker socket mounts
- GPU/device requirements
- complex port forwarding semantics beyond host-network access

### 5. Inject Kilo server tooling into arbitrary containers

The inner devcontainer cannot be assumed to have Bun, Node, npm, or Kilo installed. The wrapper does not need to be injected if it stays in the outer sandbox; only the Kilo server runtime needs to be available inside the devcontainer.

Options:

1. Mount a read-only `/opt/kilo-agent` bundle from the outer sandbox into the devcontainer and run `kilo serve` from there.
2. Copy the bundle into the devcontainer after startup with `docker cp` and run it from a session-scoped path.
3. Build a small Kilo devcontainer Feature that installs the Kilo CLI/server during devcontainer build/create.

Best MVP path: mounted Kilo server bundle. Avoid relying on the user's package manager.

The wrapper should stop using `createKilo()` for devcontainer sessions and instead connect to an externally started `kilo serve` URL. If `@kilocode/sdk` does not expose a client constructor for an existing server URL, add one or keep the wrapper's current raw HTTP adapter and instantiate it directly against the URL.

Concrete packaging for `@kilocode/cli`:

- Do not rely on the top-level npm `bin/kilo` shim inside the user devcontainer.
- At outer sandbox image build time, install or unpack `@kilocode/cli` plus its platform optional packages into `/opt/kilo-agent`.
- Include Linux platform artifacts we expect to encounter in devcontainers, at minimum glibc and musl x64 builds, for example `@kilocode/cli-linux-x64` and `@kilocode/cli-linux-x64-musl`.
- Add our own `/opt/kilo-agent/bin/kilo` launcher shell script that detects architecture/libc inside the devcontainer and `exec`s the matching packaged binary.
- Mount `/opt/kilo-agent` read-only into the devcontainer, or `docker cp` it into a session-scoped path if bind mounts are not reliable.
- Run `kilo serve` from that mounted/copied binary. `npm`, `node`, or `bun` should only be needed in the outer image build process, not inside the user devcontainer, assuming the platform package binary is self-contained.

### 6. Handle environment, auth, and home directory

Current session setup injects `HOME=/home/<sessionId>`, writes auth to `<HOME>/.local/share/kilo/auth.json`, and writes global rules to `<HOME>/.kilocode/rules/cloud-agent.md`.

Devcontainer support needs to decide which home/config model `kilo serve` uses inside the devcontainer:

- Preserve cloud-agent HOME: run `kilo serve` with `HOME=/home/<sessionId>` inside the devcontainer, mounted from the outer sandbox.
- Use remote user's HOME: write Kilo auth/rules into the devcontainer remote user's actual home and keep `SESSION_HOME` as Kilo-specific storage.

The second model is more compatible with devcontainers because language managers and profile-based paths often assume the remote user's home. It requires changing auth/rule writing to target the inner runtime's effective home.

Runtime secrets should be injected only when starting wrapper/Kilo, not during image build:

- `KILOCODE_TOKEN`
- `KILO_CONFIG_CONTENT`
- `OPENCODE_CONFIG_CONTENT`
- `GH_TOKEN`
- `GITLAB_TOKEN`
- user env vars and decrypted secrets

Avoid passing Kilo tokens as Docker build args or persistent container env where possible.

### 7. Adjust preparation flow

Current prepare order:

1. disk check
2. workspace setup
3. clone
4. branch
5. setup commands
6. auth file
7. session import
8. wrapper start

Devcontainer order should be:

1. disk check in outer sandbox
2. workspace setup in outer sandbox
3. clone and branch in outer sandbox
4. discover/validate devcontainer config from the cloned repo
5. `devcontainer up` with Kilo-required labels, network mode, mounts, and env policy
6. run devcontainer lifecycle commands
7. run cloud-agent `setupCommands` inside the devcontainer, or document that devcontainer lifecycle supersedes them
8. write Kilo auth/rules into the runtime home
9. import/restore Kilo session inside the devcontainer
10. start `kilo serve` inside the devcontainer
11. start or reuse the wrapper in the outer sandbox, connected to the inner Kilo server URL
12. persist devcontainer metadata in the session DO

Add preparation progress steps such as:

- `devcontainer_config`
- `devcontainer_build`
- `devcontainer_start`
- `devcontainer_lifecycle`

### 8. Rework Kilo server networking and security

Because DIND requires host networking for reliable connectivity, the inner `kilo serve` port will likely be reachable from other processes in the outer sandbox and probably from the inner user container.

Hardening to add before broad rollout:

- Require a random auth token on all wrapper HTTP requests and, if supported, on `kilo serve` HTTP requests.
- Keep both wrapper and `kilo serve` bound to `127.0.0.1` when possible.
- Allocate ports from a controlled range and record them in metadata.
- Track the inner Kilo server process via `docker exec pgrep` plus labels or a session marker.
- Stop Kilo servers and inner containers during idle cleanup and session deletion.

### 9. Caching and cold resume

Without caching, Dockerfile-based devcontainers will be slow and expensive on every cold start.

MVP can accept this for allowlisted users, but production needs at least one of:

- Prebuilt images supplied by the user.
- Registry cache via BuildKit `cache-to` / `cache-from` keyed by devcontainer config hash.
- Image tar snapshots in R2, loaded on cold resume.
- A separate builder service that prebuilds devcontainer images for repo commits and pushes them to a registry.

Persist metadata:

- config path
- config hash
- remote workspace folder
- remote user
- image tag/build identifier
- last successful build timestamp
- whether lifecycle commands completed

On resume:

- Check outer repo exists; reclone if missing.
- Check Docker daemon and inner container exist.
- If missing, run `devcontainer up` again.
- Re-run `postStartCommand` and `postAttachCommand` semantics if supported.
- Start wrapper again.

### 10. Security and policy decisions

Devcontainers increase risk compared with current setup commands because arbitrary Dockerfiles and Features run during build/create. Policy should be explicit:

- Launch behind org/user allowlist first.
- Treat devcontainer build/lifecycle as untrusted user code.
- Do not inject Kilo or git tokens into image build by default.
- Reject unsafe mounts and privileged container settings.
- Redact secrets from devcontainer, Docker, and lifecycle logs.
- Enforce disk, CPU, memory, network, and wall-clock budgets.
- Label all inner Docker resources for cleanup.
- Decide whether user containers can run background services after agent completion.
- Consider outbound network policy if dependency install can hit arbitrary hosts.

## Phased Plan

### Phase 0: Spike

- Build a DIND-enabled cloud-agent sandbox image.
- Manually run a sample repo with `.devcontainer/devcontainer.json`.
- Verify `devcontainer up` works in Cloudflare Sandbox rootless Docker.
- Mount/copy the Kilo server bundle into the inner container.
- Start `kilo serve` inside the devcontainer.
- Keep wrapper in the outer sandbox and send one prompt through the existing worker flow to the inner Kilo server.
- Validate auto-commit still sees the same git checkout.

Exit criteria: one internal sample repo can run Kilo inside a devcontainer in staging.

### Phase 1: Allowlisted MVP

- Add API/metadata fields for devcontainer opt-in and config path.
- Implement `DevcontainerManager`.
- Add runtime abstraction and `DevcontainerRuntime`.
- Support single-container `image` and `build.dockerfile` devcontainers.
- Reject compose, privileged settings, and unsafe mounts.
- Add preparation progress and sanitized build logs.
- Recreate devcontainer on cold resume.
- Add wrapper and Kilo-server auth tokens where supported.

Exit criteria: allowlisted orgs can use repo-checked-in devcontainers with clear failures and no manual intervention.

### Phase 2: Performance

- Add image/cache keying by devcontainer config and repo revision.
- Support prebuilt image references as the recommended fast path.
- Add registry auth flow for private base images.
- Track build/cache metrics and cost.
- Add cleanup quotas for inner images/volumes.

Exit criteria: common devcontainers start fast enough for interactive use after first build.

### Phase 3: Broader spec support

- Add Docker Compose support if rootless DIND and host networking can support required cases.
- Support forwarded ports and preview URLs.
- Support named persistent volumes or package-manager caches.
- Support more lifecycle semantics and selected customizations.

Exit criteria: most common Codespaces-style repos work without custom Kilo setup commands.

### Phase 4: Production rollout

- UI for detecting/selecting devcontainer configs.
- Admin policy controls and billing/resource limits.
- Full observability and failure taxonomy.
- Documentation for supported and unsupported devcontainer features.
- Migration path from `setupCommands` to devcontainer lifecycle.

## Open Questions

- Should the default be auto-detect devcontainer config, or explicit opt-in per session?
- Is Docker Compose required for the first useful customer set?
- Do users need private registry credentials at launch?
- Should `kilo serve` run as `remoteUser`, `containerUser`, or a Kilo-managed user?
- Should we preserve `HOME=/home/<sessionId>` or use the devcontainer user's home?
- Can we ship a self-contained Kilo server bundle to avoid relying on Node/Bun/npm in user containers?
- How much cold-start time is acceptable for Dockerfile builds?
- Should cloud-agent `setupCommands` still run when a devcontainer is present, and if so before or after lifecycle commands?

## Recommendation

Start with a DIND-based, single-container, repo-config MVP behind an allowlist. The highest-leverage early work is the runtime abstraction plus a devcontainer manager. Once the wrapper can connect to an externally managed `kilo serve` process inside an arbitrary inner container and the current sandbox path still works unchanged, the rest of the work becomes mostly configuration coverage, caching, and hardening.

## Sandbox Test Notes

Tested from the current cloud-agent sandbox container on 2026-04-29:

- The current sandbox image has `kilo` 7.1.23, `node`, `npm`, and `bun`, but does not have `docker`; actual devcontainer/Docker-in-Docker testing requires a DIND-enabled sandbox image.
- `kilo serve --help` works from the installed CLI.
- Downloaded npm tarballs for `@kilocode/cli@7.1.23`, `@kilocode/cli-linux-x64@7.1.23`, and `@kilocode/cli-linux-x64-musl@7.1.23`.
- Built a test `/opt/kilo-agent`-style bundle under `/tmp` using the platform packages plus a launcher script.
- The direct x64 binary runs with a minimal `PATH=/usr/bin:/bin` that contains no `node`, `npm`, or `bun`; `kilo --version` and `kilo serve --help` both work.
- `kilo serve` starts successfully without Node/npm/Bun on PATH, creates its SQLite state under `$HOME/.local/share/kilo`, and listens on the requested host/port.
- Setting `KILO_SERVER_PASSWORD` enables Basic auth; `curl -u kilo:<password>` succeeds while unauthenticated requests get 401.
- The unpacked glibc + musl x64 bundle is about 418 MB because both platform packages include large binaries and source maps.
