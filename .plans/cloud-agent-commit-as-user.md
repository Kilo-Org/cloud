# Cloud Agent SCM credentials: catch-all outbound walking skeleton

## Goal

Deliver a reviewed managed-SCM containment walking skeleton for Cloud Agent sandboxes: use one catch-all outbound handler, preserve managed GitHub support with default-HTTPS LFS repository-control validation, add GitLab HTTPS support without host preregistration, and enable DIND only after proving nested routing and propagation of Cloudflare's private runtime HTTPS-interception CA/trusted bundle.

## Current State

- The walking skeleton is implemented, independently reviewed task by task, fixed where required, and locally validated.
- The walking skeleton is committed as `ab4fe320e`. The standalone `services/git-session-proxy` foundation is parked on the `quilled-meteoroid` worktree for possible later relay hardening; this active branch removes it and relies on Cloudflare outbound HTTP(S) interception rather than proxy-service wiring.
- Deployment order is mandatory: provision the SCM capability secret, deploy `git-token-service`, then deploy `cloud-agent-next`.

## Implemented Architecture

Eligible sandboxes use one HTTP(S) boundary:

```ts
Sandbox.outbound = handleManagedScmOutbound;
```

| Request class | Implemented behavior |
|---|---|
| Unmatched request | Pass through unchanged. |
| Recognized Kilo capability carrier | Redeem server-side; fail closed when invalid, including malformed whitespace/tab carrier cases. |
| Redeemed managed request | Replace sandbox-visible capability auth with redeemed provider auth outside the sandbox. |
| Redirect from redeemed request | Follow manually so managed auth is forwarded only after target validation. |
| Cross-provider or unsupported recognized carrier | Fail closed rather than falling back to raw forwarding. |

Provider-issued signed LFS action URLs and headers intentionally remain visible to the sandbox in this skeleton.

## Implemented Provider Coverage

| Surface | GitHub | GitLab |
|---|---|---|
| Capability | `kgh1.<opaque>` marker with one-hour encrypted claims. | `kgl1.<opaque>` marker with one-hour encrypted claims, separate GitLab purpose, and the shared encryption secret. |
| Origin | Existing GitHub origins. | `gitlab.com` and active self-managed standard HTTPS integration origins on port `443`. |
| Repository path | Exact GitHub repository validation. | Exact nested namespace project validation, for example `group/subgroup/project`. |
| Git smart HTTP | Repository-bound. | Repository-bound. |
| LFS control | Repository-bound `POST .../.git/info/lfs/objects/batch` and `POST .../.git/info/lfs/locks/verify`. | Repository-bound batch and lock verification. |
| CLI API | Existing broad `api.github.com` compatibility for `gh`. | Broad `/api/v4/**` and `/api/graphql` compatibility for `glab`. |
| Managed auth rewrite | Redeemed GitHub auth. | Basic, Bearer, and `PRIVATE-TOKEN` rewriting for managed OAuth/PAT auth. |
| Explicit profile token | Outside managed containment. | Pass through unchanged as intentional user-controlled auth. |

GitLab integration handling uses sanitized refresh logging and per-use database clients. Eligible GitLab session preparation emits a canonical `.git` remote URL, trusted `GITLAB_HOST`, and a capability-backed `GITLAB_TOKEN`; raw managed-auth fallback has been removed.

## Capability Marker Decision

| Provider | Capability marker |
|---|---|
| GitHub | `kgh1.<opaque>` |
| GitLab | `kgl1.<opaque>` |

The short prefix routes the provider codec, fails closed for unsupported formats, and versions the marker. It is not the security boundary: authenticated AES-GCM claims remain authoritative. The `kgh1.` / `kgl1.` rollout intentionally invalidates previously issued verbose-marker capabilities. Coordinate rollout in the required order - provision the SCM capability secret, deploy `git-token-service`, then deploy `cloud-agent-next` - or accept up to one hour of transient failures for in-flight old capabilities.

Fresh capabilities are issued on every dispatched message or command. Remotes and environment are refreshed before prompt delivery, so timer refresh is unnecessary for the skeleton. Only autonomous turns or terminal usage extending beyond one hour remain edge cases.

## DIND Result

The nested-DIND real-Git rewrite probe proved that `--network=host` supplies routing to the catch-all boundary and that nested devcontainers require propagation of Cloudflare's private runtime HTTPS-interception CA/trusted bundle.

