import { useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { toast } from 'sonner-native';

import { SheetHeader } from '@/components/sheet-header';
import { Text } from '@/components/ui/text';
import {
  buildFailureText,
  buildSummaryLabel,
  environmentBuildAction,
  type EnvironmentBuildStatusRow,
  isBuildActive,
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
        refetchInterval: query =>
          isBuildActive(status?.activeBuild) && query.state.data?.complete !== true
            ? BUILD_POLL_MS
            : false,
      }
    )
  );
  const isSubmitting = requestBuild.isPending || cancelBuild.isPending;
  const action = environmentBuildAction(status, { canManage }, t);
  const failure = buildFailureText(
    status?.activeBuild?.failureReason ?? status?.latestBuild?.failureReason ?? null,
    t
  );

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
                  requestId: randomUUID(),
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
