# Cloud Agent startup in Axiom

In `cloudflare-logpush`, save the health and timeline queries below. Start with a 15-minute time range after rollout. The queries show observed logs, not an audit record: sampling, dropped frames, or a process exit can leave gaps.

- `session_startup_finished`: time from the triggering message's admission to the Session DO observing a terminal route outcome. This includes queue time and retries within the route attempt. It does not measure model latency, warm turns that use an already-ready route, or messages that expire before a route exists. `startSource` describes how the allocation launched (`image` or `snapshot`), not whether this chat reused it. `preparationMs` starts when the Session DO first records preparation.
- `snapshot_restore_attempt_finished`: one observation per attempt. `provider_create` measures Vercel create with an environment snapshot; `provider_launch` measures the provider launch call with a workspace or environment snapshot, excluding stop and retry setup. Neither is a provider-internal disk timer. `wrapper_restore` measures Kilo v1 ingest snapshot restoration and includes download/validation, sanitization/import, and diff extraction/application when those phases run. Kilo v2 history replay is not an ingest snapshot restore.
- `outcome=partial` means some diffs were skipped. `outcome=fallback` means the wrapper tried an empty session because the stored snapshot was missing or empty. `willRetry=true` means the current startup step chose to try again; look for the next attempt to confirm it ran. A failed restore attempt does not mean the startup failed.

## Startup health

Percentiles are per outcome, so failed and partial restores do not distort successful latency. `retryDecisions` counts attempts that selected a retry, not sessions. Compare against `samples` within a restore stage when computing attempt rates; do not combine stages.

```apl
['cloudflare-logpush']
| where ScriptName == 'cloud-agent-next'
| where tostring(Logs) has_cs 'session_startup_finished' or tostring(Logs) has_cs 'snapshot_restore_attempt_finished'
| project Logs
| mv-expand Logs
| extend r = parse_json(tostring(Logs.Message[0]))
| where tostring(r.diagnosticEvent) in ('session_startup_finished', 'snapshot_restore_attempt_finished')
| summarize samples=count(),
    p50Ms=percentile(toreal(r.durationMs), 50), p95Ms=percentile(toreal(r.durationMs), 95),
    retryDecisions=countif(tobool(r.willRetry) == true)
    by event=tostring(r.diagnosticEvent), provider=tostring(r.provider), startSource=tostring(r.startSource),
       stage=tostring(r.stage), snapshotKind=tostring(r.snapshotKind), outcome=tostring(r.outcome)
| order by samples desc
```

## Session timeline

Replace the session placeholder and run the query. Then replace the allocation placeholder with the allocation ID from the results to include shared provider attempts. Use a narrower time range when inspecting a specific startup. If the allocation ID is absent, use `sandboxId` and the event times to locate allocation events; other chats in the same workspace can share that sandbox.

```apl
let session = 'workspace_REPLACE_ME';
let allocation = 'allocation_REPLACE_ME';
['cloudflare-logpush']
| where ScriptName == 'cloud-agent-next'
| where tostring(Logs) has_cs session or tostring(Logs) has_cs allocation
| project Logs
| mv-expand Logs
| extend r = parse_json(tostring(Logs.Message[0]))
| where tostring(r.sessionId) == session or (isempty(tostring(r.sessionId)) and tostring(r.allocationId) == allocation)
| where tostring(r.diagnosticEvent) in ('session_startup_finished', 'snapshot_restore_attempt_finished', 'session_route_view', 'snapshot_launch_retry')
| project eventTime=coalesce(todatetime(r.time), unixtime_milliseconds_todatetime(tolong(Logs.TimestampMs))),
    event=tostring(r.diagnosticEvent), sandboxId=tostring(r.sandboxId), allocationId=tostring(r.allocationId),
    attemptId=coalesce(tostring(r.attemptId), tostring(r.toAttemptId)), attempt=toint(r.attempt),
    stage=tostring(r.stage), snapshotKind=tostring(r.snapshotKind), outcome=tostring(r.outcome),
    reason=tostring(r.reason), willRetry=tobool(r.willRetry), durationMs=tolong(r.durationMs),
    downloadMs=tolong(r.downloadMs), importMs=tolong(r.importMs), diffsMs=tolong(r.diffsMs)
| order by eventTime asc
| take 100
```
