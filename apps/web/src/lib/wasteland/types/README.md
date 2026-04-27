# Wasteland Worker Type Declarations

These `.d.ts` files are **hand-written** based on the `services/wasteland` worker's tRPC router and should be kept in sync with changes to `services/wasteland/src/trpc/router.ts`.

They exist because the Next.js app's TypeScript environment cannot resolve the worker's Cloudflare runtime types (`DurableObjectState`, `Env`, `cloudflare:workers`, etc.). The declarations contain only the tRPC router type signatures, stripped of those dependencies.

**To update** after changing the worker's tRPC router:

1. Review the router at `services/wasteland/src/trpc/router.ts`
2. Update the procedure type signatures in `router.d.ts`
3. Update schema declarations in `schemas.d.ts` if output shapes changed

Once a `build:types` script is added to `services/wasteland/package.json`, these can be auto-generated like Gastown's types (see `src/lib/gastown/types/README.md`).

**These files are temporary.** Once the wasteland UI moves into the `services/wasteland` worker, the frontend and router will share a single TypeScript environment and these declarations won't be needed.
