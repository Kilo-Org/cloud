import type { JwtOrgMembership } from '../middleware/auth.middleware';
export type TRPCContext = {
    env: Env;
    userId: string;
    isAdmin: boolean;
    apiTokenPepper: string | null;
    orgMemberships: JwtOrgMembership[];
};
export declare const router: import("@trpc/server").TRPCRouterBuilder<{
    ctx: TRPCContext;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: false;
}>;
/**
 * Base procedure — requires a valid Kilo JWT (enforced by kiloAuthMiddleware
 * running before tRPC). The userId is extracted from the JWT and set on the
 * Hono context by kiloAuthMiddleware, then forwarded into the tRPC context
 * by the createContext callback in wasteland.worker.ts.
 *
 * Also enforces per-user rate limits for operations that have them configured.
 */
export declare const procedure: import("@trpc/server").TRPCProcedureBuilder<TRPCContext, object, {
    apiTokenPepper: string | null;
    env: Env;
    isAdmin: boolean;
    orgMemberships: JwtOrgMembership[];
    userId: string;
}, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, false>;
/**
 * Admin-only procedure — requires `isAdmin` on the JWT. Used for admin
 * endpoints that bypass per-user ownership checks.
 */
export declare const adminProcedure: import("@trpc/server").TRPCProcedureBuilder<TRPCContext, object, {
    apiTokenPepper: string | null;
    env: Env;
    isAdmin: boolean;
    orgMemberships: JwtOrgMembership[];
    userId: string;
}, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, false>;
