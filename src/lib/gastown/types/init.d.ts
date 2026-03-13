export type TRPCContext = {
  env: Env;
  userId: string;
  isAdmin: boolean;
  apiTokenPepper: string | null;
  gastownAccess: boolean;
};
export declare const router: import('@trpc/server').TRPCRouterBuilder<{
  ctx: TRPCContext;
  meta: object;
  errorShape: import('@trpc/server').TRPCDefaultErrorShape;
  transformer: false;
}>;
/**
 * Base procedure — requires a valid Kilo JWT (enforced by kiloAuthMiddleware
 * running before tRPC). The userId is extracted from the JWT and set on the
 * Hono context by kiloAuthMiddleware, then forwarded into the tRPC context
 * by the createContext callback in gastown.worker.ts.
 */
export declare const procedure: import('@trpc/server').TRPCProcedureBuilder<
  TRPCContext,
  object,
  {
    apiTokenPepper: string | null;
    env: Env;
    gastownAccess: boolean;
    isAdmin: boolean;
    userId: string;
  },
  import('@trpc/server').TRPCUnsetMarker,
  import('@trpc/server').TRPCUnsetMarker,
  import('@trpc/server').TRPCUnsetMarker,
  import('@trpc/server').TRPCUnsetMarker,
  false
>;
/**
 * Gastown access procedure — requires a valid JWT with `gastownAccess`
 * (set by the token endpoint after PostHog flag evaluation). Falls back
 * to `isAdmin` for backward compatibility with pre-migration tokens.
 */
export declare const gastownProcedure: import('@trpc/server').TRPCProcedureBuilder<
  TRPCContext,
  object,
  {
    apiTokenPepper: string | null;
    env: Env;
    gastownAccess: boolean;
    isAdmin: boolean;
    userId: string;
  },
  import('@trpc/server').TRPCUnsetMarker,
  import('@trpc/server').TRPCUnsetMarker,
  import('@trpc/server').TRPCUnsetMarker,
  import('@trpc/server').TRPCUnsetMarker,
  false
>;
/**
 * Admin-only procedure — requires `isAdmin` on the JWT. Used for admin
 * panel endpoints that bypass per-user ownership checks (e.g. town-wide
 * bead/agent listing for support diagnostics).
 */
export declare const adminProcedure: import('@trpc/server').TRPCProcedureBuilder<
  TRPCContext,
  object,
  {
    apiTokenPepper: string | null;
    env: Env;
    gastownAccess: boolean;
    isAdmin: boolean;
    userId: string;
  },
  import('@trpc/server').TRPCUnsetMarker,
  import('@trpc/server').TRPCUnsetMarker,
  import('@trpc/server').TRPCUnsetMarker,
  import('@trpc/server').TRPCUnsetMarker,
  false
>;
