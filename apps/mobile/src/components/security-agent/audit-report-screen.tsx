import { isPersonalSecurityScope } from '@kilocode/app-shared/security-agent';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useQuery } from '@tanstack/react-query';
import { FileText, ShieldOff } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { CollapsibleSection } from '@/components/security-agent/collapsible-section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { i18n } from '@/i18n';
import { formatDate } from '@/lib/format';
import { useTRPC } from '@/lib/trpc';
import { capitalize, parseTimestamp } from '@/lib/utils';

type RouterOutputs = inferRouterOutputs<MobileRouter>;
type AuditReportResponse = RouterOutputs['securityAgent']['getAuditReport'];
type SecurityAgentAuditReport = Extract<AuditReportResponse, { status: 'ok' }>['report'];
type SecurityFindingAuditSection = SecurityAgentAuditReport['findings'][number];

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

// Personal and org procedures resolve to nominally distinct tRPC option
// types even when structurally identical, so we always call both hooks (one
// disabled) and return whichever is active — the same branching pattern as
// use-security-agent.ts.
function useSecurityAgentAuditReport(scope: string) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.securityAgent.getAuditReport.queryOptions({}),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.getAuditReport.queryOptions({ organizationId: scope }),
    enabled: !isPersonalSecurityScope(scope),
  });
  return isPersonalSecurityScope(scope) ? personal : organization;
}

function AuditReportSkeleton() {
  return (
    <View className="flex-1 gap-3 px-6 pt-4">
      <Skeleton className="h-4 w-2/3 rounded" />
      <Skeleton className="h-4 w-1/3 rounded" />
      <Skeleton className="h-24 w-full rounded-lg" />
      <Skeleton className="h-16 w-full rounded-lg" />
      <Skeleton className="h-16 w-full rounded-lg" />
    </View>
  );
}

function ReportHeader({ report }: Readonly<{ report: SecurityAgentAuditReport }>) {
  const { t } = useTranslation();
  const start = formatDate(parseTimestamp(report.period.start), i18n.language);
  const end = formatDate(parseTimestamp(report.period.displayEnd), i18n.language);
  const generatedAt = formatDate(parseTimestamp(report.generatedAt), i18n.language);

  return (
    <View className="gap-1">
      <Text className="text-sm font-medium">{report.owner.displayName}</Text>
      <Text variant="muted" className="text-xs">
        {t('securityAgent.auditReport.periodUtc', { start, end })}
      </Text>
      <Text variant="muted" className="text-xs">
        {t('securityAgent.auditReport.generated', { generatedAt })}
      </Text>
    </View>
  );
}

function SummaryCount({ label, value }: Readonly<{ label: string; value: number }>) {
  return (
    <View className="min-w-16">
      <Text className="text-lg font-semibold tabular-nums">{value}</Text>
      <Text variant="muted" className="text-xs">
        {label}
      </Text>
    </View>
  );
}

function ReportSummary({ report }: Readonly<{ report: SecurityAgentAuditReport }>) {
  const { t } = useTranslation();
  return (
    <View className="gap-3 rounded-lg bg-secondary p-3">
      <Text className="text-sm font-medium">{t('securityAgent.auditReport.summary')}</Text>
      <View className="flex-row flex-wrap gap-x-6 gap-y-2">
        <SummaryCount
          label={t('securityAgent.auditReport.findings')}
          value={report.summary.findingCount}
        />
        <SummaryCount
          label={t('securityAgent.auditReport.events')}
          value={report.summary.activityCount}
        />
        {SEVERITY_ORDER.map(severity => (
          <SummaryCount
            key={severity}
            label={capitalize(severity)}
            value={report.summary.bySeverity[severity]}
          />
        ))}
      </View>
    </View>
  );
}

function FindingSection({ finding }: Readonly<{ finding: SecurityFindingAuditSection }>) {
  const { t } = useTranslation();
  const meta = [
    capitalize(finding.severity),
    finding.repository ?? t('securityAgent.auditReport.repositoryNotRecorded'),
  ].join(' · ');

  return (
    <CollapsibleSection title={finding.title}>
      <Text variant="muted" className="text-xs">
        {meta}
      </Text>
      <View className="gap-3">
        {finding.events.map(event => (
          <View key={event.id} className="gap-0.5">
            <Text className="text-sm">{event.label}</Text>
            <Text variant="muted" className="text-xs">
              {formatDate(parseTimestamp(event.occurredAt), i18n.language)} ·{' '}
              {event.actor.displayName}
            </Text>
          </View>
        ))}
      </View>
    </CollapsibleSection>
  );
}

function AuditReportView({ report }: Readonly<{ report: SecurityAgentAuditReport }>) {
  const { t } = useTranslation();
  if (report.findings.length === 0) {
    const start = formatDate(parseTimestamp(report.period.start), i18n.language);
    const end = formatDate(parseTimestamp(report.period.displayEnd), i18n.language);
    return (
      <EmptyState
        icon={FileText}
        className="flex-1"
        title={t('securityAgent.auditReport.noActivity')}
        description={t('securityAgent.auditReport.noActivityDescription', { start, end })}
      />
    );
  }

  return (
    <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="gap-4 pt-4">
      <ReportHeader report={report} />
      <ReportSummary report={report} />
      {report.findings.map(finding => (
        <FindingSection key={finding.findingId} finding={finding} />
      ))}
    </TabScreenScrollView>
  );
}

export function AuditReportScreen({ scope }: Readonly<{ scope: string }>) {
  const { t } = useTranslation();
  const query = useSecurityAgentAuditReport(scope);
  const errorCode = query.error?.data?.code;
  // The org procedure is `organizationBillingProcedure`, which rejects
  // viewers without the owner/billing_manager role. That denial is
  // non-retryable: retrying cannot change the viewer's role.
  const forbidden =
    !isPersonalSecurityScope(scope) &&
    query.isError &&
    (errorCode === 'FORBIDDEN' || errorCode === 'UNAUTHORIZED');

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('securityAgent.auditReport.title')} showBackButton />

      {query.isLoading && <AuditReportSkeleton />}

      {forbidden && (
        <EmptyState
          icon={ShieldOff}
          className="flex-1"
          title={t('securityAgent.auditReport.unavailable')}
          description={t('securityAgent.auditReport.unavailableDescription')}
        />
      )}

      {!query.isLoading && query.isError && !forbidden && (
        <View className="flex-1 items-center justify-center">
          <QueryError
            message={t('securityAgent.auditReport.couldNotLoad')}
            onRetry={() => void query.refetch()}
          />
        </View>
      )}

      {!query.isLoading && !query.isError && query.data?.status === 'query_failed' && (
        <View className="flex-1 items-center justify-center">
          <QueryError
            message={t('securityAgent.auditReport.queryFailed')}
            onRetry={() => void query.refetch()}
          />
        </View>
      )}

      {query.isPending && query.isPaused && (
        <View className="flex-1 items-center justify-center">
          <QueryError
            variant="offline"
            message={t('securityAgent.auditReport.checkConnection')}
            onRetry={() => void query.refetch()}
          />
        </View>
      )}

      {!query.isLoading && !query.isError && query.data?.status === 'ok' && (
        <AuditReportView report={query.data.report} />
      )}
    </View>
  );
}
