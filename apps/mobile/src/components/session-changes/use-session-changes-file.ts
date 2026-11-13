// One changed file of a session: its saved patch, the capture a comment
// records, and the draft comments that anchor to it.

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  sessionChangesCaptureForFile,
  sessionChangesCommentsForFile,
  type SessionChangesDraft,
  type SessionChangesFile,
  sessionChangesFilePatch,
  type SessionChangesSnapshot,
} from '@/lib/session-changes-review';
import { trpcClient } from '@/lib/trpc';

export function useSessionChangesFile({
  openFile,
  snapshot,
  changesKey,
  cloudAgentSessionId,
  organizationId,
  userId,
  worktreeId,
  draft,
}: {
  openFile: SessionChangesFile | null;
  snapshot: SessionChangesSnapshot | null;
  changesKey: readonly unknown[];
  cloudAgentSessionId: string | null;
  organizationId: string | undefined;
  userId: string | undefined;
  worktreeId: string | null | undefined;
  draft: SessionChangesDraft;
}) {
  const fileRevision = useMemo(() => {
    if (openFile === null) {
      return undefined;
    }
    const listed = snapshot?.files.find(
      entry => entry.path === openFile.path && entry.scope === openFile.scope
    );
    return listed?.revision ?? snapshot?.revision;
  }, [openFile, snapshot]);

  const fileKey = [
    ...changesKey,
    'file',
    openFile?.path ?? '',
    openFile?.scope ?? '',
    fileRevision ?? 0,
  ] as const;
  const fileQuery = useQuery({
    queryKey: fileKey,
    queryFn: () => {
      if (cloudAgentSessionId === null || openFile === null || fileRevision === undefined) {
        throw new Error('No worktree file to read');
      }
      const input = {
        cloudAgentSessionId,
        path: openFile.path,
        expectedRevision: fileRevision,
        ...(openFile.scope ? { scope: openFile.scope } : {}),
      };
      return organizationId
        ? trpcClient.organizations.cloudAgentNext.getWorktreeFile.query({
            ...input,
            organizationId,
          })
        : trpcClient.cloudAgentNext.getWorktreeFile.query(input);
    },
    enabled: cloudAgentSessionId !== null && openFile !== null && fileRevision !== undefined,
  });
  const patchState = sessionChangesFilePatch(fileQuery.data);

  const capture = useMemo(() => {
    if (
      openFile === null ||
      snapshot === null ||
      cloudAgentSessionId === null ||
      userId === undefined
    ) {
      return null;
    }
    return sessionChangesCaptureForFile({
      userId,
      organizationId,
      cloudAgentSessionId,
      worktreeId,
      snapshot,
      file: openFile,
    });
  }, [openFile, snapshot, cloudAgentSessionId, userId, worktreeId, organizationId]);

  const commentsForFile = useMemo(
    () => (openFile === null ? [] : sessionChangesCommentsForFile(draft, openFile)),
    [draft, openFile]
  );

  return { fileQuery, patchState, capture, commentsForFile };
}
