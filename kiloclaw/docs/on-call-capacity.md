# On-Call Runbook: KiloClaw Capacity & Region Eviction

## Overview

KiloClaw provisions Fly.io Machines in a prioritized list of regions (e.g. `dfw,ord`).
When a region's org quota is exhausted, Fly returns a **403** with a message like
`organization "Kilo" is using N MB of memory in {region} which is over the allowed quota`.
The system handles this automatically via **named-region eviction** — no human
intervention is needed unless the system falls back to meta-regions only.

## How Named-Region Eviction Works

The routing preference is stored in KV as a comma-separated region list. When
a 403 is detected, the affected **named region** (e.g. `ord`, `dfw`) is
auto-evicted from this list. Meta-regions (`eu`, `us`) are never evicted.

### Eviction cascade example

| Step | Event | KV region list |
| ---- | ----- | -------------- |
| 0 | Initial state | `dfw,ord` |
| 1 | `ord` returns 403 → evicted, meta-region fallback appended | `dfw,eu,us` |
| 2 | `dfw` returns 403 → evicted, only meta-regions remain | `eu,us` |
| 3 | No further evictions — `eu` and `us` are meta-regions and are never evicted | `eu,us` |

### Key properties

- **Only named regions are evicted.** Meta-regions (`eu`, `us`) expand server-side
  to all regions in that geographic area. Fly handles internal distribution, so
  evicting them would remove our last fallback.
- **Eviction is automatic.** The code path in
  `kiloclaw-instance/index.ts` detects 403s via `isFlyInsufficientResources()`,
  then calls `evictCapacityRegionFromKV()` in `regions.ts` to update KV.
- **Each eviction emits a `region.capacity_eviction` analytics event** with a
  label of `evicted` (named region removed) or `reverted_to_meta` (fell back to
  meta-regions only).

## Alerting Guidance

| Condition | Severity | Action |
| --------- | -------- | ------ |
| Named region evicted (e.g. `dfw` removed, list becomes `ord,eu,us`) | **Notification** (no page) | No human action needed. Auto-eviction handled it. Monitor for further evictions. |
| Down to meta-regions only (`eu,us`) | **Page** | Likely means quota exhaustion across most regions. Escalate to Fly.io (see below). |

A page should only fire when there is an actionable human intervention needed.
A single named-region eviction is self-healing and does not require a response.

## Escalation: Down to Meta-Regions Only

If KV contains only `eu,us` (no named regions), the system has exhausted quota
in every named region. At this point:

1. **Check current KV value:**
   ```
   wrangler kv key get --namespace-id <NAMESPACE_ID> fly-regions
   ```
2. **Verify quota status** in the Fly.io dashboard or via `flyctl orgs show`.
3. **Escalate to Fly.io** to request a quota increase for the affected org.
4. **After quota is restored**, update the KV region list back to the desired
   named regions:
   ```
   wrangler kv key put --namespace-id <NAMESPACE_ID> fly-regions "dfw,ord"
   ```

## Code References

| File | What it does |
| ---- | ------------ |
| `src/durable-objects/regions.ts` | `evictCapacityRegionFromKV()` — removes the named region from KV, falls back to meta-regions when ≤1 named region remains |
| `src/fly/client.ts` | `isFlyInsufficientResources()` — classifies Fly API errors (400/403/409/412) as capacity issues |
| `src/durable-objects/kiloclaw-instance/index.ts` | 403 detection → calls `evictCapacityRegionFromKV()` + `replaceStrandedVolume()` |
| `src/durable-objects/kiloclaw-instance/fly-machines.ts` | `replaceStrandedVolume()` — moves the user's volume to a different region |

## Related Capacity Error Types

Not all capacity errors trigger region eviction. Only **403** (org quota exceeded)
evicts a named region from KV. Other capacity status codes trigger volume
replacement but do not modify the global region list:

| HTTP Status | Fly Error | Triggers KV Eviction? |
| ----------- | --------- | --------------------- |
| 403 | Org quota exceeded in region | **Yes** — named region evicted from KV |
| 400 | `no capacity` | No — host-level, not region-wide |
| 409 | `insufficient memory available` | No — host-level |
| 412 | `insufficient resources to create new machine with existing volume` | No — host-level |

All four status codes trigger `replaceStrandedVolume()` to move the user to a
different region, but only 403 modifies the global routing preference in KV.
