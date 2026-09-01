# Cloud Agent Local Debugging

Use this guide when a local Cloud Agent flow stalls, a sandbox behaves unexpectedly, or the browser UI does not match the worker state. The goal is to correlate one session across the Worker log, the sandbox container, the wrapper log file, and Kilo CLI logs.

## Log Locations

- Worker, Durable Object, router, queue, stream, ingest, callback, and wrapper-client logs are emitted by Wrangler and normally land in `dev/logs/cloud-agent-next.log`.
- The wrapper runs inside the sandbox container. Its durable debug log is written to `/tmp/kilocode-wrapper-<agentSessionId>-<timestamp>.log` via `WRAPPER_LOG_PATH`.
- Kilo CLI logs inside the sandbox live under `/home/<agentSessionId>/.local/share/kilo/log/*.log`.
- After `/session/ready` binds a wrapper session, the wrapper uploads a tarball containing the wrapper log plus Kilo CLI logs roughly every 30 seconds. Wrangler shows matching `PUT /sessions/.../logs/session/logs.tar.gz` traffic.
- `restore-session` logs print to wrapper stderr and are also mirrored into the wrapper log file, so import/restore traces survive sandbox-side debugging.

## First Triage

1. Capture the user-visible Kilo session ID (`ses_*`) and, if available, the Cloud Agent session ID (`agent_*`).
2. Search the Worker log for the ID and walk forward from preparation or queue acknowledgement. If you only have `ses_*`, capture the associated `agent_*` from that log block; use it for sandbox lookup.
3. If the Worker shows wrapper handoff or `/session/ready`, inspect the sandbox wrapper log immediately.
4. If the wrapper reports Kilo server/session issues, inspect the Kilo CLI log in the same container.

Useful Worker-log landmarks include:

- `Queueing cloud-agent message through Durable Object`
- `Queued message event persisted and pending flush scheduled`
- `Pending session message flush attempt starting`
- `AgentRuntime delivering pending message to wrapper`
- `ExecutionOrchestrator starting execution`
- `Workspace warmth probe completed`
- `Wrapper session readiness completed`
- `Wrapper ingest WebSocket accepted`
- `Client stream WebSocket accepted for setup`
- `Session message terminalized`

## Worker Logs

From the repo root:

```bash
# Inspect local Worker / DO / Wrangler logs.
# Use Read or Grep tooling when working as an agent; this shell example is for humans.
tail -f dev/logs/cloud-agent-next.log
```

Common correlations:

- `ses_*` appears in prepare/import/session logs.
- `agent_*` appears in Worker routing, WebSocket, sandbox, and callback logs.
- `msg_*` is the durable message identity to follow across queueing, flush, wrapper delivery, and terminalization.

When a session stalls, look for this sequence:

1. Queue acknowledgement.
2. Pending flush start.
3. Wrapper handoff / bootstrap.
4. Wrapper ingest connection.
5. Kilo events and terminalization.

A gap between two adjacent stages usually identifies the subsystem to inspect next.

## Find the Sandbox Container

List local sandbox containers and their proxy siblings:

```bash
docker ps --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}}'
```

Cloudflare sandbox containers usually include `Sandbox` in the synthesized name or use a `cloudflare/sandbox` image. There may be a sibling `-proxy` container. Docker container names are synthesized, so when several sandboxes are running, confirm the primary container by finding `/tmp/kilocode-wrapper-<agentSessionId>-*.log` for the `agent_*` recovered from the Worker log.

To inspect one candidate:

```bash
docker exec <container-id> ls /tmp
```

To match one candidate to a specific Cloud Agent session:

```bash
docker exec <container-id> sh -c 'ls /tmp/kilocode-wrapper-<agentSessionId>-*.log 2>/dev/null'
```

To terminate that local sandbox, kill the matched primary container and its `-proxy` sibling when present, then re-list containers to confirm both disappeared:

```bash
docker kill <primary-container-id> <proxy-container-id>
docker ps --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}}'
```

## Read Wrapper Logs Inside the Sandbox

The wrapper writes one or more log files under `/tmp`:

```bash
docker exec <container-id> sh -c 'ls -t /tmp/kilocode-wrapper-*.log 2>/dev/null'
docker exec <container-id> sh -c 'ls -t /tmp/kilocode-wrapper-*.log 2>/dev/null | head -n 1 | xargs -r cat'
```

High-value wrapper landmarks:

