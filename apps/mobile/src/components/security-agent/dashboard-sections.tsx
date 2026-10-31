/* eslint-disable max-lines -- The dashboard sections share one data contract and navigation scope. */
import { getAnalysisIncompleteCount } from '@kilocode/app-shared/security-agent';
import { type Href } from 'expo-router';
import { Clock, FolderGit2, ShieldCheck } from '@/components/ui/icons';
import { DirectionalArrowRight } from '@/components/ui/directional-icons';
import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { severityCountPhrase } from '@/components/security-agent/severity-count-phrase';
import { KvRow } from '@/components/ui/kv-row';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { DENSE_ROW_HIT_SLOP } from '@/lib/a11y/tap-target';
import { formatNumber, formatPercent, UNMEASURED_VALUE } from '@/lib/format';
import { type useSecurityAgentDashboardStats } from '@/lib/hooks/use-security-agent';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
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
  /** No sync has completed yet, so nothing here counts a measured result. */
  neverSynced: boolean;
}>;

function repoTrailingLabel(
  repo: { slaCompliancePercent: number; slaComplianceMeasured: boolean; needsAction: number },
  slaEnabled: boolean
): string {
  if (!slaEnabled) {
    // i18n-dup-ok: 'securityAgent.dashboard.findingsCount_other' is this counted message's plural other category — the bare key carries that copy by i18next convention, and every catalog inflects the family by its own count rules.
    return i18n.t('securityAgent.dashboard.findingsCount', {
      count: repo.needsAction,
      displayCount: formatNumber(repo.needsAction, i18n.language),
    });
  }
  return repo.slaComplianceMeasured
    ? formatPercent(repo.slaCompliancePercent, i18n.language)
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

/**
 * A row's value before the first sync: the counts below it are not measured,
 * so a dash replaces each number the row would otherwise claim as zero.
 */
function rowValue(neverSynced: boolean, rendered: string): string {
  return neverSynced ? UNMEASURED_VALUE : rendered;
}

/** The status dot an unmeasured row shows: neutral, never a success or alarm colour. */
function rowTone(
  neverSynced: boolean,
  measured: 'good' | 'warn' | 'danger' | 'muted'
): 'good' | 'warn' | 'danger' | 'muted' {
  return neverSynced ? 'muted' : measured;
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

function PriorityFindingSection({ scope, data, slaEnabled, neverSynced }: SectionProps) {
  const pushOnce = useSinglePushRoute();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const finding = data.priorityFinding;

  // A scope that has never synced has found nothing yet because nothing ran,
  // not because the codebase is clean: the green check and the all-clear line
  // read as a verified result. The neutral row states the same not-yet-synced
  // fact the filter above shows, and opens nothing.
  if (neverSynced) {
    return (
      <SectionCard title={t('securityAgent.dashboard.actFirst')}>
        <View className="flex-row items-center gap-2 py-3">
          <Clock size={16} color={colors.mutedForeground} />
          <Text variant="muted" className="text-sm">
            {t('securityAgent.dashboard.notYetSynced')}
          </Text>
        </View>
      </SectionCard>
    );
  }

  if (!finding) {
    return (
      <SectionCard title={t('securityAgent.dashboard.actFirst')}>
        <Pressable
          className="flex-row items-center justify-between gap-2 py-3 active:opacity-70"
          onPress={() => {
            pushOnce(findingsHref(scope, { status: 'open' }));
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
  const daysOverdue = finding.daysOverdue ?? 0;

  return (
    <SectionCard title={t('securityAgent.dashboard.actFirst')}>
      <Pressable
        className="gap-1 py-3 active:opacity-70"
        onPress={() => {
          pushOnce(getSecurityAgentPath(scope, `findings/${finding.id}`));
        }}
      >
        <Text className="text-sm font-medium" numberOfLines={1}>
          {finding.title}
        </Text>
        <Text variant="muted" className="text-xs" numberOfLines={1}>
          {finding.repoFullName}
          {isOverdue &&
            ` · ${
              // i18n-dup-ok: 'securityAgent.dashboard.daysOverdue_other' is this counted message's plural other category — the bare key carries that copy by i18next convention, and every catalog inflects the family by its own count rules.
              daysOverdue === 0
                ? t('securityAgent.dashboard.deadlineToday')
                : t('securityAgent.dashboard.daysOverdue', {
                    count: daysOverdue,
                    displayCount: formatNumber(daysOverdue, i18n.language),
                  })
            }`}
        </Text>
      </Pressable>
    </SectionCard>
  );
}

function PostureSection({ data, slaEnabled, neverSynced }: SectionProps) {
  const { t } = useTranslation();
  // With SLA deadlines on, the metric tiles above already carry this breakdown:
  // the compliance tile captions how many findings are within their deadline and
  // the deadline tile captions the same severity buckets. A second copy here read
  // the same figures twice, so the section only adds the analysis posture the
  // tiles leave out.
  if (slaEnabled) {
    return null;
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
        value={rowValue(neverSynced, formatNumber(data.analysis.exploitable, i18n.language))}
        valueTone="muted"
        valueNumeric
        dotTone={rowTone(neverSynced, 'danger')}
      />
      <KvRow
        label={t('securityAgent.dashboard.needsEvidenceReview')}
        value={rowValue(neverSynced, formatNumber(data.analysis.needsReview, i18n.language))}
        valueTone="muted"
        valueNumeric
        dotTone={rowTone(neverSynced, 'warn')}
      />
      <KvRow
        label={t('securityAgent.dashboard.analysisNotComplete')}
        value={rowValue(neverSynced, formatNumber(analysisIncomplete, i18n.language))}
        valueTone="muted"
        valueNumeric
        dotTone="muted"
      />
      <KvRow
        label={t('securityAgent.dashboard.noImmediateAction')}
        value={rowValue(neverSynced, formatNumber(noImmediateAction, i18n.language))}
        valueTone="muted"
        valueNumeric
        dotTone={rowTone(neverSynced, 'good')}
        last
      />
    </SectionCard>
  );
}

function CoverageSection({ scope, data, slaEnabled, repoFullName, neverSynced }: SectionProps) {
  const pushOnce = useSinglePushRoute();
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
            pushOnce(row.href);
          }}
          // The row keeps `KvRow`'s own `py-3` rhythm, so its counts read as one
          // column at the pitch every other `KvRow` group uses instead of the
          // taller interactive-row frame. The slop carries the touch region past
          // the design target without moving the frame the divider sits on.
          hitSlop={DENSE_ROW_HIT_SLOP}
          className="active:opacity-70"
        >
          <KvRow
            label={row.label}
            value={rowValue(neverSynced, formatNumber(row.value, i18n.language))}
            valueTone="muted"
            valueNumeric
            dotTone={rowTone(neverSynced, row.tone)}
            last={index === rows.length - 1}
          />
        </Pressable>
      ))}
    </SectionCard>
  );
}

function RepoHealthSection({ scope, data, slaEnabled }: SectionProps) {
  const pushOnce = useSinglePushRoute();
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
            pushOnce(findingsHref(scope, { status: 'open', repoFullName: repo.repoFullName }));
          }}
        >
          <View className="flex-1">
            <Text className="text-sm font-medium" numberOfLines={1}>
              {repo.repoFullName}
            </Text>
            <Text variant="muted" className="mt-0.5 text-xs">
              {t('securityAgent.dashboard.repoSummary', {
                open: severityCountPhrase('repoOpen', repo.open),
                critical: severityCountPhrase('repoCritical', repo.critical),
                high: severityCountPhrase('repoHigh', repo.high),
              })}
            </Text>
          </View>
          <Text className="text-xs text-muted-foreground tabular-nums">
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
