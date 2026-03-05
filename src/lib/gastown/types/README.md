# Gastown Worker Type Declarations

These `.d.ts` files are **generated** from the `cloudflare-gastown` worker and should not be edited by hand.

They exist because the Next.js app's TypeScript environment cannot resolve the worker's Cloudflare runtime types (`DurableObjectState`, `Env`, `cloudflare:workers`, etc.). The generated declarations contain only the tRPC router type signatures, stripped of those dependencies.

**To regenerate** after changing the worker's tRPC router:

```sh
cd cloudflare-gastown && pnpm build:types
```

Then copy the output and fix the import style for eslint:

```sh
cp cloudflare-gastown/dist-types/trpc/router.d.ts src/lib/gastown/types/router.d.ts
cp cloudflare-gastown/dist-types/trpc/schemas.d.ts src/lib/gastown/types/schemas.d.ts
sed -i '' "s/^import { z }/import type { z }/" src/lib/gastown/types/schemas.d.ts
```

The `init.d.ts` is hand-maintained (replaces `Env` with `Record<string, unknown>`).

**These files are temporary.** Once the gastown UI moves into the `cloudflare-gastown` worker, the frontend and router will share a single TypeScript environment and these declarations won't be needed.
