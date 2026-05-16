# @kilocode/wl-sdk

The Wasteland Protocol SDK — a pure-TypeScript client for talking to the
Wasteland data layer (DoltHub-backed) and composing operational primitives.

## Why

This package replaces the previous `libwl` WASM client with a pure-TypeScript
implementation. Goals:

- Runs in Cloudflare Workers, Node, and the browser without polyfills.
- No Node-only APIs in source. No native bindings.
- Type-safe DML built from the same schema as the server.
- Smaller bundle / faster cold start than a WASM build.

## Status

Scaffold only. SDK modules (DoltHub client, ops, generated DML) are added by
subsequent work.

## Usage (stub)

```ts
import { WlClient } from '@kilocode/wl-sdk';

// Implementation pending.
const client = new WlClient();
```

## Layout

```
src/
  index.ts          public re-exports
  client.ts         top-level WlClient
  types.ts          shared types
  commons/          shared SQL helpers + generated schema/DML (generated)
  dolthub/          DoltHub HTTP client (read/write/branches/pulls/operation)
  ops/              higher-level operations composed over the client
scripts/
  generate-from-schema.ts   (planned) regenerates commons/schema + dml
```