- `session/ready received`
- `bootstrap workspace plan`
- `bootstrap fresh session using empty import`
- `bootstrap snapshot restore starting`
- `restore-session: snapshot metadata validated`
- `restore-session: kilo import finished`
- `post-bootstrap kilo session lookup begin`
- `post-bootstrap kilo session lookup end`
- `session/ready complete`
- `ingest WS connected`
- `sending complete event`

For stuck import/debugging, confirm all of these:

- import input source (`provided` vs `downloaded`)
- expected Kilo session ID vs snapshot `info.id`
- import exit code
- `HOME` and workspace path used by import
- post-import `getSession()` result

## Read Kilo CLI Logs Inside the Sandbox

```bash
docker exec <container-id> sh -c 'ls -t /home/agent_*/.local/share/kilo/log/*.log 2>/dev/null'
docker exec <container-id> sh -c 'ls -t /home/agent_*/.local/share/kilo/log/*.log 2>/dev/null | head -n 1 | xargs -r cat'
```

Use Kilo CLI logs when:

- the wrapper reached Kilo runtime startup but no useful Kilo events arrive
- session import succeeded but Kilo lookup or job startup behaves unexpectedly
- model/provider/plugin behavior needs confirmation

## Wrapper Process Stdout/Stderr

Some failures occur before the wrapper log file becomes useful. The sandbox process list and per-process artifacts can help:

```bash
docker exec <container-id> ps -eo pid,args
docker exec <container-id> ls /tmp/session-*
```

Cloudflare sandbox session directories often contain process stdout/stderr artifacts such as `proc_*.log`. Copy or inspect those when wrapper startup fails before normal ingestion begins.

## Copy Sandbox Logs Locally

For longer inspection, copy logs out of the container:

```bash
docker cp <container-id>:/tmp/kilocode-wrapper-<agentSessionId>-<timestamp>.log /tmp/cloud-agent-wrapper.log
```

Kilo database or WAL files can also be copied when investigating persistence visibility, but do this only for local debugging and avoid treating copied state as authoritative after the container continues running.

## Uploaded Log Archives

Once the wrapper binds, it uploads:

```text
/sessions/<userId>/<agentSessionId>/logs/session/logs.tar.gz
```

Wrangler will show the `PUT` requests. The uploaded archive contains:

- the wrapper log file configured by `WRAPPER_LOG_PATH`
- the Kilo CLI log directory for the sandbox session

The internal `getWrapperLogs` path also discovers these sandbox-side files directly by scanning `/tmp/kilocode-wrapper-*.log` and the Kilo CLI log directory.

## Control-plane Diagnostics

Control-plane (`workspace_*`) sessions use verbose structured wrapper diagnostics, not the legacy raw wrapper/Kilo tarball. Records include heartbeat attempts, feed freshness, control socket and request outcomes, event-send metadata, task phases, and retirement causes. They exclude prompts, assistant/tool content, raw errors, credentials, and URLs.

The wrapper uploads JSON batches to the existing R2 bucket every five seconds and when a batch fills. Shutdown attempts a final flush within the existing shutdown deadline. R2 keys are:

```text
logs/control/<sandboxId>/<allocationId>/<wrapperInstanceId>/<batchId>.json
```

`sandboxId` is the logical SandboxControl ID, not the `workspace_*` session ID or physical provider allocation name. Use Worker logs to correlate these IDs. Each allocation/wrapper has separate immutable batches; sort them by the batch `sequence` and record `timestamp`, not the random batch ID. Check `droppedRecords` and `droppedTerminalRecords` for buffer overflow or rejected diagnostic records.

Internal API authentication is required to list or download these archives:

```text
GET /internal/sandbox-logs/<sandboxId>?cursor=<optional-cursor>
GET /internal/sandbox-logs/<sandboxId>/<allocationId>/<wrapperInstanceId>/<batchId>
```

Listing returns at most 100 objects and a continuation cursor. Download paths omit the `.json` suffix. These reads use R2 only and work after the container disappears. The legacy `getWrapperLogs` live-file reader and tarball retrieval do not read these JSON archives.

Worker/DO diagnostics remain in Cloudflare logs/Axiom, not these wrapper archives. Upload result markers on wrapper stderr distinguish HTTP rejection, network failure, timeout, and acceptance. An upload-only grant expires four hours after allocation launch and is not renewed; runtime credential revocation does not revoke it. Grant expiry does not delete archives. R2 retention remains governed by external bucket policy, not the session/report cleanup jobs.

Uploads are best effort: an abrupt kill or network failure can lose unuploaded records. The buffer holds 512 records and each batch holds up to 128 records or 256 KiB. A recorded WebSocket send is a local handoff, not proof that a session DO applied the event; correlate it with the Worker forwarding and durable message-transition logs.

