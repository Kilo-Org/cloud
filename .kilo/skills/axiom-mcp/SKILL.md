---
name: axiom-mcp
description: Navigates Kilo's Axiom datasets and investigates production logs, traces, metrics, and Cloud Agent sessions efficiently. Use when querying Axiom MCP, tracing a session failure, checking service health, or correlating errors with deployments.
---

# Axiom MCP

Use the Kilo Code organization: `orgId: "kilo-code-nvjh"`, not `"kilo"`. Confirm with `listOrganizations` if access/defaults differ. Tool names below follow the docs; clients may prefix them with `axiom_`.

## Dataset Map

Treat this map as a starting point; refresh `listDatasets` when a name/kind differs. Dataset **kind**, not name or description, determines APL versus MPL.

| Dataset | Query | Start Here For |
|---|---|---|
| `vercel` | APL | Web/function/request logs; Cloud Agent session creation and request IDs. |
| `cloudflare-logpush` | APL | Worker/DO logs and execution metadata; Cloud Agent allocation and message lifecycle. |
| `cloudflare-user-data-export` | APL | Cloudflare OTel spans: `trace_id`, `span_id`, `duration`, service/HTTP attributes. |
| `supabase-production` | APL | Production database logs. |
| `supabase-snowflake-exports` | APL | Exported Supabase platform/database logs: `event_message`, `metadata.*`. |
| `kilocode-app` | MPL | Vercel app telemetry; discover the metric catalog first. |
| `kilocode-app-dev` | MPL | Development app telemetry; discover the metric catalog first. |
| `kilocode-app-metrics` | MPL | App metrics. |
| `traces` | MPL | **Metrics despite the name**, not an APL traces dataset. |

## Fast Workflow

1. Set explicit API `startTime`/`endTime` to the smallest useful window, usually 5-15 minutes. These bound the scan; an APL `_time` filter alone does not. Widen only when necessary, allowing for ingestion lag.
2. Reuse schema already in context; otherwise call `getDatasetFields`. Sample map/array structure narrowly before accessing keys. Probe filter/group dimensions on a recent window with `summarize count() by FIELD | top 10 by count_`.
3. For APL, filter selectively first, project only needed fields, and prefer counts/top groups over raw rows. Use `has_cs` for full IDs/unique terms; avoid whole-row `search`, `project *`, and unbounded output. Start with `take 10` or `top 10`.
4. For metrics, use `listMetrics` (type/temporality/unit), then `listMetricTags`/`getMetricTagValues`, `getMetricsSpec`, and `queryMetrics`. With a known service/host, `searchMetrics` is a shortcut; use at least a 3-hour discovery window because indexing can lag. Keep the actual metrics query window narrow.
5. Use compact output initially. Set `truncate: false` only when omitted rows or abbreviated details matter; still bound the query itself. Heed query-budget warnings and stop at exhaustion.

## Expand Nested Fields

Use APL `mv-expand` inside MCP `queryDataset` to flatten arrays/property bags; it is query syntax, not a CLI-only feature. Schema lists map columns, not their inner keys: discover keys with `bag_keys` and expand the **key array**, avoiding exposure of map values.

```apl
['cloudflare-user-data-export']
| project ['attributes.custom']
| take 20
| extend keys=bag_keys(['attributes.custom'])
| mv-expand keys
| summarize count() by key=tostring(keys)
| top 10 by count_
```

Use bracket access for an observed key: `['attributes.custom']['<observed.key>']`. Expanding arrays duplicates the other columns: project narrowly first, and do not mistake expanded elements for distinct requests/spans. This is APL guidance, not MPL syntax.

## Cloud Agent Shortcut

Start with the UI's `ses_*` ID in `vercel`; creation logs map it to a `workspace_*`/`agent_*` Cloud Agent ID. Follow that ID into `cloudflare-logpush`, then collect logical sandbox, allocation, physical sandbox, and wrapper IDs as needed. Do not interchange them.

Pass the APL examples to `queryDataset` with an explicit API window and the organization above. Replace placeholders; first confirm the listed fields and Cloudflare batch shape.

```apl
['vercel']
| where message has_cs '<ses_id>'
| project _time, message, ['request.id']
| order by _time asc
| take 10
```

Cloudflare `Logs` is a batch; structured records commonly live in `Logs.Message[0]`. Filter the batch, expand, parse, then filter individual records again so unrelated batch events are not attributed to this session.

```apl
['cloudflare-logpush']
| where ScriptName == 'cloud-agent-next'
| where tostring(Logs) has_cs '<cloud_agent_or_sandbox_id>'
| project Logs
| mv-expand Logs
| extend r = parse_json(tostring(Logs.Message[0]))
| where tostring(r) has_cs '<cloud_agent_or_sandbox_id>'
| project event_time=tostring(r.time), event=tostring(r.diagnosticEvent),
          action=tostring(r.action), reason=tostring(r.reason),
          cause=tostring(r.cause), state=tostring(r.toState)
| order by event_time desc
| take 15
```

Use embedded `r.time`/`Logs.TimestampMs` for event chronology; `_time` can lag in this pipeline. Match terms/IDs, not JSON quote syntax inside `tostring(Logs)`: embedded JSON strings are escaped. `Outcome == 'ok'` means a Worker invocation succeeded, not that the agent turn succeeded. Missing logs are not proof that a process never started.

## Other Shortcuts

- Topology/system health: start with `services-getMap`; use `services-getChanges` or `services-getEdgeHistory` for changes/onset.
- Population comparisons: `runSpotlight` with fixed bounds, then verify leads with focused counts/rates. Useful saved patterns: `getSavedQueries`.
- Alerts/deploy correlation: `checkMonitors`, `getMonitorHistory`, `getAnnotations`. Verify deployment/version evidence; merged does not mean deployed.
- Inspect actual observed region fields and follow root `AGENTS.md`; a Vercel proxy/edge region is not necessarily the function region.
- Keep investigations read-only unless changes are requested. Never dump credentials, auth headers, cookies, environment/config payloads, or entire raw log batches. Report UTC timestamps, IDs, failure stage, evidence, and uncertainty separately.

References: [MCP tools](https://axiom.co/docs/console/intelligence/mcp-server/tools), [mv-expand](https://axiom.co/docs/apl/tabular-operators/mv-expand), [bag_keys](https://axiom.co/docs/apl/scalar-functions/array-functions/bag-keys). Prefer connected tool schemas and `searchAxiomDocs`/`readAxiomDoc` over guessing syntax or capabilities.
