# Usage contracts

Shared usage request/response schemas, inferred types, and enum definitions for
the gateway, usage-ingest Worker, and usage writer. Runtime dependencies are
limited to Zod; keep this package independent of Next.js and database packages.

The original web-shared contract path and DB enum exports remain compatibility
re-exports. Database/type alignment checks belong in web-shared, outside this
package. Preserve nullable fields, safe integer limits, ISO timestamps, optional
bouncer data, and unknown-key stripping when changing the contract.