### Shared-worktree Lifecycle

`worktreeId` identifies the shared checkout and chat group; `sessionId` is the Cloud Agent chat ID and `kiloSessionId` is the Kilo session ID. Worker `worktree_chat_*` events cover admission, progress, reconciliation, settlement, and the result, correlating the source and resulting chats with the existing worktree. Their durations are phase-local; a reconciliation-pending result describes required recovery, while the separate reconciliation and settlement records report persistence outcomes. Wrapper attachment does not receive an explicit worktree ID, so join its chat IDs with Worker records rather than treating a credential `scopeId` or directory as the worktree identity.

Worker `worktree_ownership` records distinguish `exclusive`, `shared`, and `unresolved` decisions and identify the evidence used. Unresolved ownership is not proof of sharing or permission to destroy a sandbox. `worktree_runtime_cleanup` records the cleanup strategy, failure stage, and confirmed journal flags. `worktree_cleanup_location` confirms resources cleaned at one runtime location; it is not overall deletion completion. Only `worktree_deletion` with `result=completed` or `result=replayed` confirms the complete deletion request.

Wrapper `control.request` attachment summaries separate `workspaceAction` (reuse or bootstrap) from `sessionResolution` (existing, restored, or created chat). Worktree deletion records include the first fence/drain, preparation/deletion outcome, stage, and session count. These records contain IDs and fixed outcomes, not repository paths, credentials, or session content.

## Interpreting Common States

- Worker queueing succeeds, but no wrapper logs appear:
  - inspect pending flush scheduling, sandbox creation, and wrapper startup logs in `dev/logs/cloud-agent-next.log`.
- Worker log shows `Failed to issue Kilo session capability` / `Worker "git-token-service-dev" not found`:
  - the `GIT_TOKEN_SERVICE` service binding did not resolve. This fails before
    any wrapper or sandbox work, so no wrapper log or fake-LLM traffic exists.
    Check `.wrangler/dev-registry/` for a missing `git-token-service-dev`
    entry; if absent, `pnpm dev:restart cloudflare-git-token-service` and
    confirm it reappears before retrying the turn.
- Turn stalls in `preparing` (repeats several times, no kilo events, no
  fake-LLM traffic):
  - the wrapper inside the sandbox is failing to start. Look for
    `Reconciling physical wrapper stop … reason: 'startup-failed'`,
    `ContainerControlConnection upgrade returned retryable status` (503),
    or `Container is not listening to port …` in
    `dev/logs/cloud-agent-next.log`, then read the wrapper log inside the
    sandbox (`/tmp/kilocode-wrapper-*.log`) for bootstrap/import detail. The
    503 from the container control connection means the Docker container's
    control plane isn't ready — this is an environmental issue under Docker
    Desktop load, not a code regression. If the failure is transient, suspect
    Docker contention: leftover stopped containers, a competing dev session
    also running Cloud Agent sandboxes, or stale DO alarm timers from
    previous sessions. Confirm the fake LLM was never reached with
    `curl -s $FAKE_LLM_URL/test/requests` — a flat `chatCompletions` count
    proves the stall is upstream of kilo inference.
- Wrapper log reaches bootstrap/import, then repeats:
  - inspect import metadata, import exit code, and post-import `getSession()` lookup.
- Wrapper ingest connects, but UI stays stale:
  - inspect stream replay/hydration logs and whether persisted events were broadcast.
- Wrapper completes, but external consumers do not update:
  - inspect callback enqueue, queue consumer, delivery classification, and retry logs.
- Container disappears with little Worker noise:
  - inspect Docker container lifecycle and the final wrapper/Kilo logs copied from the sandbox while still available.

## Local Smoke Harness

For end-to-end fake-LLM coverage, use:

- `services/cloud-agent-next/test/e2e/README.md`
- `pnpm exec tsx services/cloud-agent-next/test/e2e/run.ts <lifecycle> <conversation>`
- `pnpm exec tsx services/cloud-agent-next/test/e2e/smoke.ts`

The smoke helpers in `services/cloud-agent-next/test/e2e/sandbox-control.ts` already encode the same Docker log-discovery patterns used in this document.

## Safety Notes

- Do not log or paste auth tokens, callback authorization headers, cookies, webhook secrets, or signed URLs.
- Prefer IDs, status codes, timing, counts, and lifecycle states when adding new diagnostics.
- Sandbox logs are disposable local artifacts; copy them before destroying or restarting the container if they matter to the investigation.
