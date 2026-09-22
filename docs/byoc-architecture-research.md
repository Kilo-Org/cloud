# BYOC (Bring Your Own Cloud) Architecture for Cloud Agent Next

**Author:** Kilo Agent
**Date:** August 2026
**Status:** Proposal / Research — rewritten against the `sticky-slider` call-home control plane
**Target Service:** `services/cloud-agent-next`
**Canonical control-plane spec:** `sticky-slider` worktree, `CALL-HOME-CONTROL-PLANE.md`

---

## 1. Executive Summary

BYOC for `cloud-agent-next` is not a family of per-vendor sandbox adapters talking inbound HTTP to a wrapper. That model is being replaced.

The control plane under construction in `sticky-slider` is:

- one owner-scoped logical sandbox;
- one `SandboxControl` Durable Object;
- one wrapper process and one shared Kilo backend;
- one outbound WebSocket from the wrapper to `SandboxControl`;
- many concurrent Cloud Agent sessions on that sandbox;
- provider adapters that only create, observe, stop, extend a lease, and fetch logs.

That remains the density target. The first customer-paid Vercel MVP is a
deliberate exception: it uses one isolated `ses-*` sandbox per session. This
avoids repinning an existing shared `SandboxControl` across Cloudflare,
Kilo-paid Vercel, and customer-paid Vercel. The implementation plan is the
authoritative source for Stage 1 behavior.

BYOC is then a choice of **who pays for and where the physical instance runs**. E2B, Modal, Vercel, a customer VPC runner, and Cloudflare Containers all speak the same call-home protocol. They differ only in the five provider operations and whether a stopped instance is resumable.

**Do not** implement `E2BAgentSandbox` against today's `AgentSandbox` / file-hop / inbound-wrapper protocol. **Do not** treat an enterprise outbound runner as a later, separate architecture. Both land on `SandboxControl` after that plane exists.

**Do not** take ComputeSDK as a runtime dependency. That verdict is unchanged.

---

## 2. What changed since the first draft

The first draft of this document (early August 2026) treated `sticky-slider`'s Vercel work as a realized multi-backend prototype: thin REST clients, pre-baked snapshots, and `VercelWrapperTransport` (file write → `curl` → file read) because Workers cannot open TCP into a Vercel microVM.

That prototype proved two useful things and one thing we should not copy:

| Keep | Drop |
|---|---|
| Worker-native `fetch` REST clients, no Node SDKs | File-hop as a control transport |
| Pre-baked snapshots / templates with Bun + wrapper + CLI | Per-session `AgentSandbox` as the BYOC seam |
| Two-phase create intents and stop tombstones | Inbound wrapper HTTP / PTY as the control path |
| Encrypted customer credentials | `wrapperRunId` / generation fences as session identity |

`sticky-slider` then replaced the control path. As of 2026-08-25:

- Architecture decisions in `CALL-HOME-CONTROL-PLANE.md` are implemented on the
  latest local `sticky-slider`; production enrollment remains off.
- A real Vercel snapshot VM completed authenticated WSS hello, status, drop,
  and reconnect against `SandboxControl`. Outbound WSS is proven.
- Protocol schemas, opaque sandbox credentials, hibernating sockets,
  hello-replace, physical lifecycle, session integration, idle stop, and the
  five-op provider adapter exist.
- There is no transport migration or file-hop compatibility path. Dual transport is forbidden.

The rest of this document is written against that target, not against today's production session DO.

---

## 3. Target architecture

This is the eventual shared-sandbox target, not the customer Vercel Stage 1
topology. Stage 1 creates one `SandboxControl` and sandbox per session.

```text
                         Cloudflare

   browser A ── WS ──► Session A DO ─┐
   browser B ── WS ──► Session B DO ─┼─ typed DO RPC ─► SandboxControl DO
   browser C ── WS ──► Session C DO ─┘                      ║
                                                             ║ one outbound WS
                                                             ║
                                                      wrapper control plane
                                                             │
                                                  one shared Kilo backend
                                                             │
                                            directory A / B / C + Kilo sessions
```

### 3.1 Ownership

| Owner | Owns | Does not own |
|---|---|---|
| **Session DO** (`sessionId`) | Auth, chat, messages, idempotency, client streams, per-message no-progress deadline | Wrapper socket, provider API, physical health, idle stop |
| **`SandboxControl` DO** (`sandboxId`) | Physical start/observe/stop, credential, the one wrapper socket, heartbeats, capacity, idle shutdown, session routing, every sandbox-lifetime deadline | Prompts, chat history, message terminalization |
| **Wrapper** | One Kilo backend, global event feed, explicit directory + `kiloSessionId` on every call, reconnect | User authorization, Cloud message queues |
| **Provider adapter** | `create`, `observe`, `stop`, `ensureLeaseAtLeast`, `logs`, plus a `resumable` bit | States, deadlines, intents, tombstones, timeout semantics |

