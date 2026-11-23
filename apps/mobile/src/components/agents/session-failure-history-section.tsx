import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { KvRow } from '@/components/ui/kv-row';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { QueryError } from '@/components/query-error';
import { formatNumber } from '@/lib/format';
import { useKeyedSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { useTRPC } from '@/lib/trpc';

import { knownFailureCopy } from './preparation-copy';
import {
  failedRuns,
  failureHistoryCounts,
  failureMomentLabel,
  hasReportedFailures,
  isAddressableSessionId,
  isTerminalAccessError,
  retainedDiagnostic,
  type SessionFailureRun,
  type SessionSetupFailure,
  shouldRetryFailureHistory,
} from './session-failure-history-state';

/** Which export a press started, so its busy and failure states stay separate. */
type ExportFormat = 'json' | 'csv';

/** The export's own outcome. The catalog has one sentence for it. */
type ExportFailure = { readonly kind: 'export-failed' };

type SessionFailureHistorySectionProps = {
  /** The control-plane session id; null until the session row has loaded. */
  cloudAgentSessionId: string | null;
  /** The session screen is on-screen; its reads wait until it is. */
  visible: boolean;
};

/**
 * The failures a session recorded: the environment setup that failed, then one
 * row per failed run, with the diagnostics export beside them.
 *
 * The block sits above the transcript, so it paints nothing until there is
 * something to say — no heading, no placeholder — and a session that never
 * failed keeps the transcript where it was. The rows live in their own child so
 * the block can later collapse into its summary line without moving anything
 * else.
 */
export function SessionFailureHistorySection({
  cloudAgentSessionId,
  visible,
}: Readonly<SessionFailureHistorySectionProps>) {
  const { t, i18n } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const exportPhases = useKeyedSurfaceFeedback<ExportFormat, ExportFailure>();
  const sessionId = isAddressableSessionId(cloudAgentSessionId) ? cloudAgentSessionId : null;
  const history = useQuery(
    trpc.cloudAgentNextFailures.getSessionFailureHistory.queryOptions(
      { cloudAgentSessionId: sessionId ?? '' },
      {
        enabled: visible && sessionId !== null,
        staleTime: 30_000,
        retry: shouldRetryFailureHistory,
      }
    )
  );

  const jsonState = exportPhases.snapshot.states.get('json');
  const csvState = exportPhases.snapshot.states.get('csv');
  const exportFailure =
    (jsonState?.status === 'failed' ? jsonState.failure : null) ??
    (csvState?.status === 'failed' ? csvState.failure : null);
  const jsonBusy = jsonState?.status === 'pending';
  const csvBusy = csvState?.status === 'pending';

  const startExport = (format: ExportFormat) => {
    if (sessionId === null) {
      return;
    }
    const attempt = exportPhases.begin(format);
    if (attempt === null) {
      return;
    }
    void (async () => {
      try {
        const file = await queryClient.fetchQuery(
          trpc.cloudAgentNextFailures.exportSessionDiagnostics.queryOptions(
            { cloudAgentSessionId: sessionId, format },
            // Every press must export what the session holds now, not the
            // answer the previous press cached.
            { staleTime: 0 }
          )
        );
        // A newer press, or a dismissed block, owns the key now: this run
        // finishes without writing a file or publishing a phase.
        if (!attempt.owns()) {
          return;
        }
        // The native file system and the share sheet load here, at the press,
        // so the session screen stays mountable in a node test environment.
        const { shareDiagnosticsDocument } = await import('./session-diagnostics-export');
        if (!attempt.owns()) {
          return;
        }
        await shareDiagnosticsDocument(file, sessionId);
        // The share sheet is the outcome; there is nothing to paint.
        attempt.succeed();
      } catch {
        attempt.fail({ kind: 'export-failed' });
      }
    })();
  };

  if (sessionId === null) {
    return null;
  }
  if (history.status === 'pending') {
    return null;
  }
  const data = history.data;
  if (data === undefined) {
    return (
      <View className="px-4 pb-3" testID="session-failure-history">
        {isTerminalAccessError(history.error) ? (
          <Text variant="muted">{t('agentChat.failureHistory.accessDenied')}</Text>
        ) : (
          <QueryError
            placement="static"
            inset="none"
            compact
            title={t('agentChat.failureHistory.loadFailedTitle')}
            message={t('agentChat.failureHistory.loadFailedDescription')}
            onRetry={() => {
              void history.refetch();
            }}
            isRetrying={history.isFetching}
          />
        )}
      </View>
    );
  }
  if (!hasReportedFailures(data)) {
    return null;
  }

  const setup = data.setupFailure;
  const failed = failedRuns(data);
  const counts = failureHistoryCounts(data);

  return (
    <View className="px-4 pb-3" testID="session-failure-history">
      <Section label={t('agentChat.failureHistory.title')}>
        <Text variant="muted">
          {t('agentChat.failureHistory.summary', {
            failed: formatNumber(counts.failed, i18n.language),
            completed: formatNumber(counts.completed, i18n.language),
          })}
        </Text>
        <View className="gap-3">
          {setup === null ? null : (
            <View className="gap-2">
              <Text className="text-sm font-semibold text-foreground">
                {t('agentChat.preparation.stepFailed')}
              </Text>
              <RowGroup>
                <SetupFailureRow failure={setup} locale={i18n.language} />
              </RowGroup>
            </View>
          )}
          {failed.length === 0 ? null : (
            <View className="gap-2">
              <Text className="text-sm font-semibold text-foreground">
                {t('agentChat.failureHistory.messageFailures')}
              </Text>
              <RowGroup>
                {failed.map(run => (
                  <RunFailureRow key={run.messageId} run={run} locale={i18n.language} />
                ))}
              </RowGroup>
            </View>
          )}
        </View>
        <View className="flex-row gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            testID="session-failure-history-export-json"
            loading={jsonBusy}
            disabled={csvBusy}
            accessibilityLabel={
              jsonBusy
                ? t('agentChat.failureHistory.preparingJson')
                : t('agentChat.failureHistory.exportJson')
            }
            onPress={() => {
              startExport('json');
            }}
          >
            <Text>{t('agentChat.failureHistory.exportJson')}</Text>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            testID="session-failure-history-export-csv"
            loading={csvBusy}
            disabled={jsonBusy}
            accessibilityLabel={
              csvBusy
                ? t('agentChat.failureHistory.preparingCsv')
                : t('agentChat.failureHistory.exportCsv')
            }
            onPress={() => {
              startExport('csv');
            }}
          >
            <Text>{t('agentChat.failureHistory.exportCsv')}</Text>
          </Button>
        </View>
        {/* The line holds its height before a press: the failure arrives after
            the request, and a caption that appeared only then would push the
            copy below it down. */}
        <Text variant="caption">
          {exportFailure === null ? '\u00A0' : t('agentChat.failureHistory.exportFailed')}
        </Text>
        <Text variant="caption">{t('agentChat.failureHistory.fileDescription')}</Text>
        <Text variant="caption">
          {t('agentChat.failureHistory.retention', {
            limit: formatNumber(data.retention.historyRunLimit, i18n.language),
            window: formatNumber(data.retention.runWindowDays, i18n.language),
            days: formatNumber(data.retention.diagnosticDays, i18n.language),
          })}
        </Text>
      </Section>
    </View>
  );
}

/** The failed environment setup, named by the phase that failed. */
function SetupFailureRow({
  failure,
  locale,
}: Readonly<{ failure: SessionSetupFailure; locale: string }>) {
  const { t } = useTranslation();
  return (
    <KvRow
      label={
        knownFailureCopy(failure.code, t) ??
        failure.userVisibleError ??
        t('agentChat.failureHistory.setupFallback')
      }
      labelShrink
      value={failureMomentLabel(failure.occurredAt, locale)}
      valueFace="text"
      caption={retainedDiagnostic(failure)}
    />
  );
}

/** One failed run: what failed, when it settled, and its retained diagnostic. */
function RunFailureRow({ run, locale }: Readonly<{ run: SessionFailureRun; locale: string }>) {
  const { t } = useTranslation();
  return (
    <KvRow
      label={
        knownFailureCopy(run.failureCode, t) ??
        run.userVisibleError ??
        t('agentChat.failureHistory.runFallback')
      }
      labelShrink
      value={failureMomentLabel(run.terminalAt ?? run.queuedAt, locale)}
      valueFace="text"
      caption={retainedDiagnostic(run)}
    />
  );
}
