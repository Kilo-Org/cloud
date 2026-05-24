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

## Interpreting Common States

- Worker queueing succeeds, but no wrapper logs appear:
  - inspect pending flush scheduling, sandbox creation, and wrapper startup logs in `dev/logs/cloud-agent-next.log`.
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
