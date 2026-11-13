import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Text } from '@/components/ui/text';
import {
  sandboxDetailText,
  sandboxStatusLabel,
  sandboxStatusSettled,
} from '@/lib/cloud-environments/sandbox-status-copy';
import { workspaceSnapshotRecoveryOffered } from '@/lib/cloud-environments/workspace-snapshot-recovery';
import { formatDate } from '@/lib/format';
import { trpcClient, useTRPC } from '@/lib/trpc';

/**
 * The worker's own status is a snapshot, and a sandbox that is running or
 * changing hands moves between states on its own. Once it settles — asleep
 * until the next message, or failed — the snapshot stops moving, so the poll
 * stops with it instead of re-reading a dead session every 15 seconds.
 */
const SANDBOX_POLL_MS = 15_000;

type SessionSandboxSectionProps = {
  /** The control-plane session id (`workspace_…`); null for a stored-only session. */
  cloudAgentSessionId: string | null;
  organizationId: string | undefined;
  /**
   * The session's start failed. Only then does the web offer to discard the
   * workspace snapshot: the failure is what makes a fresh start the way out,
   * and the discarded changes are the ones that start could not use.
   */
  startFailed: boolean;
};

/**
 * The sandbox block of the session sheet: which sandbox the session runs on,
 * what its state means, and — after a failed start — the same recovery the web
 * offers, a fresh start that discards the workspace snapshot.
 *
 * The status is the worker's snapshot, not a live probe, so the row names when
 * it was observed instead of implying it is current to the second.
 */
export function SessionSandboxSection({
  cloudAgentSessionId,
  organizationId,
  startFailed,
}: Readonly<SessionSandboxSectionProps>) {
  const { t, i18n } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const sessionId = cloudAgentSessionId ?? '';
  const statusQuery = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.getSandboxStatus.queryOptions(
          { cloudAgentSessionId: sessionId, organizationId },
          {
            enabled: cloudAgentSessionId !== null,
            refetchInterval: query =>
              sandboxStatusSettled(query.state.data?.status) ? false : SANDBOX_POLL_MS,
            retry: false,
          }
        )
      : trpc.cloudAgentNext.getSandboxStatus.queryOptions(
          { cloudAgentSessionId: sessionId },
          {
            enabled: cloudAgentSessionId !== null,
            refetchInterval: query =>
              sandboxStatusSettled(query.state.data?.status) ? false : SANDBOX_POLL_MS,
            retry: false,
          }
        )
  );
  const recoveryQuery = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.getWorkspaceSnapshotRecovery.queryOptions(
          { sessionId, organizationId },
          { enabled: cloudAgentSessionId !== null && startFailed, retry: false, staleTime: 0 }
        )
      : trpc.cloudAgentNext.getWorkspaceSnapshotRecovery.queryOptions(
          { sessionId },
          { enabled: cloudAgentSessionId !== null && startFailed, retry: false, staleTime: 0 }
        )
  );
  const removeSnapshot = useMutation({
    mutationFn: () => {
      if (organizationId) {
        return trpcClient.organizations.cloudAgentNext.removeWorkspaceSnapshot.mutate({
          sessionId,
          organizationId,
        });
      }
      return trpcClient.cloudAgentNext.removeWorkspaceSnapshot.mutate({ sessionId });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries(
        organizationId
          ? { queryKey: trpc.organizations.cloudAgentNext.getWorkspaceSnapshotRecovery.queryKey() }
          : { queryKey: trpc.cloudAgentNext.getWorkspaceSnapshotRecovery.queryKey() }
      );
      toast.success(t('agentChat.environment.startFreshDone'));
    },
    onError: error => {
      toast.error(
        error.message.length > 0 ? error.message : t('agentChat.environment.couldNotRemoveSnapshot')
      );
    },
  });

  if (cloudAgentSessionId === null) {
    return null;
  }
  const data = statusQuery.data;
  const detail = data === undefined ? null : sandboxDetailText(data.detailCode, t);
  // The snapshot this failure would discard, from an answer about this failure.
  const recovery = workspaceSnapshotRecoveryOffered({
    startFailed,
    recovery: recoveryQuery.data,
    recoveryIsFresh: recoveryQuery.isSuccess && !recoveryQuery.isFetching,
  });
  const capturedAt = recovery?.capturedAt ?? null;
  const capturedLabel =
    capturedAt === null
      ? null
      : formatDate(new Date(capturedAt), i18n.language, {
          dateStyle: 'medium',
          timeStyle: 'short',
        });
  const discard = () => {
    if (recovery === null) {
      return;
    }
    confirm({
      title: t('agentChat.environment.startFreshTitle'),
      message:
        capturedLabel === null
          ? t('agentChat.environment.startFreshMessageUnknown')
          : t('agentChat.environment.startFreshMessage', { when: capturedLabel }),
      confirmLabel: t('agentChat.environment.startFresh'),
      cancelLabel: t('common.cancel'),
      onConfirm: () => {
        removeSnapshot.mutate();
      },
    });
  };

  return (
    <View className="gap-2">
      <Text className="text-sm font-semibold text-foreground">
        {t('agentChat.environment.sandbox')}
      </Text>
      {data === undefined ? (
        <Text className="text-base font-medium text-foreground">
          {statusQuery.isError
            ? t('agentChat.environment.sandboxDetailUnavailable')
            : t('common.loading')}
        </Text>
      ) : (
        <>
          <Text className="text-base font-medium text-foreground">
            {sandboxStatusLabel(data.status, t)}
          </Text>
          {detail === null ? null : <Text className="text-sm text-muted-foreground">{detail}</Text>}
          <Text className="text-xs text-muted-foreground">
            {t('agentChat.environment.sandboxChecked', {
              when: formatDate(new Date(data.observedAt), i18n.language, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })}
          </Text>
        </>
      )}
      {recovery === null ? null : (
        <View className="gap-2">
          {capturedLabel === null ? null : (
            <Text className="text-sm text-muted-foreground">
              {t('agentChat.environment.snapshotCaptured', { when: capturedLabel })}
            </Text>
          )}
          <Button variant="outline" size="sm" loading={removeSnapshot.isPending} onPress={discard}>
            <Text>{t('agentChat.environment.startFresh')}</Text>
          </Button>
        </View>
      )}
      {dialog}
    </View>
  );
}
