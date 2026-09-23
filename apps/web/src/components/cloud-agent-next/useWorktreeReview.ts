'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { skipToken, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';
import { useTRPC } from '@/lib/trpc/utils';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import type { StoredSession } from './types';
import type { SessionConfig } from '@kilocode/cloud-agent-sdk';
import type { WorktreeFileReviewBindings, WorktreeReviewEditor } from './worktree-review-bindings';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import type { WorktreeReviewSendApi } from './worktree-review-send';
import {
  getWorktreeReviewFreshness,
  sameWorktreeReviewCapture,
  serializeWorktreeReview,
  type WorktreeReviewCapture,
  type WorktreeReviewComment,
} from './worktree-review';
import {
  verifyWorktreeReviewComment,
  type WorktreeReviewVerification,
} from './worktree-review-verify';
import {
  createWorktreeReviewDraft,
  createWorktreeReviewStore,
  currentWorktreeReviewCapture,
  getWorktreeReviewSourceSessionIds,
  hasPendingWorktreeReview,
  worktreeReviewSavedReadOptions,
  worktreeReviewScopeKey,
  type WorktreeReviewScope,
} from './worktree-review-state';
import { createWorktreeReviewPersistence } from './worktree-review-persistence';

export type WorktreeReviewDestination = {
  sessionId: string;
  cloudAgentSessionId: string;
  title: string;
};

const WORKTREE_REVIEW_UNVERIFIED_RETRY_DELAYS_MS = [1_000, 3_000];

type WorktreeReviewVerificationRecord = {
  signature: string;
  phase: 'inflight' | 'settled';
};

function worktreeReviewVerificationSignature(
  comment: WorktreeReviewComment,
  capture: WorktreeReviewCapture
): string {
  return JSON.stringify([
    comment.id,
    comment.anchor.path,
    comment.anchor.capture,
    comment.anchor.range,
    comment.anchor.quote,
    capture.revision,
    capture.capturedAt,
    capture.comparison,
  ]);
}

function worktreeReviewSnapshotVerificationKey(
  snapshot: {
    revision: number;
    capturedAt: string;
    comparison: { baseRef: string; mergeBase: string; head: string };
    files: readonly { path: string; revision: number }[];
  } | null
): string {
  if (!snapshot) return '';
  return JSON.stringify([
    snapshot.revision,
    snapshot.capturedAt,
    snapshot.comparison.baseRef,
    snapshot.comparison.mergeBase,
    snapshot.comparison.head,
    snapshot.files.map(file => [file.path, file.revision]),
  ]);
}

function deleteAbsentIds<T>(entries: Map<string, T>, liveIds: ReadonlySet<string>) {
  for (const id of entries.keys()) {
    if (!liveIds.has(id)) entries.delete(id);
  }
}

function pruneUnappliedVerifications(
  previous: ReadonlyMap<string, string>,
  liveIds: ReadonlySet<string>
): ReadonlyMap<string, string> {
  for (const id of previous.keys()) {
    if (liveIds.has(id)) continue;
    const next = new Map(previous);
    for (const staleId of next.keys()) {
      if (!liveIds.has(staleId)) next.delete(staleId);
    }
    return next;
  }
  return previous;
}

