/**
 * Thin client for the DoltHub REST API — used by admin-mode tRPC procedures
 * to list, merge, and close pull requests on an upstream repo.
 *
 * Callers pass a token explicitly; this module never reads from secrets.
 * All responses are validated with Zod before being returned.
 */
import { z } from 'zod';
export declare const DOLTHUB_API_BASE = "https://www.dolthub.com/api/v1alpha1";
export declare class DoltHubApiError extends Error {
    readonly status: number;
    constructor(message: string, status: number);
}
/**
 * Parse a DoltHub upstream string (e.g. "hop/wl-commons") into owner + db.
 */
export declare function parseUpstream(upstream: string): {
    owner: string;
    db: string;
};
export declare const DoltHubPull: z.ZodObject<{
    pull_id: z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>;
    title: z.ZodDefault<z.ZodString>;
    description: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    state: z.ZodString;
    created_at: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    updated_at: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    creator_name: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
export type DoltHubPullT = z.infer<typeof DoltHubPull>;
/**
 * List pull requests on the upstream repo, optionally filtered by state
 * ("Open" | "Closed" | "Merged"). The DoltHub API ignores the `state` query
 * parameter server-side, so we always fetch all and filter client-side.
 */
export declare function listPulls(upstream: string, token: string, opts?: {
    state?: 'Open' | 'Closed' | 'Merged';
}): Promise<DoltHubPullT[]>;
export declare const DoltHubPullDetail: z.ZodObject<{
    pull_id: z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>;
    title: z.ZodDefault<z.ZodString>;
    description: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    state: z.ZodString;
    from_branch_name: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    to_branch_name: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    from_branch_owner_name: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    from_branch_repo_name: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    creator_name: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    created_at: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    updated_at: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
export type DoltHubPullDetailT = z.infer<typeof DoltHubPullDetail>;
export declare function getPull(upstream: string, token: string, pullId: string): Promise<DoltHubPullDetailT>;
export declare function mergePull(upstream: string, token: string, pullId: string): Promise<{
    state: string;
}>;
export declare function closePull(upstream: string, token: string, pullId: string): Promise<{
    state: string;
}>;
/**
 * Post a comment on an upstream pull request. DoltHub supports POSTing
 * comments but does not expose a GET endpoint for reading them via REST,
 * so the UI links out for viewing and uses this for posting only.
 */
export declare function commentOnPull(upstream: string, token: string, pullId: string, comment: string): Promise<void>;
declare const SqlResponse: z.ZodObject<{
    query_execution_status: z.ZodOptional<z.ZodString>;
    query_execution_message: z.ZodOptional<z.ZodString>;
    rows: z.ZodOptional<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}, z.core.$loose>;
export type DoltHubSqlResultT = z.infer<typeof SqlResponse>;
export declare function runSql(upstream: string, token: string, branch: string, sql: string): Promise<DoltHubSqlResultT>;
/**
 * Write API — creates `toBranch` forked from `fromBranch` and commits the
 * DML in one call. Used for admin operations like rig trust-level edits.
 */
export declare function runWrite(upstream: string, token: string, fromBranch: string, toBranch: string, sql: string): Promise<DoltHubSqlResultT>;
/**
 * `wl` creates one PR per contribution with branch name `wl/{rig-handle}/{item-id}`.
 * Parse the branch name back out to associate a PR with a wanted item.
 */
export declare function parseWlBranch(branch: string | null): {
    rigHandle: string;
    itemId: string;
} | null;
/**
 * Delete a branch on the upstream. Used to clean up scratch branches
 * created by admin probes and direct writes. Failures are swallowed —
 * the caller wants best-effort cleanup, not to fail the parent op.
 */
export declare function deleteBranch(upstream: string, token: string, branch: string): Promise<void>;
/**
 * Map with a bounded concurrency pool. Useful for batch DoltHub calls
 * (e.g. fetching detail for N pull requests) where `Promise.all` on the
 * whole list would hammer the API and blow past Cloudflare's subrequest
 * budget.
 */
export declare function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
export {};
