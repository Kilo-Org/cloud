# Usage contracts

Shared usage request/response schemas, inferred types, and enum definitions for
the gateway, usage-ingest Worker, and usage writer. Runtime dependencies are
limited to Zod; keep this package independent of Next.js and database packages.

Import contracts and usage enums directly from this package. Database/type
alignment checks belong in web-shared
(`usage-record-contract-alignment.ts`), outside this package. Preserve nullable
fields, safe integer limits, ISO timestamps, optional bouncer data, and unknown-key
stripping when changing the contract.