export function useWorktreeReview({
  userId,
  organizationId,
  worktreeId: selectedWorktreeId,
  activeKiloSessionId,
  activeSessionConfig,
  enabled,
  worktreeChats,
  deletingSessionIds,
  api,
  onAccepted,
}: {
  userId?: string;
  organizationId?: string;
  worktreeId: string | null;
  activeKiloSessionId: string | null;
  activeSessionConfig?: SessionConfig | null;
  enabled: boolean;
  worktreeChats: readonly StoredSession[];
  deletingSessionIds: readonly string[];
  api: WorktreeReviewSendApi;
  onAccepted: (destinationKiloSessionId: string) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const parsedWorktreeId = cloudAgentWorktreeIdSchema.safeParse(selectedWorktreeId);
  const worktreeId = parsedWorktreeId.success ? parsedWorktreeId.data : null;
  const deletingRef = useRef(deletingSessionIds);
  deletingRef.current = deletingSessionIds;
  const [store] = useState(() => createWorktreeReviewStore(createWorktreeReviewPersistence()));
  const drafts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const scope = useMemo<WorktreeReviewScope | null>(
    () =>
      userId && worktreeId
        ? {
            userId,
            organizationId,
            workspaceScope: `worktree:${worktreeId}`,
          }
        : null,
    [userId, organizationId, worktreeId]
  );
  const key = scope ? worktreeReviewScopeKey(scope) : null;
  const draft = useMemo(
    () => scope && (drafts.get(worktreeReviewScopeKey(scope)) ?? createWorktreeReviewDraft(scope)),
    [drafts, scope]
  );
  const hydration = key ? store.getHydration(key) : 'ready';
  useEffect(() => {
    if (scope) store.getDraft(scope);
  }, [scope, store]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const isOpen = key !== null && openKey === key;
  useEffect(() => {
    if (isOpen && (draft?.comments.length ?? 0) === 0) setOpenKey(null);
  }, [draft?.comments.length, isOpen]);
  const identity = JSON.stringify([userId, organizationId]);
  const identityRef = useRef({ identity, generation: 0 });
  if (identityRef.current.identity !== identity) {
    identityRef.current = { identity, generation: identityRef.current.generation + 1 };
  }
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const sessions = useQuery({
    ...trpc.cliSessionsV2.list.queryOptions(
      userId && worktreeId
        ? {
            organizationId: organizationId ?? null,
            worktreeId,
            limit: 200,
            orderBy: 'updated_at',
          }
        : skipToken
    ),
    enabled: enabled && Boolean(scope),
    staleTime: 0,
    retry: false,
  });
  const authoritativeSessions = sessions.isError ? [] : (sessions.data?.cliSessions ?? []);
  const destinations: WorktreeReviewDestination[] = enabled
    ? worktreeChats.flatMap(chat => {
        const saved = authoritativeSessions.find(
          session =>
            session.session_id === chat.sessionId &&
            session.organization_id === (organizationId ?? null) &&
            session.cloud_agent_worktree_id === worktreeId &&
            session.cloud_agent_session_id?.startsWith('workspace_') &&
            session.created_on_platform === 'cloud-agent-web' &&
            !session.parent_session_id
        );
        return saved?.cloud_agent_session_id && !deletingSessionIds.includes(chat.sessionId)
          ? [
              {
                sessionId: chat.sessionId,
                cloudAgentSessionId: saved.cloud_agent_session_id,
                title: chat.prompt,
              },
            ]
          : [];
      })
    : [];

  const sources = getWorktreeReviewSourceSessionIds(draft);
  const savedCaptures = useQueries({
    queries: sources.map(cloudAgentSessionId => {
      const options = organizationId
        ? trpc.organizations.cloudAgentNext.getWorktreeChanges.queryOptions({
            organizationId,
            cloudAgentSessionId,
          })
        : trpc.cloudAgentNext.getWorktreeChanges.queryOptions({ cloudAgentSessionId });
      return {
        ...options,
        ...worktreeReviewSavedReadOptions(options.queryFn),
        enabled: enabled && Boolean(scope),
        staleTime: 0,
        refetchOnMount: 'always' as const,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: false,
      };
    }),
  });
  const latestSnapshots = new Map(
    sources.map((source, index) => {
      const query = savedCaptures[index];
      const accessible = destinations.some(
        destination => destination.cloudAgentSessionId === source
      );
      return [
        source,
        scope && accessible && query?.isSuccess ? (query.data?.snapshot ?? null) : null,
      ] as const;
    })
  );
  const captures = new Map(
    sources.map(source => [
      source,
      scope ? currentWorktreeReviewCapture(scope, source, latestSnapshots.get(source)) : null,
    ])
  );
  const locked = Boolean(draft && draft.delivery.phase !== 'idle');
  const disabledReason = !enabled
    ? 'Reviews are available only in your editable worktree chats.'
    : hydration === 'pending'
      ? 'Restoring saved review…'
      : sessions.isError
        ? 'Could not verify access to this worktree. Reload the session list before sending.'
        : destinations.length === 0
          ? 'No eligible destination chat is available in this worktree.'
          : locked
            ? 'This review is locked until delivery is confirmed.'
            : undefined;

  const setEditor = (editor: WorktreeReviewEditor | null) => {
    if (scope && !locked && (!editor || !disabledReason)) store.setEditor(scope, editor);
  };
  const saveEditor = () => {
    if (scope && !disabledReason) store.saveEditor(scope, uuidv4());
  };
  const removeComment = (id: string) => {
    if (scope && !locked) return store.removeComment(scope, id);
    return false;
  };
  const discardDraft = () => {
    if (scope && !locked) {
      store.discardDraft(scope);
      setOpenKey(null);
    }
  };
  const bindings: WorktreeFileReviewBindings = {
    comments: draft?.comments ?? [],
    editor: draft?.editor ?? null,
    disabledReason,
    error: draft?.error,
    onEditorChange: setEditor,
    onSaveEditor: saveEditor,
    onRemoveComment: removeComment,
    onReplacePathComments: (path, comments) => {
      if (scope && !locked) store.replacePathComments(scope, path, comments);
    },
  };

  const fetchWorktreeReviewFile = async (
    source: string,
    { path, revision }: { path: string; revision: number }
  ) => {
    const options = organizationId
      ? trpc.organizations.cloudAgentNext.getWorktreeFile.queryOptions({
          organizationId,
          cloudAgentSessionId: source,
          path,
          expectedRevision: revision,
        })
      : trpc.cloudAgentNext.getWorktreeFile.queryOptions({
          cloudAgentSessionId: source,
          path,
          expectedRevision: revision,
        });
    return queryClient.fetchQuery(options);
  };

  const applyWorktreeReviewRebase = (
    dispatched: WorktreeReviewComment,
    rebased: WorktreeReviewComment
  ) => {
    if (!scope) return;
    const current = store.getDraft(scope);
    const existing = current.comments.find(comment => comment.id === dispatched.id);
    if (!existing || existing.anchor.path !== dispatched.anchor.path) return;
    if (!sameWorktreeReviewCapture(existing.anchor.capture, dispatched.anchor.capture)) return;
    const group = current.comments.filter(comment => comment.anchor.path === rebased.anchor.path);
    if (!group.some(comment => comment.id === rebased.id)) return;
    store.replacePathComments(
      scope,
      rebased.anchor.path,
      group.map(comment =>
        comment.id === rebased.id ? { ...comment, anchor: rebased.anchor } : comment
      )
    );
  };

  const verificationRecords = useRef(new Map<string, WorktreeReviewVerificationRecord>());
  const verificationScopeKey = useRef<string | null>(null);
  const capturesRef = useRef(captures);
  const snapshotsRef = useRef(latestSnapshots);
  const fetchFileRef = useRef(fetchWorktreeReviewFile);
  const applyRebaseRef = useRef(applyWorktreeReviewRebase);
  const isOpenRef = useRef(isOpen);
  const scopeKeyRef = useRef<string | null>(scope ? worktreeReviewScopeKey(scope) : null);
  const commentIdsRef = useRef(new Set((draft?.comments ?? []).map(comment => comment.id)));
  capturesRef.current = captures;
  snapshotsRef.current = latestSnapshots;
  fetchFileRef.current = fetchWorktreeReviewFile;
  applyRebaseRef.current = applyWorktreeReviewRebase;
  isOpenRef.current = isOpen;
  scopeKeyRef.current = scope ? worktreeReviewScopeKey(scope) : null;
  commentIdsRef.current = new Set((draft?.comments ?? []).map(comment => comment.id));
  const [unappliedVerifications, setUnappliedVerifications] = useState<ReadonlyMap<string, string>>(
    new Map()
  );
  const verificationInputKey = [...latestSnapshots.entries()]
    .map(([source, snapshot]) => `${source}\0${worktreeReviewSnapshotVerificationKey(snapshot)}`)
    .join('\n');
  useEffect(() => {
    const comments = draft?.comments ?? [];
    const liveIds = new Set(comments.map(comment => comment.id));
    const scopeKey = scope ? worktreeReviewScopeKey(scope) : null;
    if (verificationScopeKey.current !== scopeKey) {
      verificationScopeKey.current = scopeKey;
      verificationRecords.current.clear();
      setUnappliedVerifications(previous => (previous.size === 0 ? previous : new Map()));
    }
    deleteAbsentIds(verificationRecords.current, liveIds);
    setUnappliedVerifications(previous => pruneUnappliedVerifications(previous, liveIds));
    if (!isOpen || !scope || hydration !== 'ready') return;

    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const pendingRetries: Array<(retry: boolean) => void> = [];
    const started = new Map<string, string>();
    const releaseInflight = (id: string, signature: string) => {
      const current = verificationRecords.current.get(id);
      if (current?.phase === 'inflight' && current.signature === signature) {
        verificationRecords.current.delete(id);
      }
    };
    const forgetUnapplied = (id: string) => {
      setUnappliedVerifications(previous => {
        if (!previous.has(id)) return previous;
        const next = new Map(previous);
        next.delete(id);
        return next;
      });
    };
    const stillCurrent = (
      id: string,
      signature: string,
      source: string,
      capture: WorktreeReviewCapture
    ) => {
      if (cancelled || scopeKeyRef.current !== scopeKey || !commentIdsRef.current.has(id)) {
        return false;
      }
      const record = verificationRecords.current.get(id);
      if (!record || record.signature !== signature) return false;
      const currentCapture = capturesRef.current.get(source) ?? null;
      return currentCapture !== null && sameWorktreeReviewCapture(currentCapture, capture);
    };

    for (const comment of comments) {
      const source = comment.anchor.capture.sourceCloudAgentSessionId;
      const capture = capturesRef.current.get(source) ?? null;
      if (!capture || getWorktreeReviewFreshness(comment, capture) !== 'stale') continue;
      const snapshot = snapshotsRef.current.get(source);
      if (!snapshot) continue;
      const signature = worktreeReviewVerificationSignature(comment, capture);
      if (verificationRecords.current.get(comment.id)?.signature === signature) continue;
      verificationRecords.current.set(comment.id, { signature, phase: 'inflight' });
      started.set(comment.id, signature);
      const commentId = comment.id;
      void (async () => {
        for (let attempt = 0; ; attempt += 1) {
          if (!stillCurrent(commentId, signature, source, capture)) return;
          const fetchFile = fetchFileRef.current;
          const result: WorktreeReviewVerification = await verifyWorktreeReviewComment({
            comment,
            scope,
            snapshot,
            fetchFile: input => fetchFile(source, input),
          }).catch(() => ({ status: 'unverified' }));
          if (!stillCurrent(commentId, signature, source, capture)) return;
          if (result.status === 'applied') {
            verificationRecords.current.set(commentId, { signature, phase: 'settled' });
            applyRebaseRef.current(comment, result.comment);
            forgetUnapplied(commentId);
            return;
          }
          if (result.status === 'unapplied') {
            verificationRecords.current.set(commentId, { signature, phase: 'settled' });
            setUnappliedVerifications(previous =>
              previous.get(commentId) === signature
                ? previous
                : new Map(previous).set(commentId, signature)
            );
            return;
          }
          const delay = WORKTREE_REVIEW_UNVERIFIED_RETRY_DELAYS_MS[attempt];
          if (delay === undefined || !isOpenRef.current) {
            releaseInflight(commentId, signature);
            forgetUnapplied(commentId);
            return;
          }
          const retry = await new Promise<boolean>(resolve => {
            pendingRetries.push(resolve);
            const timer = setTimeout(() => {
              timers.delete(timer);
              resolve(!cancelled && isOpenRef.current);
            }, delay);
            timers.add(timer);
          });
          if (!retry || !stillCurrent(commentId, signature, source, capture)) {
            if (!cancelled) releaseInflight(commentId, signature);
            return;
          }
        }
      })();
    }

    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
      for (const resolve of pendingRetries) resolve(false);
      for (const [id, signature] of started) releaseInflight(id, signature);
    };
  }, [draft?.comments, hydration, isOpen, scope, verificationInputKey]);
  const unappliedCommentIds = new Set<string>();
  for (const comment of draft?.comments ?? []) {
    const signature = unappliedVerifications.get(comment.id);
    if (signature === undefined) continue;
    const capture = captures.get(comment.anchor.capture.sourceCloudAgentSessionId) ?? null;
    if (!capture || getWorktreeReviewFreshness(comment, capture) !== 'stale') continue;
    if (worktreeReviewVerificationSignature(comment, capture) !== signature) continue;
    unappliedCommentIds.add(comment.id);
  }

  const pending = [...drafts.values()].some(hasPendingWorktreeReview);
  useEffect(() => {
    if (!pending) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const beforeLinkNavigation = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (
        !(link instanceof HTMLAnchorElement) ||
        link.hasAttribute('download') ||
        (link.target && link.target !== '_self')
      )
        return;
      const next = new URL(link.href, window.location.href);
      const nextSessionId = next.searchParams.get('sessionId');
      if (
        next.origin === window.location.origin &&
        next.pathname === window.location.pathname &&
        (!nextSessionId || isNewSession(nextSessionId))
      )
        return;
      if (
        window.confirm(
          'Leave this page? Unsent review comments are saved in this browser; unresolved delivery state will be lost.'
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', beforeLinkNavigation, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', beforeLinkNavigation, true);
    };
  }, [pending]);

  const canSubmit = enabled && !deletingSessionIds.includes(draft?.destinationKiloSessionId ?? '');
  const send = async () => {
    if (!scope || !draft || !canSubmit || !worktreeId) return;
    const generation = identityRef.current.generation;
    const isScopeCurrent = () =>
      mounted.current &&
      identityRef.current.identity === identity &&
      identityRef.current.generation === generation;
    await store.send({
      scope,
      activeKiloSessionId,
      activeSessionConfig,
      isScopeCurrent,
      prepare: async (frozenDraft, configuration) => {
        const [latestSessions, latestCaptures] = await Promise.all([
          sessions.refetch(),
          Promise.all(savedCaptures.map(query => query.refetch())),
        ]);
        const target =
          latestSessions.isSuccess &&
          latestSessions.data?.cliSessions.find(
            session =>
              session.session_id === frozenDraft.destinationKiloSessionId &&
              session.organization_id === (organizationId ?? null) &&
              session.cloud_agent_worktree_id === worktreeId &&
              session.cloud_agent_session_id?.startsWith('workspace_') &&
              session.created_on_platform === 'cloud-agent-web' &&
              !session.parent_session_id
          );
        if (!target || deletingRef.current.includes(target.session_id)) {
          return {
            ok: false,
            error:
              'The selected chat is no longer available. Choose an eligible chat in this worktree.',
          };
        }
        const latestSnapshotFor = (source: string) => {
          const index = sources.indexOf(source);
          const latest = index < 0 ? undefined : latestCaptures[index];
          const accessible =
            latestSessions.isSuccess &&
            latestSessions.data?.cliSessions.some(
              session => session.cloud_agent_session_id === source
            );
          return accessible && latest?.isSuccess ? (latest.data?.snapshot ?? null) : null;
        };
        const rebased: WorktreeReviewComment[] = [];
        for (const comment of frozenDraft.comments) {
          const source = comment.anchor.capture.sourceCloudAgentSessionId;
          const result = await verifyWorktreeReviewComment({
            comment,
            scope,
            snapshot: latestSnapshotFor(source),
            fetchFile: input => fetchWorktreeReviewFile(source, input),
          });
          if (result.status === 'applied') rebased.push(result.comment);
        }
        if (rebased.length !== frozenDraft.comments.length) {
          return {
            ok: false,
            error:
              'Some comments could not be applied to the current saved capture. Remove or update them before sending.',
          };
        }
        const serialized = serializeWorktreeReview(rebased, {
          overall: frozenDraft.overall,
        });
        if (!serialized.ok) return serialized;
        if (!isScopeCurrent())
          return { ok: false, error: 'The account or organization changed. Review was not sent.' };
        const submission = await api.prepareReviewSubmission({
          destinationKiloSessionId: target.session_id,
          expectedWorktreeId: worktreeId,
          prompt: serialized.value,
          configuration,
        });
        if (deletingRef.current.includes(target.session_id)) {
          return { ok: false, error: 'The selected chat is being deleted. Review was not sent.' };
        }
        return { ok: true, value: submission };
      },
      submit: api.submitReview,
      onAccepted: destination => {
        setOpenKey(null);
        onAccepted(destination);
      },
    });
  };

  useEffect(() => {
    if (!scope || !key || !isOpen || hydration === 'pending') return;
    const current = store.getDraft(scope);
    if (current.delivery.phase !== 'idle') return;
    if (
      current.destinationKiloSessionId &&
      destinations.some(destination => destination.sessionId === current.destinationKiloSessionId)
    )
      return;
    if (destinations.length === 1) store.setDestination(scope, destinations[0].sessionId);
  }, [destinations, hydration, isOpen, key, scope, store]);

  return {
    scope,
    draft,
    bindings,
    destinations,
    unappliedCommentIds,
    locked,
    disabledReason,
    canSubmit,
    visible: Boolean(scope && (draft?.comments.length ?? 0) > 0),
    open: isOpen,
    setOpen(open: boolean) {
      setOpenKey(open ? key : null);
    },
    setDestination(destination: string) {
      if (scope && destinations.some(candidate => candidate.sessionId === destination))
        store.setDestination(scope, destination);
    },
    setAllowOlderCapture(allow: boolean) {
      if (scope) store.setAllowOlderCapture(scope, allow);
    },
    setOverall(overall: string) {
      if (scope) store.setOverall(scope, overall);
    },
    editComment(comment: WorktreeReviewComment) {
      setEditor({ commentId: comment.id, anchor: comment.anchor, text: comment.text });
    },
    removeComment,
    discardDraft,
    setEditor,
    saveEditor,
    send,
  };
}