Rule: Session DOs decide what should happen. `SandboxControl` decides how to reach and operate the sandbox.

### 3.2 Provider boundary

Providers have incompatible native timeout models. One sleeps a container; another gives a total duration and destroys the machine. Neither model may appear in the state machine.

A provider adapter supplies exactly five operations:

| Operation | Contract |
|---|---|
| `create(intent)` | Start an instance for a durable intent that already exists. May return an instance id, or report unresolved. |
| `observe(ref)` | Report `active`, `terminal`, or **`unknown`**. A boolean is not sufficient. |
| `stop(ref)` | Attempt a stop; report terminal or retryable. |
| `ensureLeaseAtLeast(ms)` | Guarantee at least `ms` of remaining provider lifetime. How (activity ping vs duration extend) is private to the adapter. |
| `logs(ref)` | Best-effort diagnostics for a failing instance. |

One capability bit: whether a stopped instance is **resumable**. Durable records carry an opaque `providerRef` that only the adapter parses.

The create intent is persisted **before** the create call. The instance reference is cleared only **after** the provider confirms terminal. Those two asymmetries are the anti-leak guarantee, and they live in `SandboxControl`, not in each adapter.

### 3.3 Network

The wrapper WebSocket is the only interactive network path between the sandbox and the Cloud control plane:

```text
GET /sandbox-control/{sandboxId}
Upgrade: websocket
Authorization: Bearer <opaque sandbox credential>
```

Bulk artifacts (snapshots, attachments, logs) may use scoped HTTP object-storage URLs. They are data transfer, not a second control transport.

This is the property BYOC actually needs:

- Cloudflare Workers never open inbound TCP/HTTP into the customer's compute.
- Customer VPCs never open inbound ports. The wrapper dials out on 443.
- Interactive PTY, if added later, is typed binary frames on the same socket (or a second socket only if measurement demands it). It is not a public wrapper port.

### 3.4 Identity

Durable: `sandboxId` (logical, survives physical replacement), `sessionId`, `kiloSessionId`, `messageId`, `providerInstanceId` (internal to `SandboxControl`).

Removed: `wrapperId`, `wrapperRunId`, `wrapperGeneration`, `wrapperConnectionId`, transport-mode flags.

The sandbox credential is an opaque 256-bit capability for one logical sandbox's wrapper connection. It is not a Kilo JWT or a per-session dispatch ticket. Physical replacement rotates it.

### 3.5 Sharing model

One sandbox never mixes owners. All sessions in a sandbox use the same Kilo credentials. Session-varying repository, tool, and workspace inputs are passed explicitly or stored under that session's directory, never installed by mutating shared `process.env`.

This is the VS Code extension model (one `kilo serve`, many worktrees) with Cloud-side owner and authorization boundaries. Resource contention in one Kilo process is a measured risk, not a reason to start with per-session processes.

---

## 4. What the first draft got right

These still hold.

**Control plane vs compute plane.** Cloudflare Worker + Durable Objects own auth, transcripts, event ordering, billing, and UI streaming. Customer compute owns checkout, tools, compilers, tests, and the local Kilo runtime.

**Outbound ingest / call-home is the enterprise requirement.** Zero inbound firewall openings in the customer VPC.

**Do not use ComputeSDK as a runtime dependency.** It models sandboxes as ephemeral command runners, imports Node built-ins that fail in Workers, has no PTY or durable lifecycle, and would fight `kilocode-wrapper.js` with a second daemon. Use it only as a catalog of vendor REST endpoints and auth header names.

**Encrypted customer credentials.** Provider keys are stored encrypted and
decrypted only by the control-plane worker that needs them. Customer Vercel
Stage 1 reuses the existing `AGENT_ENV_VARS` RSA pair and does not support key
rotation. Credentials are never logged.

**Thin native REST clients.** When a provider needs a control API (create/stop/extend), implement it with Web `fetch` in the Worker, the way `sticky-slider` talks to Vercel. Do not pull vendor Node SDKs into the isolate.

**Standardized image / snapshot.** Publish `ghcr.io/kilocode/agent-sandbox` and pre-baked templates so every provider boots the same wrapper. The wrapper always calls home; the image does not grow a per-provider control server.

---

## 5. What the first draft got wrong

