/**
 * RPC entrypoint for peer workers (e.g. gastown) to call wasteland
 * operations directly without going through HTTP + tRPC.
 *
 * Exposed as `WastelandRPCEntrypoint` in wrangler.jsonc and bound by
 * consumers via `services` bindings with `entrypoint: "WastelandRPCEntrypoint"`.
 *
 * Auth model: the caller is a trusted peer worker. The userId is passed
 * as a parameter and used for credential lookup, metering, and audit —
 * but we do NOT re-validate it here because peer workers have already
 * authenticated their inbound user.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { WantedBoardOpError } from './wanted-board/wanted-board-ops';
export type WastelandRpcResult<T> = {
    success: true;
    data: T;
} | {
    success: false;
    code: WantedBoardOpError['code'];
    message: string;
};
export declare class WastelandRPCEntrypoint extends WorkerEntrypoint<Env> {
    browseWantedBoard(params: {
        wastelandId: string;
        userId: string;
    }): Promise<WastelandRpcResult<Record<string, unknown>[]>>;
    claimWantedItem(params: {
        wastelandId: string;
        userId: string;
        itemId: string;
        direct?: boolean;
    }): Promise<WastelandRpcResult<{
        success: true;
    }>>;
    unclaimWantedItem(params: {
        wastelandId: string;
        userId: string;
        itemId: string;
        direct?: boolean;
    }): Promise<WastelandRpcResult<{
        success: true;
    }>>;
    postWantedItem(params: {
        wastelandId: string;
        userId: string;
        title: string;
        description: string;
        priority?: 'low' | 'medium' | 'high' | 'critical';
        type?: 'feature' | 'bug' | 'docs' | 'other';
        direct?: boolean;
    }): Promise<WastelandRpcResult<{
        success: true;
    }>>;
    markWantedItemDone(params: {
        wastelandId: string;
        userId: string;
        itemId: string;
        evidence: string;
        direct?: boolean;
    }): Promise<WastelandRpcResult<{
        success: true;
    }>>;
    acceptWantedItem(params: {
        wastelandId: string;
        userId: string;
        itemId: string;
        quality: 'excellent' | 'good' | 'fair' | 'poor';
        /** Free-form message attached to the reputation stamp. */
        message?: string;
        direct?: boolean;
    }): Promise<WastelandRpcResult<{
        success: true;
    }>>;
    rejectWantedItem(params: {
        wastelandId: string;
        userId: string;
        itemId: string;
        /** Rejection reason (maps to `wl reject --reason`). */
        reason: string;
        direct?: boolean;
    }): Promise<WastelandRpcResult<{
        success: true;
    }>>;
    closeWantedItem(params: {
        wastelandId: string;
        userId: string;
        itemId: string;
        direct?: boolean;
    }): Promise<WastelandRpcResult<{
        success: true;
    }>>;
}
