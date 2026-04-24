/**
 * Wanted board operations — shared business logic used by both the tRPC
 * router and the WastelandRPCEntrypoint. Each function owns the full
 * operation: credential decryption, container dispatch, result parsing,
 * cache refresh, and metering.
 *
 * All ownership/auth checks happen in the callers (tRPC via
 * resolveWastelandOwnership, RPC via the fact that only peer workers
 * can call the binding).
 */
import { z } from 'zod';
export declare class WantedBoardOpError extends Error {
    /** Maps roughly to HTTP/tRPC codes. Callers translate as needed. */
    readonly code: 'NOT_FOUND' | 'PRECONDITION_FAILED' | 'INTERNAL_SERVER_ERROR' | 'UPSTREAM_ERROR';
    constructor(message: string, 
    /** Maps roughly to HTTP/tRPC codes. Callers translate as needed. */
    code: 'NOT_FOUND' | 'PRECONDITION_FAILED' | 'INTERNAL_SERVER_ERROR' | 'UPSTREAM_ERROR');
}
declare const PriorityEnum: z.ZodEnum<{
    critical: "critical";
    high: "high";
    low: "low";
    medium: "medium";
}>;
declare const TypeEnum: z.ZodEnum<{
    bug: "bug";
    docs: "docs";
    feature: "feature";
    other: "other";
}>;
export declare function browseWantedBoard(env: Env, wastelandId: string, userId: string): Promise<Array<Record<string, unknown>>>;
export declare function claimWantedItem(env: Env, wastelandId: string, userId: string, itemId: string, options?: {
    direct?: boolean;
}): Promise<{
    success: true;
}>;
export declare function unclaimWantedItem(env: Env, wastelandId: string, userId: string, itemId: string, options?: {
    direct?: boolean;
}): Promise<{
    success: true;
}>;
export declare function acceptWantedItem(env: Env, wastelandId: string, userId: string, input: {
    itemId: string;
    quality: 'excellent' | 'good' | 'fair' | 'poor';
    /** Free-form message attached to the stamp (written to `stamps.message`). */
    message?: string;
    direct?: boolean;
}): Promise<{
    success: true;
}>;
export declare function rejectWantedItem(env: Env, wastelandId: string, userId: string, input: {
    itemId: string;
    /**
     * Rejection reason — becomes part of the `wl reject` commit message.
     * Maps to `--reason` on the wl CLI (not `--comment`, which is an
     * approve/request-changes flag).
     */
    reason: string;
    direct?: boolean;
}): Promise<{
    success: true;
}>;
export declare function closeWantedItem(env: Env, wastelandId: string, userId: string, itemId: string, options?: {
    direct?: boolean;
}): Promise<{
    success: true;
}>;
export declare function postWantedItem(env: Env, wastelandId: string, userId: string, input: {
    title: string;
    description: string;
    priority?: z.infer<typeof PriorityEnum>;
    type?: z.infer<typeof TypeEnum>;
    direct?: boolean;
}): Promise<{
    success: true;
}>;
export declare function markWantedItemDone(env: Env, wastelandId: string, userId: string, input: {
    itemId: string;
    evidence: string;
    direct?: boolean;
}): Promise<{
    success: true;
}>;
export {};
