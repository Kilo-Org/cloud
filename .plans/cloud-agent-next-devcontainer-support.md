# Cloud Agent Next Dev Container Support Brainstorm

## Goal

Allow a cloud-agent-next session to use a user-provided dev container as the execution environment, so the Kilo server and agent loop run with the repository's declared OS packages, language runtimes, tools, and dependency setup.

The safest practical path is to keep the existing Cloudflare Sandbox as an outer control plane, run Docker-in-Docker inside it, create the user's dev container as an inner container, and start the cloud-agent wrapper plus Kilo server inside that inner container.

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
4. Tool injection: mount or copy a Kilo tool bundle into the inner dev container.
5. Wrapper execution: start `kilocode-wrapper` inside the inner dev container, with `WORKSPACE_PATH` set to the devcontainer `remoteWorkspaceFolder`.
6. Prompt execution: keep worker -> wrapper HTTP flow, but execute the HTTP calls from the outer sandbox against the wrapper port exposed through host networking.

This keeps Kilo's file tools, shell commands, MCP local processes, and package managers inside the same environment the user intended.

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

Today code assumes `ExecutionSession` from `@cloudflare/sandbox`. Devcontainers need an adapter because commands, processes, and wrapper discovery must happen inside the inner container.

Add something like:

```ts
type WorkspaceRuntime = {
  kind: 'sandbox' | 'devcontainer';
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  startProcess(command: string, options?: StartProcessOptions): Promise<ProcessHandle>;
  writeFile(path: string, content: string): Promise<void>;
  resolveWorkspacePath(hostPath: string): string;
  findWrapper(agentSessionId: string): Promise<{ port: number } | null>;
  stopWrapper(agentSessionId: string): Promise<void>;
};
```

Implementations:

- `SandboxRuntime`: wraps the current Cloudflare sandbox session; behavior stays unchanged.
- `DevcontainerRuntime`: executes via `docker exec` or `devcontainer exec` into the inner container; maps outer workspace path to `remoteWorkspaceFolder`; scans inner container processes for wrapper markers.

Then update:

- `WrapperClient` to depend on the runtime instead of directly on `ExecutionSession` and `SandboxInstance`.
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

### 5. Inject Kilo tooling into arbitrary containers

The inner devcontainer cannot be assumed to have Bun, Node, npm, or Kilo installed.

Options:

1. Compile the wrapper into a standalone Linux binary and copy/mount it into the devcontainer.
2. Build a small Kilo devcontainer Feature that installs Bun plus the wrapper/CLI.
3. Mount a read-only `/opt/kilo-agent` bundle from the outer sandbox and run it from there.

Best MVP path: standalone wrapper or mounted tool bundle. Avoid relying on the user's package manager.

The wrapper still can use `createKilo()` internally. If product language requires "kilo serve", the wrapper can later be changed to spawn `kilo serve` as a subprocess inside the devcontainer, but the important architectural point is that the Kilo server process must live inside the user's devcontainer.

### 6. Handle environment, auth, and home directory

Current session setup injects `HOME=/home/<sessionId>`, writes auth to `<HOME>/.local/share/kilo/auth.json`, and writes global rules to `<HOME>/.kilocode/rules/cloud-agent.md`.

Devcontainer support needs to decide between two models:

- Preserve cloud-agent HOME: run wrapper and agent commands with `HOME=/home/<sessionId>` inside the devcontainer, mounted from the outer sandbox.
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
10. start wrapper inside the devcontainer
11. persist devcontainer metadata in the session DO

Add preparation progress steps such as:

- `devcontainer_config`
- `devcontainer_build`
- `devcontainer_start`
- `devcontainer_lifecycle`

### 8. Rework wrapper networking and security

Because DIND requires host networking for reliable connectivity, the wrapper port will be reachable from other processes in the outer sandbox and probably from the inner user container.

Hardening to add before broad rollout:

- Require a random wrapper auth token on all wrapper HTTP requests.
- Keep wrapper bound to `127.0.0.1` when possible.
- Allocate ports from a controlled range and record them in metadata.
- Make wrapper discovery work via inner `docker exec pgrep` plus labels, not only outer `sandbox.listProcesses()`.
- Stop wrappers and inner containers during idle cleanup and session deletion.

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
- Mount/copy the wrapper into the inner container.
- Start wrapper inside the devcontainer and send one prompt through the existing worker flow.
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
- Add wrapper auth token.

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
- Should wrapper/Kilo run as `remoteUser`, `containerUser`, or a Kilo-managed user?
- Should we preserve `HOME=/home/<sessionId>` or use the devcontainer user's home?
- Can we ship a standalone wrapper binary to avoid relying on Bun in user containers?
- How much cold-start time is acceptable for Dockerfile builds?
- Should cloud-agent `setupCommands` still run when a devcontainer is present, and if so before or after lifecycle commands?

## Recommendation

Start with a DIND-based, single-container, repo-config MVP behind an allowlist. The highest-leverage early work is the runtime abstraction plus a devcontainer manager. Once the wrapper can run inside an arbitrary inner container and the current sandbox path still works unchanged, the rest of the work becomes mostly configuration coverage, caching, and hardening.
