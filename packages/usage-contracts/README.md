# Usage contracts

Shared usage request/response schemas, inferred types, and enum definitions for
the gateway, usage-ingest Worker, and usage writer. Runtime dependencies are
limited to Zod; keep this package independent of Next.js and database packages.

Import contracts and usage enums directly from this package. Database/type
alignment checks belong in web-shared
(`usage-record-contract-alignment.ts`), outside this package. Preserve nullable
fields, safe integer limits, ISO timestamps, optional bouncer data, and unknown-key
stripping when changing the contract.

## Classifier usage

The auto-routing Worker constructs `auto-routing/classifier` usage records and
hands them to its conversation Durable Object from `waitUntil`, independently
of the `/decide` response or a later session turn. The DO persists each event
before delivery through `@kilocode/worker-utils/usage-writer-client` to the web
app's `/api/internal/usage/record` endpoint. Its usage UUID is derived from the
conversation, classifier model, exact content hash, call kind, and request start.
Retries reuse the entire event, and `recorded` or `duplicate` acknowledges it.
Unavailable writes remain under `usage:<id>` and use exponential alarm retries.
The alarm also sweeps decision-cache entries; cache expiry never deletes usage.
Writes still unavailable at the retry horizon emit
`auto_routing_classifier_usage_dropped` and require operational investigation.

The Worker returns zero classifier cost once it owns billing. The gateway must
retain billing for positive-cost responses from older workers. Either rollout
order is compatible: gateway-first still bills old workers; worker-first makes
old gateways skip their classifier row because the new worker returns zero.
Do not remove the gateway's positive-cost compatibility path until all workers
use worker-owned billing.
