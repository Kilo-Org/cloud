import { useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { toast } from 'sonner-native';

import { SheetHeader } from '@/components/sheet-header';
import { Text } from '@/components/ui/text';
import { createBuildRequestIds } from '@/lib/cloud-environments/build-request-id';
import {
  buildFailureText,
  buildSummaryLabel,
  environmentBuildAction,
  type EnvironmentBuildStatusRow,
} from '@/lib/cloud-environments/environment-build-copy';
import { type EnvironmentSummaryRow } from '@/lib/cloud-environments/environment-selection';
import { formatDate } from '@/lib/format';
import { useTRPC } from '@/lib/trpc';

import {
  BuildControl,
  BuildLogSection,
  BuildStatusPending,
} from './environment-build-detail-parts';

const BUILD_POLL_MS = 3_000;

/** A server rejection names itself; an empty one falls back to the action's copy. */
function failureToast(message: string, fallback: string): string {
  return message.length > 0 ? message : fallback;
}

type EnvironmentBuildDetailProps = {
  environment: EnvironmentSummaryRow;
  status: EnvironmentBuildStatusRow | undefined;
  buildStatusFailed: boolean;
  organizationId: string | undefined;
  onRetryBuildStatus: () => void;
  onBack: () => void;
  /** Commits the pick: the sheet's Done both closes and chooses. */
  onClose: () => void;
};

/**
 * One environment's snapshot build: what it is doing, how it ended, its log, and
 * the one control the web offers. A build is manager-only, so a member of an
 * organization that cannot manage reads the state and gets the reason instead of
 * a control the server would refuse.
 */
export function EnvironmentBuildDetail({
  environment,
  status,
  buildStatusFailed,
  organizationId,
  onRetryBuildStatus,
  onBack,
  onClose,
}: Readonly<EnvironmentBuildDetailProps>) {
  const { t, i18n } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const scope = organizationId ? { organizationId } : {};
  const [logsOpen, setLogsOpen] = useState(false);
  // The attempt's request id survives a lost answer, so a retried Build cannot
  // start a second build (see `createBuildRequestIds`).
  const [requestIds] = useState(() => createBuildRequestIds(randomUUID));
  const canManageQuery = useQuery(trpc.cloudAgentSettings.canManage.queryOptions(scope));
  const canManage = canManageQuery.data?.canManage ?? false;
  const buildId = status?.activeBuild?.buildId ?? status?.latestBuild?.buildId ?? null;
  const requestBuild = useMutation(
    trpc.cloudEnvironments.build.mutationOptions({
      onSuccess: result => {
        void queryClient.invalidateQueries({
          queryKey: trpc.cloudEnvironments.buildStatus.queryKey(),
        });
        if (result.status === 'accepted') {
          toast.success(t('agentChat.environment.buildStarted'));
        } else {
          toast.error(t('agentChat.environment.couldNotStartBuild'));
        }
      },
      onError: error => {
        toast.error(failureToast(error.message, t('agentChat.environment.couldNotStartBuild')));
      },
      onSettled: (_result, _error, variables) => {
        requestIds.answered(variables.environmentId, variables.expectedRevision);
      },
    })
  );
  const cancelBuild = useMutation(
    trpc.cloudEnvironments.cancelBuild.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.cloudEnvironments.buildStatus.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.cloudEnvironments.buildLogs.queryKey(),
        });
        toast.success(t('agentChat.environment.buildCanceled'));
      },
      onError: error => {
        toast.error(failureToast(error.message, t('agentChat.environment.couldNotCancelBuild')));
      },
    })
  );
  const logsQuery = useQuery(
    trpc.cloudEnvironments.buildLogs.queryOptions(
      { environmentId: environment.id, buildId: buildId ?? '', ...scope },
      {
        // A build log is manager-only on both sides: this sheet never asks for a
        // log its reader could not be shown.
        enabled: logsOpen && buildId !== null && canManage,
        // The log, not the build status, decides when to stop: a build that
        // finishes between two status polls would otherwise freeze the sheet at
        // the lines fetched before it ended, and the tail — the part that says
        // how it failed — is exactly what the person opened the log for. A
        // terminal build answers `complete` on the first read.
        refetchInterval: query => (query.state.data?.complete === true ? false : BUILD_POLL_MS),
      }
    )
  );
  const isSubmitting = requestBuild.isPending || cancelBuild.isPending;
  const action = environmentBuildAction(status, { canManage }, t);
  // The sentence explains a failure, so it appears only where a build ended in
  // one: a canceled build reads "Cancelled" and is not a failure, which is the
  // same place the web shows it.
  const endedBuild = status?.activeBuild === null ? status.latestBuild : null;
  const failure =
    endedBuild !== null && (endedBuild.state === 'failed' || endedBuild.state === 'obsolete')
      ? buildFailureText(endedBuild.failureReason, t)
      : null;

  return (
    <>
      <SheetHeader
        title={environment.name}
        onCancel={onBack}
        cancelLabel={t('common.back')}
        onDone={onClose}
        doneDisabled={isSubmitting}
      />
      <View className="gap-3 px-4 pb-4">
        {status === undefined ? (
          <BuildStatusPending failed={buildStatusFailed} onRetry={onRetryBuildStatus} />
        ) : (
          <>
            <Text className="text-sm font-medium text-foreground">
              {buildSummaryLabel(status, t)}
            </Text>
            {failure === null ? null : <Text className="text-sm text-destructive">{failure}</Text>}
            {status.published === null ? null : (
              <Text className="text-sm text-muted-foreground">
                {t('agentChat.environment.snapshotCaptured', {
                  when: formatDate(new Date(status.published.capturedAt), i18n.language, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }),
                })}
              </Text>
            )}
            {canManage && buildId !== null ? (
              <BuildLogSection
                open={logsOpen}
                onToggle={() => {
                  setLogsOpen(current => !current);
                }}
                lines={logsQuery.data?.lines ?? []}
                truncated={logsQuery.data?.truncated === true}
                isLoading={logsQuery.isLoading}
                isError={logsQuery.isError}
                onRetry={() => {
                  void logsQuery.refetch();
                }}
              />
            ) : null}
            <BuildControl
              action={action}
              isSubmitting={isSubmitting}
              onBuild={() => {
                requestBuild.mutate({
                  environmentId: environment.id,
                  expectedRevision: status.configurationRevision,
                  requestId: requestIds.forAttempt(environment.id, status.configurationRevision),
                  ...scope,
                });
              }}
              onCancel={buildIdToCancel => {
                cancelBuild.mutate({
                  environmentId: environment.id,
                  buildId: buildIdToCancel,
                  ...scope,
                });
              }}
            />
          </>
        )}
      </View>
    </>
  );
}
