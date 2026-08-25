import { getAnalysisIncompleteCount } from '@kilocode/app-shared/security-agent';
import { type Href, useRouter } from 'expo-router';
import { FolderGit2, ShieldCheck } from '@/components/ui/icons';
import { DirectionalArrowRight } from '@/components/ui/directional-icons';
import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { KvRow } from '@/components/ui/kv-row';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { type useSecurityAgentDashboardStats } from '@/lib/hooks/use-security-agent';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { cn } from '@/lib/utils';

// Derived from the tRPC-backed hook rather than reusing
// @kilocode/app-shared/security-agent's DashboardStats — that package type is
// deliberately narrowed to only the fields buildSecurityDashboardMetrics /
// getAnalysisIncompleteCount read, while this component also needs
// priorityFinding and repoHealth from the full tRPC output.
type DashboardStats = NonNullable<ReturnType<typeof useSecurityAgentDashboardStats>['data']>;

type SectionProps = Readonly<{
  scope: string;
  data: DashboardStats;
  slaEnabled: boolean;
  repoFullName: string | undefined;
}>;

function repoTrailingLabel(
  repo: { slaCompliancePercent: number; slaComplianceMeasured: boolean; needsAction: number },
  slaEnabled: boolean
): string {
  if (!slaEnabled) {
    return i18n.t('securityAgent.dashboard.findingsCount', { count: repo.needsAction });
  }
  return repo.slaComplianceMeasured
    ? `${repo.slaCompliancePercent}%`
    : i18n.t('securityAgent.dashboard.notMeasured');
}

function findingsHref(
  scope: string,
  params: Record<string, string | number | boolean | undefined>
): Href {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  const base = getSecurityAgentPath(scope, 'findings') as string;
  return (query ? `${base}?${query}` : base) as Href;
}

function SectionCard({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <View className="gap-1 rounded-lg bg-secondary px-3">
      <Text variant="small" className="pt-3 uppercase tracking-wide text-muted-foreground">
        {title}
      </Text>
      {children}
    </View>
  );
}

function PriorityFindingSection({ scope, data, slaEnabled }: SectionProps) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const finding = data.priorityFinding;

  if (!finding) {
    return (
      <SectionCard title={t('securityAgent.dashboard.actFirst')}>
        <Pressable
          className="flex-row items-center justify-between gap-2 py-3 active:opacity-70"
          onPress={() => {
            router.push(findingsHref(scope, { status: 'open' }));
          }}
        >
          <View className="flex-row items-center gap-2">
            <ShieldCheck size={16} color={colors.good} />
            <Text className="text-sm">{t('securityAgent.dashboard.noOpenFindings')}</Text>
          </View>
          <DirectionalArrowRight size={14} color={colors.mutedForeground} />
        </Pressable>
      </SectionCard>
    );
  }

  const isOverdue = slaEnabled && finding.daysOverdue !== null;

  return (
    <SectionCard title={t('securityAgent.dashboard.actFirst')}>
      <Pressable
        className="gap-1 py-3 active:opacity-70"
        onPress={() => {
          router.push(getSecurityAgentPath(scope, `findings/${finding.id}`));
        }}
      >
        <Text className="text-sm font-medium" numberOfLines={1}>
          {finding.title}
        </Text>
        <Text variant="muted" className="text-xs" numberOfLines={1}>
          {finding.repoFullName}
          {isOverdue &&
            ` · ${
              finding.daysOverdue === 0
                ? t('securityAgent.dashboard.deadlineToday')
                : t('securityAgent.dashboard.daysOverdue', { count: finding.daysOverdue })
            }`}
        </Text>
      </Pressable>
    </SectionCard>
  );
}

function PostureSection({ data, slaEnabled }: SectionProps) {
  const { t } = useTranslation();
  if (slaEnabled) {
    const { overall, bySeverity } = data.sla;
    return (
      <SectionCard title={t('securityAgent.dashboard.slaPosture')}>
        <KvRow
          label={t('securityAgent.dashboard.withinDeadline')}
          value={`${overall.withinSla} / ${overall.total}`}
        />
        <KvRow
          label={t('securityAgent.dashboard.criticalOverdue')}
          value={String(bySeverity.critical.overdue)}
          valueTone="muted"
          dotTone={bySeverity.critical.overdue > 0 ? 'danger' : 'muted'}
        />
        <KvRow
          label={t('securityAgent.dashboard.highOverdue')}
          value={String(bySeverity.high.overdue)}
          valueTone="muted"
          dotTone={bySeverity.high.overdue > 0 ? 'danger' : 'muted'}
        />
        <KvRow
          label={t('securityAgent.dashboard.mediumLowOverdue')}
          value={String(bySeverity.medium.overdue + bySeverity.low.overdue)}
          valueTone="muted"
          dotTone={bySeverity.medium.overdue + bySeverity.low.overdue > 0 ? 'danger' : 'muted'}
          last
        />
      </SectionCard>
    );
  }

  const analysisIncomplete = getAnalysisIncompleteCount(data.analysis);
  const noImmediateAction = Math.max(
    0,
    data.analysis.total - data.analysis.exploitable - data.analysis.needsReview - analysisIncomplete
  );

  return (
    <SectionCard title={t('securityAgent.dashboard.actionPosture')}>
      <KvRow
        label={t('securityAgent.dashboard.confirmedExploitable')}
        value={String(data.analysis.exploitable)}
        valueTone="muted"
        dotTone="danger"
      />
      <KvRow
        label={t('securityAgent.dashboard.needsEvidenceReview')}
        value={String(data.analysis.needsReview)}
        valueTone="muted"
        dotTone="warn"
      />
      <KvRow
        label={t('securityAgent.dashboard.analysisNotComplete')}
        value={String(analysisIncomplete)}
        valueTone="muted"
        dotTone="muted"
      />
      <KvRow
        label={t('securityAgent.dashboard.noImmediateAction')}
        value={String(noImmediateAction)}
        valueTone="muted"
        dotTone="good"
        last
      />
    </SectionCard>
  );
}

