import type { SessionSyncResult } from '../shared/sandbox-control-protocol.js';
import type { SessionMessageRecord } from './session-message-queue.js';

export type InteractionRefreshScope = {
  message: SessionMessageRecord;
  epoch: number;
  interactionRevision: number | undefined;
  sessionId: string | undefined;
  sandboxId: string | undefined;
  kiloSessionId: string | undefined;
  directory: string | undefined;
  worktreeId: string | undefined;
};

type RefreshTrigger = 'accepted_alarm' | 'pending_interactions';
type SyncResult = SessionSyncResult | undefined;

type RefreshDeps = {
  captureScope: () => InteractionRefreshScope | undefined;
  sync: (scope: InteractionRefreshScope, trigger: RefreshTrigger) => Promise<SyncResult>;
  onBackgroundError: () => void;
};

function scopeMatches(a: InteractionRefreshScope, b: InteractionRefreshScope): boolean {
  return (
    a.message.messageId === b.message.messageId &&
    a.message.wrapperInstanceId === b.message.wrapperInstanceId &&
    a.epoch === b.epoch &&
    a.interactionRevision === b.interactionRevision &&
    a.sessionId === b.sessionId &&
    a.sandboxId === b.sandboxId &&
    a.kiloSessionId === b.kiloSessionId &&
    a.directory === b.directory &&
    a.worktreeId === b.worktreeId
  );
}

export function createInteractionRefresh(deps: RefreshDeps) {
  let inflight: { scope: InteractionRefreshScope; promise: Promise<SyncResult> } | undefined;

  function isCurrent(
    scope: InteractionRefreshScope,
    revision = scope.interactionRevision
  ): boolean {
    const current = deps.captureScope();
    return (
      current !== undefined && scopeMatches({ ...scope, interactionRevision: revision }, current)
    );
  }

  function refresh(
    scope: InteractionRefreshScope | undefined,
    trigger: RefreshTrigger
  ): Promise<SyncResult> {
    if (!scope || !isCurrent(scope)) return Promise.resolve(undefined);
    if (inflight && scopeMatches(inflight.scope, scope)) return inflight.promise;
    const pending = Promise.resolve().then(() =>
      isCurrent(scope) ? deps.sync(scope, trigger) : undefined
    );
    const entry = { scope, promise: pending };
    inflight = entry;
    const clear = () => {
      if (inflight === entry) inflight = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  }

  function scheduleRefresh(): void {
    void refresh(deps.captureScope(), 'pending_interactions').catch(deps.onBackgroundError);
  }

  return { refresh, scheduleRefresh, isCurrent };
}

export type InteractionRefresh = ReturnType<typeof createInteractionRefresh>;
