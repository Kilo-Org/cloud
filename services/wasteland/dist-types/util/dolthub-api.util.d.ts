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
/**
 * Build the DoltHub web URL for a pull request on `upstream`. Used to
 * surface a "view this PR" link in the wanted-board UI.
 */
export declare function buildPullWebUrl(upstream: string, pullId: string): string;
export declare function upstreamExistsOnDolthub(upstream: string, token: string | null): Promise<boolean>;
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
export type DoltHubPullDetailT = {
    pull_id: string;
    title: string;
    description: string | null;
    state: string;
    from_branch_name: string | null;
    to_branch_name: string | null;
    from_branch_owner_name: string | null;
    from_branch_repo_name: string | null;
    creator_name: string | null;
    created_at: string | null;
    updated_at: string | null;
};
export declare function getPull(upstream: string, token: string, pullId: string): Promise<DoltHubPullDetailT>;
/**
 * Open a pull request on `upstream` proposing to merge `fromBranch` into
 * `toBranch` (default `main`). Returns the new pull's id as a string.
 *
 * Used by admin operations that apply changes via `runWrite` on a scratch
 * branch — the scratch commit has to be merged into `main` for the change
 * to actually land, and the REST API's only path to do that is
 * open-PR → merge-PR (there is no direct branch-to-branch merge endpoint).
 */
export declare function createPull(upstream: string, token: string, opts: {
    title: string;
    description?: string;
    fromBranch: string;
    toBranch?: string;
}): Promise<{
    pullId: string;
}>;
export declare function mergePull(upstream: string, token: string, pullId: string): Promise<{
    state: string;
    operationName: string | null;
}>;
/**
 * Poll `GET /pulls/{id}/merge?operationName=...` until the merge operation
 * completes or `timeoutMs` elapses. Required before cleaning up the source
 * branch of an auto-merge flow — deleting the branch while the async merge
 * worker is still reading it can abort the merge silently and leave the
 * target branch unchanged.
 *
 * Resolves with `{ done: true, success: boolean }`:
 *   - `success=true` means the merge committed to the target branch.
 *   - `success=false` means the job finished but DoltHub reported a
 *     query-level failure (e.g. a conflict) — inspect res_details.
 * Rejects with `DoltHubApiError` on a timeout or a transport error.
 */
export declare function waitForMergeCompletion(upstream: string, token: string, pullId: string, operationName: string, opts?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
}): Promise<{
    done: true;
    success: boolean;
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
/**
 * Runs raw SQL against DoltHub — **the caller is responsible for escaping**.
 * DoltHub's read API has no parameterized-query surface; we send the text
 * over a URL query param. Every caller must either:
 *   - use a static SQL literal with no user input, or
 *   - validate any interpolated values against a tight regex (see the
 *     `fetch*Row` helpers in `inbox/inbox-classifier.ts` for the pattern).
 * Do not pass unvalidated user input through this function.
 */
export declare function runUnsafeSql(upstream: string, token: string, branch: string, sql: string): Promise<DoltHubSqlResultT>;
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
