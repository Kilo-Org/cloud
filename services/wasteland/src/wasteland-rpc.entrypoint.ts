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
import * as wantedBoard from './wanted-board/wanted-board-ops';
import { WantedBoardOpError } from './wanted-board/wanted-board-ops';

export type WastelandRpcResult<T> =
  | { success: true; data: T }
  | { success: false; code: WantedBoardOpError['code']; message: string };

function wrap<T>(fn: () => Promise<T>): Promise<WastelandRpcResult<T>> {
  return fn().then(
    data => ({ success: true as const, data }),
    err => {
      if (err instanceof WantedBoardOpError) {
        return { success: false as const, code: err.code, message: err.message };
      }
      throw err;
    }
  );
}

export class WastelandRPCEntrypoint extends WorkerEntrypoint<Env> {
  async browseWantedBoard(params: { wastelandId: string; userId: string }) {
    return wrap(() => wantedBoard.browseWantedBoard(this.env, params.wastelandId, params.userId));
  }

  async claimWantedItem(params: { wastelandId: string; userId: string; itemId: string }) {
    return wrap(() =>
      wantedBoard.claimWantedItem(this.env, params.wastelandId, params.userId, params.itemId)
    );
  }

  async postWantedItem(params: {
    wastelandId: string;
    userId: string;
    title: string;
    description: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
    type?: 'feature' | 'bug' | 'docs' | 'other';
  }) {
    return wrap(() =>
      wantedBoard.postWantedItem(this.env, params.wastelandId, params.userId, {
        title: params.title,
        description: params.description,
        priority: params.priority,
        type: params.type,
      })
    );
  }

  async markWantedItemDone(params: {
    wastelandId: string;
    userId: string;
    itemId: string;
    evidence: string;
  }) {
    return wrap(() =>
      wantedBoard.markWantedItemDone(this.env, params.wastelandId, params.userId, {
        itemId: params.itemId,
        evidence: params.evidence,
      })
    );
  }
}