| First draft | Target |
|---|---|
| Phase 1 = `E2BAgentSandbox` implementing `AgentSandbox` (`ensureWrapper`, HTTP RPC, PTY) | Phase 1 = finish `SandboxControl`. A provider is the five operations in §3.2. |
| Copy `VercelWrapperTransport` file-hop for providers without inbound TCP | There is no file-hop, dual transport, or inbound wrapper HTTP. |
| One Cloud session → one VM as the universal target | One owner sandbox → many chats is the eventual density model. Customer Vercel Stage 1 intentionally starts per-session. |
| Enterprise runner (`kilocode-runner`) is Phase 2 architecture | Same protocol as E2B/Vercel. The runner is a provider that the customer operates. |
| `CloudAgentSession` DO remains the coordinator of compute | Session DO owns the chat. `SandboxControl` owns compute. |
| Interactive PTY is a native provider feature required for MVP | Terminal is explicitly out of v1. Add later as typed frames on the call-home socket. |
| Implementation effort estimated in "adapter weeks" against today's protocol | Calendar is gated on sticky-slider slices 5–8, then a thin adapter. |

The existing `AgentSandbox` / `AgentSandboxLifecycle` types remain the production Cloudflare/Vercel seam until call-home ships. They are not the BYOC extension point.

---

## 6. BYOC deployment models (revised)

The four customer-facing models are unchanged. The implementation of each is now "adapter + call-home", not "new control plane".

### 6.1 Keyed cloud microVMs (E2B / Modal / Vercel)

User pastes an API key. `SandboxControl` calls the vendor REST API, injects the opaque sandbox credential and call-home URL, boots from the pre-baked template. Wrapper dials `/sandbox-control/{sandboxId}`.

- Lowest setup friction.
- Fast cold start (sub-second to a few seconds).
- Compute is still on the vendor's SaaS, not in the customer's VPC.
- Vercel is already the first physical host of this model in `sticky-slider`, and the easiest **customer-keyed** MVP: org-stored token + team + project, BYOC setup copies/builds the snapshot into their project, then the same adapter creates sandboxes they pay for. E2B is a later second adapter, not the first BYOC slice.

### 6.2 Major-cloud serverless containers (ECS / ACA / Cloud Run)

Customer provides IAM. Worker starts a task from `ghcr.io/kilocode/agent-sandbox`. Wrapper still dials out.

- Satisfies "run in our AWS/GCP/Azure account".
- Cold starts are worse (especially ECS Fargate).
- The first draft's "inbound HTTP RPC needs a public IP or reverse tunnel" problem **disappears**. Call-home removed that requirement.

### 6.3 Self-hosted Docker host

A small daemon next to `docker.sock` accepts create/stop from… nowhere inbound. Either:

- the daemon is itself a `kilocode-runner` that already has an outbound socket, and it starts sibling containers; or
- we do not support raw Docker daemon exposure.

Do not expose Docker over the internet. The Roomote local-Docker pattern is only acceptable behind the outbound runner.

### 6.4 Enterprise outbound runner (`kilocode-runner`)

Customer installs a Helm chart / binary. The runner maintains an outbound connection to Kilocode Cloud, receives create intents, starts pods, injects the sandbox credential, and lets each wrapper open its own call-home WebSocket (or brokers that socket).

- 100% data/compute sovereignty, zero inbound ports, private LLMs.
- This is not a second protocol. It is a provider whose `create`/`observe`/`stop` happen inside the customer's cluster instead of via a public SaaS API.
- Higher customer DevOps cost; implement after keyed microVMs, not instead of `SandboxControl`.

---

## 7. Comparison

| Criteria | Keyed microVMs | Cloud serverless | Docker host via runner | Enterprise runner |
|---|---|---|---|---|
| Audience | Pro users, startups | Mid-market cloud orgs | Homelabs | Regulated enterprises |
| Setup | Paste API key | IAM / VPC | Helm or daemon + Docker | Helm |
| Cold start | Sub-second–2s | 1s–30s | 1s–3s | 2s–5s warm |
| Inbound firewall | None | **None** (call-home) | None (via runner) | None |
| Data sovereignty | Vendor SaaS | Customer cloud account | Local machine | Customer VPC / on-prem |
| PTY in v1 | Out of scope for all | Out of scope | Out of scope | Out of scope |
| Adapter size once call-home exists | Small REST client | Small REST / IAM client | Runner process | Runner process |
| Depends on | `SandboxControl` shipping | Same | Same + runner | Same + runner |

---

## 8. Recommended plan

### Stage 0 — Call-home control plane (`sticky-slider`, implemented; enrollment off)

This remains the required base. Do not start a BYOC provider against the old seam.

The landed base includes:

1. `SandboxControl` physical lifecycle, `providerRef`, attached-session routes,
   one-alarm deadline table, status projection, and transition log.
2. Shared wrapper call-home client and one `kilo serve` across directories.
3. Session DO integration, idle stop/replacement/lazy restore, and the normalized
   five-operation provider adapter.

