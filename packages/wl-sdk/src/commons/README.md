# commons

Shared SQL building blocks for the SDK.

`schema.generated.ts` and `dml.generated.ts` will be added by the schema
generator (`scripts/generate-from-schema.ts`). Do not hand-edit those files
once they exist.

Hand-written helpers (e.g. `escape.ts`) live alongside the generated files.
