'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { skipToken, useQueries, useQuery } from '@tanstack/react-query';
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
  serializeWorktreeReview,
  type WorktreeReviewComment,
} from './worktree-review';
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

export type WorktreeReviewDestination = {
  sessionId: string;
  cloudAgentSessionId: string;
  title: string;
};

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
  const parsedWorktreeId = cloudAgentWorktreeIdSchema.safeParse(selectedWorktreeId);
  const worktreeId = parsedWorktreeId.success ? parsedWorktreeId.data : null;
  const deletingRef = useRef(deletingSessionIds);
  deletingRef.current = deletingSessionIds;
  const [store] = useState(createWorktreeReviewStore);
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
  const [openKey, setOpenKey] = useState<string | null>(null);
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
  const captures = new Map(
    sources.map((source, index) => {
      const query = savedCaptures[index];
      const accessible = destinations.some(
        destination => destination.cloudAgentSessionId === source
      );
      return [
        source,
        scope && accessible && query?.isSuccess
          ? currentWorktreeReviewCapture(scope, source, query.data?.snapshot)
          : null,
      ] as const;
    })
  );
  const freshness = new Map(
    draft?.comments.map(comment => [
      comment.id,
      getWorktreeReviewFreshness(
        comment,
        captures.get(comment.anchor.capture.sourceCloudAgentSessionId) ?? null
      ),
    ])
  );
  const olderCommentIds =
    draft?.comments
      .filter(comment => freshness.get(comment.id) !== 'current')
      .map(comment => comment.id) ?? [];
  const locked = Boolean(draft && draft.delivery.phase !== 'idle');
  const disabledReason = !enabled
    ? 'Reviews are available only in your editable worktree chats.'
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
  const bindings: WorktreeFileReviewBindings = {
    comments: draft?.comments ?? [],
    editor: draft?.editor ?? null,
    disabledReason,
    error: draft?.error,
    onEditorChange: setEditor,
    onSaveEditor: saveEditor,
    onRemoveComment: removeComment,
  };

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
          'Leave this page? Unsent review comments and unresolved delivery state are stored only in memory and will be lost.'
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
        const staleCommentIds = frozenDraft.comments
          .filter(comment => {
            const source = comment.anchor.capture.sourceCloudAgentSessionId;
            const latest = latestCaptures[sources.indexOf(source)];
            const sourceExists = latestSessions.data?.cliSessions.some(
              session => session.cloud_agent_session_id === source
            );
            return (
              getWorktreeReviewFreshness(
                comment,
                sourceExists && latest?.isSuccess
                  ? currentWorktreeReviewCapture(scope, source, latest.data?.snapshot)
                  : null
              ) !== 'current'
            );
          })
          .map(comment => comment.id);
        const serialized = serializeWorktreeReview(frozenDraft.comments, {
          allowOlderCapture: frozenDraft.allowOlderCapture,
          staleCommentIds,
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

  return {
    scope,
    draft,
    bindings,
    destinations,
    freshness,
    olderCommentIds,
    locked,
    disabledReason,
    canSubmit,
    visible: Boolean(
      scope && (destinations.length > 0 || (draft && hasPendingWorktreeReview(draft)))
    ),
    open: key !== null && openKey === key,
    setOpen(open: boolean) {
      if (open && scope) {
        const current = store.getDraft(scope);
        if (current.delivery.phase === 'idle' && !current.destinationKiloSessionId) {
          store.setDestination(
            scope,
            destinations.find(destination => destination.sessionId === activeKiloSessionId)
              ?.sessionId ?? null
          );
        }
      }
      setOpenKey(open ? key : null);
    },
    setDestination(destination: string) {
      if (scope && destinations.some(candidate => candidate.sessionId === destination))
        store.setDestination(scope, destination);
    },
    setAllowOlderCapture(allow: boolean) {
      if (scope) store.setAllowOlderCapture(scope, allow);
    },
    editComment(comment: WorktreeReviewComment) {
      setEditor({ commentId: comment.id, anchor: comment.anchor, text: comment.text });
    },
    removeComment,
    setEditor,
    saveEditor,
    send,
  };
}