Kilo-side `submitOrGet` / live `importOrGetSession` live in kilo-cli and are out of this repo. Do not fake them in the wrapper.

Production enrollment stays off while the lifecycle billing-safety fixes and
customer Vercel provider spike in the implementation plan are completed.

### Stage 1 — First keyed BYOC provider (customer Vercel)

Only after Stage 0's provider adapter exists. Do not start E2B first.

Customer Vercel is BYOC: they bring a token for a team they already pay. The REST client, snapshot pipeline, and outbound WSS path already exist. The MVP is credential routing plus one setup step, not a new provider.

1. Org setting: encrypted `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` (not worker env).
2. **BYOC setup** (required, once per org / when the runtime image changes): using those credentials, copy or build the Kilo wrapper snapshot into **their** project. Persist the resulting `snapshotId` + `runtimeBuildId` with the org record. Reuse `scripts/vercel-snapshot.ts`; do not assume Kilo's `snap_*` is valid on their token.
3. Same five-op Vercel adapter. Creates boot from the org's snapshot. `SandboxControl` does not grow a Vercel state machine.
4. Wrapper only calls home. No public wrapper port.
5. Prove: setup writes a snapshot in the customer project; two sessions create
   two distinct customer-paid `ses-*` sandboxes; idle stop and reconciliation
   work; removing the credential makes subsequent control fail closed.

E2B/Modal are the same adapter shape later if we want a one-key UX or a non-Vercel vendor. They are not the MVP.

### Stage 2 — Enterprise runner

Same five operations, executed by a customer-deployed runner instead of a SaaS API.

1. Runner registers, authenticates, receives create intents over its outbound connection.
2. Starts a pod/container from the standard image, injects sandbox credential + call-home URL.
3. Wrapper opens `/sandbox-control/{sandboxId}` as in Stage 1.
4. Optional: runner brokers the socket if the pod cannot reach Kilocode directly (air-gap with an HTTP proxy is enough; a second custom protocol is not).

### Explicitly not in the plan

- ComputeSDK as a dependency.
- File-hop or inbound wrapper HTTP for any new provider.
- Per-session VMs as the eventual default across all BYOC providers. Customer
  Vercel Stage 1 uses them as a bounded MVP exception.
- PTY multiplexing in the first BYOC slice.
- Automatic multi-sandbox scheduling under load.
- Owner-scoped leak sweep (`listForOwner`) until a provider exposes it cheaply; residual leaks stay manual.

---

## 9. Files that would change for Stage 1 (after call-home)

These paths are relative to the call-home tree, not to today's production `AgentSandbox` layout.

- `services/cloud-agent-next/src/sandbox-control/` — unchanged state machine; Vercel adapter behind the provider boundary, credentials from the org record.
- `packages/db/src/schema.ts` — encrypted org Vercel credentials (token, team, project) plus the org's `snapshotId` / `runtimeBuildId` from setup.
- `apps/web` org settings — token + team + project, then a setup action that copies/builds the snapshot into their project.
- Snapshot pipeline (`scripts/vercel-snapshot.ts`) — runnable with the org's token against the org's project as part of BYOC setup.

Do **not** add `src/agent-sandbox/e2b/e2b-agent-sandbox.ts`. Do **not** add a second Vercel client.

---

## 10. Residual risks specific to BYOC

| Risk | Treatment |
|---|---|
| Building E2B against the old `AgentSandbox` seam | Wait for Stage 0. The seam is being deleted. |
| Customer key used to create instances we then lose track of | Create intent before create call; `observe` is three-valued; `unknown` pages a human. Owner sweep is later. |
| Sharing one Kilo across an org's chats | Owner boundary is mandatory. Measure crash blast radius before promising density. |
| Provider `observe` that only has running/not-running | Refuse that adapter until it can return `unknown`. A failed lookup must not become `stopped`. |
| Snapshot/template drift per vendor | One wrapper contract (call-home URL + credential + loopback-only listen). Vendor images only differ in how they boot. |
| Customer Vercel cannot use Kilo's snapshot ID | BYOC setup always copies or builds the snapshot into their project and stores that id. |
| Credential in snapshot or logs | Inject at instance create, never bake into the template. Header-only on the WebSocket. |

---

## 11. Success criteria for BYOC

The control-plane criteria in `CALL-HOME-CONTROL-PLANE.md` §17 plus:

- BYOC setup copies or builds the wrapper snapshot into the customer's Vercel project;
- a customer-supplied Vercel token then starts a sandbox they pay for that only calls home;
- two sessions for that owner create distinct `ses-*` sandboxes for Stage 1;
- idle stop and replacement work without vendor-specific timeout branches;
- an enterprise runner can be described as "the same adapter, different `create` implementation" without a new protocol.
