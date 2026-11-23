import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { SheetHeader } from '@/components/sheet-header';
import { useConfirmDialog } from '@/components/ui/dialog';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { getShareFailureKind, shareRemoteFile } from '@/lib/share-remote-file';
import { isRetryableTrpcError } from '@/lib/trpc-error';
import { useKeyedSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { assertSurfaceFailureHandled } from '@/lib/surface-feedback';
import { trpcClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';

import {
  type ArtifactFailure,
  type ArtifactPending,
  SessionArtifactsBody,
  type SessionArtifactsState,
} from './session-artifacts-body';
import {
  groupWorkspaceArtifactsByFolder,
  isSandboxNotRunning,
  type WorkspaceArtifactEntry,
  workspaceArtifactFileName,
} from './session-artifacts-grouping';
import { SessionPageSheet } from '../session-page-sheet';
import { useSessionArtifacts } from './use-session-artifacts';

/** The cache directory the shared share sheet writes a downloaded artifact into. */
const ARTIFACTS_CACHE_DIRECTORY = 'session-artifacts';

/**
 * The one state the body paints, from the two reads' own readings. A list that
 * has not answered is loading before it is an error: a retry can still settle
 * the first read, and the body keeps offering that retry only when the failure
 * itself says asking again can help.
 */
function selectArtifactsState({
  entries,
  error,
  hasData,
  isError,
  sandboxNotRunning,
  rootLabel,
}: {
  entries: readonly WorkspaceArtifactEntry[];
  error: unknown;
  hasData: boolean;
  isError: boolean;
  sandboxNotRunning: boolean;
  rootLabel: string;
}): SessionArtifactsState {
  if (!hasData) {
    return isError
      ? { kind: 'load-error', retryable: isRetryableTrpcError(error) }
      : { kind: 'loading' };
  }
  if (entries.length === 0) {
    return { kind: 'empty', sandboxNotRunning };
  }
  return {
    kind: 'loaded',
    groups: groupWorkspaceArtifactsByFolder(entries, rootLabel),
    fileCount: entries.length,
    sandboxNotRunning,
  };
}

type SessionArtifactsSheetProps = {
  visible: boolean;
  onClose: () => void;
  cloudAgentSessionId: string;
  /** Set for an organization-owned session, which reads through its own router. */
  organizationId: string | undefined;
};

/**
 * A session's saved artifacts: the files the worker kept from its /artifacts
 * folder, grouped by folder, each one downloadable to the phone's share sheet
 * or removable.
 *
 * This is the container. It owns the two reads, the confirmation, the two
 * actions and the single phase each row reports; `SessionArtifactsBody` paints
 * the result and owns nothing of its own, so the design gate can render it
 * through a fixture with the props a real session produces.
 */
export function SessionArtifactsSheet({
  visible,
  onClose,
  cloudAgentSessionId,
  organizationId,
}: Readonly<SessionArtifactsSheetProps>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { confirm, dialog } = useConfirmDialog();
  const { list, sandboxStatus, refetch } = useSessionArtifacts({
    cloudAgentSessionId,
    organizationId,
    enabled: visible,
  });
  // One action per row at a time. The key names the action as well as the file,
  // so a row's spinner and its failure line can never be read as the other
  // action's, and the row's own frame carries the busy spinner.
  const { snapshot, begin } = useKeyedSurfaceFeedback<string, ArtifactFailure>();

  const removeArtifact = useMutation({
    mutationFn: (entry: WorkspaceArtifactEntry) => {
      const input = {
        cloudAgentSessionId,
        relativePath: entry.relativePath,
        expectedHash: entry.contentHash,
      };
      return organizationId === undefined
        ? trpcClient.cloudAgentNext.deleteWorkspaceArtifact.mutate(input)
        : trpcClient.organizations.cloudAgentNext.deleteWorkspaceArtifact.mutate({
            ...input,
            organizationId,
          });
    },
    onError: error => {
      toast.error(error.message);
    },
  });

  const mintDownloadUrl = useMutation({
    mutationFn: (entry: WorkspaceArtifactEntry) => {
      const input = { cloudAgentSessionId, relativePath: entry.relativePath };
      return organizationId === undefined
        ? trpcClient.cloudAgentNext.getWorkspaceArtifactDownloadUrl.query(input)
        : trpcClient.organizations.cloudAgentNext.getWorkspaceArtifactDownloadUrl.query({
            ...input,
            organizationId,
          });
    },
    retry: false,
  });

  const listRefetch = list.refetch;
  // The worker writes a file while a turn runs, so the sheet re-reads the list
  // each time it opens rather than trusting the copy the last open left behind.
  useEffect(() => {
    if (visible) {
      refetch();
    }
  }, [visible, refetch]);

  const entries = list.data?.entries ?? [];
  const sandboxNotRunning = isSandboxNotRunning(sandboxStatus.data?.status);
  const state: SessionArtifactsState = selectArtifactsState({
    entries,
    error: list.error,
    isError: list.isError,
    hasData: list.data !== undefined,
    sandboxNotRunning,
    rootLabel: t('cloudAgent.artifacts.title'),
  });

  function downloadKey(relativePath: string): string {
    return `download:${relativePath}`;
  }

  function deleteKey(relativePath: string): string {
    return `delete:${relativePath}`;
  }

  const failureOf = (relativePath: string): ArtifactFailure | null => {
    for (const key of [downloadKey(relativePath), deleteKey(relativePath)]) {
      const reported = snapshot.states.get(key);
      if (reported?.status === 'failed') {
        return reported.failure;
      }
    }
    return null;
  };

  const pendingOf = (relativePath: string): ArtifactPending | null => {
    if (snapshot.states.get(downloadKey(relativePath))?.status === 'pending') {
      return 'download';
    }
    if (snapshot.states.get(deleteKey(relativePath))?.status === 'pending') {
      return 'delete';
    }
    return null;
  };

  async function download(entry: WorkspaceArtifactEntry) {
    const key = downloadKey(entry.relativePath);
    if (pendingOf(entry.relativePath) !== null) {
      return;
    }
    const attempt = begin(key);
    if (attempt === null) {
      return;
    }
    const fileName = workspaceArtifactFileName(entry);
    let url = '';
    try {
      const minted = await mintDownloadUrl.mutateAsync(entry);
      url = minted.url;
    } catch {
      // A link that could not be minted is this row's own failure, so it is
      // reported under the row instead of as a toast over the sheet's content.
      attempt.fail({ kind: 'download-failed', fileName });
      return;
    }
    try {
      await shareRemoteFile({
        url,
        cacheDirectoryName: ARTIFACTS_CACHE_DIRECTORY,
        cacheKey: entry.relativePath,
        filename: fileName,
      });
    } catch (error) {
      // A device with no share sheet, a file the server no longer has and an
      // unknown transfer failure differ in what the reader can do, and the row
      // reports the one sentence the copy names for all of them.
      const kind = getShareFailureKind(error);
      switch (kind) {
        case 'sharing-unavailable':
        case 'file-unavailable':
        case 'retry':
        case 'general': {
          attempt.fail({ kind: 'download-share-failed', fileName });
          break;
        }
        default: {
          assertSurfaceFailureHandled(kind);
        }
      }
      return;
    }
    // A share that opened leaves no line: the platform sheet is its own result.
    attempt.abandon();
  }

  async function remove(entry: WorkspaceArtifactEntry) {
    const key = deleteKey(entry.relativePath);
    if (pendingOf(entry.relativePath) !== null) {
      return;
    }
    const attempt = begin(key);
    if (attempt === null) {
      return;
    }
    const fileName = workspaceArtifactFileName(entry);
    let status: 'deleted' | 'absent' | 'hash_mismatch' = 'absent';
    try {
      const result = await removeArtifact.mutateAsync(entry);
      status = result.status;
    } catch {
      // The mutation's own handler already raised the server's sentence, and one
      // surface owns that report: the row leaves no line of its own.
      attempt.abandon();
      return;
    }
    // A file that changed under this list is kept: the hash the reader approved
    // is what proves they saw this exact version, so the refreshed list is the
    // one they can approve again.
    if (status === 'hash_mismatch') {
      attempt.fail({ kind: 'delete-changed', fileName });
    } else {
      attempt.abandon();
    }
    void listRefetch();
  }

  function requestDelete(entry: WorkspaceArtifactEntry) {
    const fileName = workspaceArtifactFileName(entry);
    confirm({
      title: t('cloudAgent.artifacts.deleteConfirmTitle', { fileName }),
      message: t('cloudAgent.artifacts.deleteConfirmBody'),
      confirmLabel: t('cloudAgent.artifacts.deleteConfirmAction'),
      cancelLabel: t('common.cancel'),
      onConfirm: () => {
        void remove(entry);
      },
    });
  }

  return (
    <SessionPageSheet visible={visible} onClose={onClose} dismissible>
      <SheetHeader
        title={t('cloudAgent.artifacts.title')}
        onDone={onClose}
        topInset="ios-page-sheet"
      />
      <ScrollView className="flex-1" contentContainerClassName={cn(SCREEN_BODY_CLASS, 'pb-6')}>
        <SessionArtifactsBody
          state={state}
          onRetry={() => {
            refetch();
          }}
          onRefresh={refetch}
          refreshing={list.isFetching || sandboxStatus.isFetching}
          onDownload={entry => {
            void download(entry);
          }}
          onDelete={requestDelete}
          failureOf={failureOf}
          pendingOf={pendingOf}
        />
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
      {dialog}
    </SessionPageSheet>
  );
}