function CoverageSection({ scope, data, slaEnabled, repoFullName }: SectionProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const analysisIncomplete = getAnalysisIncompleteCount(data.analysis);

  const rows: {
    label: string;
    value: number;
    tone: 'good' | 'warn' | 'danger' | 'muted';
    href: Href;
  }[] = [
    {
      label: t('securityAgent.dashboard.confirmedExploitable'),
      value: data.analysis.exploitable,
      tone: 'danger',
      href: findingsHref(scope, { outcomeFilter: 'exploitable', repoFullName }),
    },
    {
      label: t('securityAgent.dashboard.notExploitable'),
      value: data.analysis.notExploitable,
      tone: 'good',
      href: findingsHref(scope, { outcomeFilter: 'not_exploitable', repoFullName }),
    },
    {
      label: t('securityAgent.dashboard.needsYourReview'),
      value: data.analysis.needsReview,
      tone: 'warn',
      href: findingsHref(scope, { outcomeFilter: 'needs_review', repoFullName }),
    },
    {
      label: t('securityAgent.dashboard.analysisNotComplete'),
      value: analysisIncomplete,
      tone: 'muted',
      href: findingsHref(scope, { status: 'open', repoFullName }),
    },
  ];
  if (slaEnabled) {
    rows.push({
      label: t('securityAgent.dashboard.noSlaDeadline'),
      value: data.sla.untrackedCount,
      tone: 'muted',
      href: findingsHref(scope, { status: 'open', repoFullName }),
    });
  }

  return (
    <SectionCard title={t('securityAgent.dashboard.codebaseRisk')}>
      {rows.map((row, index) => (
        <Pressable
          key={row.label}
          onPress={() => {
            router.push(row.href);
          }}
          className="active:opacity-70"
        >
          <KvRow
            label={row.label}
            value={String(row.value)}
            valueTone="muted"
            dotTone={row.tone}
            last={index === rows.length - 1}
          />
        </Pressable>
      ))}
    </SectionCard>
  );
}

function RepoHealthSection({ scope, data, slaEnabled }: SectionProps) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();

  if (data.repoHealth.length === 0) {
    return (
      <SectionCard title={t('securityAgent.dashboard.repositoryActionPlan')}>
        <EmptyState
          icon={FolderGit2}
          placement="top"
          className="py-3"
          title={t('securityAgent.dashboard.noRepositoryData')}
          description={t('securityAgent.dashboard.noRepositoryDataDescription')}
        />
      </SectionCard>
    );
  }

  return (
    <SectionCard title={t('securityAgent.dashboard.repositoryActionPlan')}>
      {data.repoHealth.map((repo, index) => (
        <Pressable
          key={repo.repoFullName}
          className={cn(
            'flex-row items-center justify-between gap-2 py-3 active:opacity-70',
            index < data.repoHealth.length - 1 && 'border-b-[0.5px] border-hair-soft'
          )}
          onPress={() => {
            router.push(findingsHref(scope, { status: 'open', repoFullName: repo.repoFullName }));
          }}
        >
          <View className="flex-1">
            <Text className="text-sm font-medium" numberOfLines={1}>
              {repo.repoFullName}
            </Text>
            <Text variant="muted" className="mt-0.5 text-xs">
              {t('securityAgent.dashboard.repoSummary', {
                open: repo.open,
                critical: repo.critical,
                high: repo.high,
              })}
            </Text>
          </View>
          <Text variant="mono" className="text-xs text-muted-foreground">
            {repoTrailingLabel(repo, slaEnabled)}
          </Text>
          <DirectionalArrowRight size={14} color={colors.mutedForeground} />
        </Pressable>
      ))}
    </SectionCard>
  );
}

export function DashboardSections(props: SectionProps) {
  return (
    <>
      <PriorityFindingSection {...props} />
      <PostureSection {...props} />
      <CoverageSection {...props} />
      <RepoHealthSection {...props} />
    </>
  );
}
