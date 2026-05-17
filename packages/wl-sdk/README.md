# @kilocode/wl-sdk

The Wasteland Protocol SDK — a pure-TypeScript client for talking to the
Wasteland data layer (DoltHub-backed) and composing operational primitives.

This is the production path used by the wasteland Cloudflare Worker.

## Why TypeScript

- Runs in Cloudflare Workers, Node, and the browser without polyfills.
- No Node-only APIs in source. No native bindings.
- Type-safe DML built from the same schema as the server.
- Smaller bundle / faster cold start than alternative WASM builds.

## Layout

```
src/
  index.ts          public re-exports
  client.ts         top-level WlClient
  types.ts          shared types
  commons/          shared SQL helpers + generated schema/DML
    schema.generated.ts   regenerated via scripts/generate-from-schema.ts
    dml.generated.ts
  dolthub/          DoltHub HTTP client (read/write/branches/pulls/operation)
  ops/              higher-level operations composed over the client
    join, leave, browse, post, claim, unclaim, done, accept, reject,
    close, publish, unpublish, workshop (list/discard branches), branch
scripts/
  generate-from-schema.ts   regenerates commons/schema + dml from the
                            wasteland commons schema
```

## Usage

```ts
import { WlClient, browse, claim } from '@kilocode/wl-sdk';

const client = new WlClient({
  upstream: 'jrf0110/wl-commons',
  forkOrg: 'jfawcett',
  rigHandle: 'jfawcett',
  token: process.env.DOLTHUB_TOKEN!,
});

const items = await browse({ client });
await claim({ client, itemId: 'w-abc123' });
```

The wasteland Worker wraps these ops with auth resolution, billing, and
DO state refreshes; see `services/wasteland/src/wanted-board/wanted-board-ops-sdk.ts`
and `services/wasteland/src/branch-ops/branch-ops.ts` for the integration
points.