`SandboxDIND` catch-all interception is enabled. Managed GitHub and GitLab DIND preparation/wrapper paths use capabilities. Devcontainer setup copies the outer trusted CA bundle to a stable session-home path and injects trust environment variables. This does not imply that provider certificates are the production issue or that the runtime interception certificate is necessarily self-signed. The local missing-bundle negative control empirically returned a TLS rejection matching `server certificate verification failed|SSL certificate problem|certificate verify failed|self-signed certificate in certificate chain`; preserve that as observed probe output rather than a production certificate diagnosis. Probes clean up invocation artifacts.

## Completion Record

| Gate | Status | Evidence |
|---|---|---|
| Task 1: catch-all and GitHub LFS | Complete, reviewed, fixed | Catch-all `Sandbox.outbound`; GitHub LFS batch and lock verification; fail-closed recognized carriers including whitespace/tab; signed actions remain sandbox-visible. |
| Task 2: GitLab token service | Complete, reviewed | One-hour GitLab codec/issue/redeem; active self-managed HTTPS origin; nested namespaces; Git/LFS repo control; broad `glab` REST/GraphQL; sanitized refresh logging; per-use DB clients. |
| Task 3: Cloud Agent GitLab | Complete, reviewed, fixed | Capability-backed canonical `.git` remotes, `GITLAB_TOKEN`, trusted `GITLAB_HOST`; Basic/Bearer/`PRIVATE-TOKEN` rewrites; no raw fallback; cross-provider and unsupported recognized carriers fail closed. |
| Capability markers | Approved | GitHub `kgh1.<opaque>`; GitLab `kgl1.<opaque>`; short routing/fail-closed/version prefix only; AES-GCM claims remain authoritative; dispatch refresh makes one-hour expiry a long-running edge case. |
| Task 4/4b: DIND | Complete, reviewed | Probe proved host-network routing and nested propagation of Cloudflare's private runtime HTTPS-interception CA/trusted bundle; `SandboxDIND` catch-all enabled; GitHub/GitLab DIND paths use capabilities; devcontainer trust injection and probe cleanup implemented. |
| Final validation | Complete | Token service `102` tests; Cloud Agent `1545` passed, `3` skipped; changed-package typecheck `10/53`; both probes passed; whitespace clean; no review blockers remain. |

## Validation Caveat

Full Cloud Agent wrapper validation encountered an unchanged committed baseline timing-sensitive flake in `wrapper/src/lifecycle.test.ts`: `clears aborted state when activity cancels an aborted drain`. Its fixed `50 ms` wait races a real branch subprocess. Marker-focused and package checks pass. Track wrapper test stabilization separately rather than bundling it into the SCM diff.

## Containment Claims

| Path | Skeleton claim |
|---|---|
| Managed GitHub, eligible sandbox including DIND | Contained for recognized capability-bearing smart HTTP, broad `gh` API, and repository-bound LFS control requests. |
| Managed GitLab OAuth/PAT, eligible sandbox including DIND | Contained for recognized capability-bearing smart HTTP, broad `glab` API, and repository-bound LFS control requests on claimed standard HTTPS origins. |
| Provider-issued signed LFS actions | Not contained; action URLs and provider headers remain sandbox-visible. |
| Explicit profile tokens | Not contained; intentional pass-through. |

## Follow-up Discussions

These are explicit follow-ups, not blockers for this walking skeleton:

| Area | Follow-up |
|---|---|
| Provider-signed LFS actions | Use the standalone relay parked on `quilled-meteoroid` later if a stronger boundary is required. |
| Self-managed GitLab origins | Add SSRF hardening and admin allowlisting for active-integration approval. |
| GitLab instance shape | Discuss nonstandard ports and subpath-hosted instances. |
| GitLab token semantics | Resolve project-access-token semantics discrepancy. |
| GitLab OAuth | Add refresh concurrency handling and provision default GitLab OAuth client environment values. |
| Capability continuity | Add refresh within long-running autonomous turns or terminal sessions that outlive the one-hour capability lifetime; dispatched messages and commands already refresh remotes and environment before prompt delivery. |
| Wrapper test stability | Stabilize the unchanged baseline timing-sensitive lifecycle test separately from the SCM diff. |
| Capability carriers | Harden query/body carrier handling. |
| Nested trust | Cover propagation of Cloudflare's private runtime HTTPS-interception CA/trusted bundle into Dockerfile build stages, unusual custom images/trust stores, CA rotation, and non-host nested networks. |
| Cleanup behavior | Cover abrupt cleanup. The stale `dev/local` standalone proxy WIP is isolated on `quilled-meteoroid`. |
