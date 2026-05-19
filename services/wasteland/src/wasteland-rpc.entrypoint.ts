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
import * as wantedBoard from './wanted-board/wanted-board-ops-sdk';
import { WantedBoardOpError } from './wanted-board/errors';

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

  async claimWantedItem(params: {
    wastelandId: string;
    userId: string;
    itemId: string;
    direct?: boolean;
  }) {
    return wrap(() =>
      wantedBoard.claimWantedItem(this.env, params.wastelandId, params.userId, params.itemId, {
        direct: params.direct,
      })
    );
  }

  async unclaimWantedItem(params: {
    wastelandId: string;
    userId: string;
    itemId: string;
    direct?: boolean;
  }) {
    return wrap(() =>
      wantedBoard.unclaimWantedItem(this.env, params.wastelandId, params.userId, params.itemId, {
        direct: params.direct,
      })
    );
  }

  async postWantedItem(params: {
    wastelandId: string;
    userId: string;
    title: string;
    description: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
    type?: 'feature' | 'bug' | 'docs' | 'other';
    direct?: boolean;
    publish?: boolean;
  }) {
    return wrap(() =>
      wantedBoard.postWantedItem(this.env, params.wastelandId, params.userId, {
        title: params.title,
        description: params.description,
        priority: params.priority,
        type: params.type,
        direct: params.direct,
        publish: params.publish,
      })
    );
  }

  async markWantedItemDone(params: {
    wastelandId: string;
    userId: string;
    itemId: string;
    evidence: string;
    direct?: boolean;
  }) {
    return wrap(() =>
      wantedBoard.markWantedItemDone(this.env, params.wastelandId, params.userId, {
        itemId: params.itemId,
        evidence: params.evidence,
        direct: params.direct,
      })
    );
  }

  async acceptWantedItem(params: {
    wastelandId: string;
    userId: string;
    itemId: string;
    submitterPullId?: string;
    submitterRigHandle?: string;
    submitterForkOwner?: string;
    completionId?: string;
    evidence?: string;
    quality: 'excellent' | 'good' | 'fair' | 'poor';
    reliability?: 'excellent' | 'good' | 'fair' | 'poor';
    severity?: 'leaf' | 'branch' | 'root';
    skillTags?: readonly string[];
    /** Free-form message attached to the reputation stamp. */
    message?: string;
    direct?: boolean;
  }) {
    return wrap(() =>
      wantedBoard.acceptWantedItem(this.env, params.wastelandId, params.userId, {
        itemId: params.itemId,
        submitterPullId: params.submitterPullId,
        submitterRigHandle: params.submitterRigHandle,
        submitterForkOwner: params.submitterForkOwner,
        completionId: params.completionId,
        evidence: params.evidence,
        quality: params.quality,
        reliability: params.reliability,
        severity: params.severity,
        skillTags: params.skillTags,
        message: params.message,
        direct: params.direct,
      })
    );
  }

  async rejectWantedItem(params: {
    wastelandId: string;
    userId: string;
    itemId: string;
    /** Rejection reason (maps to `wl reject --reason`). */
    reason: string;
    direct?: boolean;
  }) {
    return wrap(() =>
      wantedBoard.rejectWantedItem(this.env, params.wastelandId, params.userId, {
        itemId: params.itemId,
        reason: params.reason,
        direct: params.direct,
      })
    );
  }

  async closeWantedItem(params: {
    wastelandId: string;
    userId: string;
    itemId: string;
    direct?: boolean;
  }) {
    return wrap(() =>
      wantedBoard.closeWantedItem(this.env, params.wastelandId, params.userId, params.itemId, {
        direct: params.direct,
      })
    );
  }
}
