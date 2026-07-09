import { type Href, useRouter } from 'expo-router';
import { ArrowRight, ShieldCheck } from 'lucide-react-native';
import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { KvRow } from '@/components/ui/kv-row';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type DashboardStats, getAnalysisIncompleteCount } from '@/lib/security-agent-dashboard';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { cn } from '@/lib/utils';

type SectionProps = Readonly<{
  scope: string;
  data: DashboardStats;
  slaEnabled: boolean;
  repoFullName: string | undefined;
}>;

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
  const finding = data.priorityFinding;

  if (!finding) {
    return (
      <SectionCard title="Act first">
        <Pressable
          className="flex-row items-center justify-between gap-2 py-3 active:opacity-70"
          onPress={() => {
            router.push(findingsHref(scope, { status: 'open' }));
          }}
        >
          <View className="flex-row items-center gap-2">
            <ShieldCheck size={16} color={colors.good} />
            <Text className="text-sm">No open findings need attention</Text>
          </View>
          <ArrowRight size={14} color={colors.mutedForeground} />
        </Pressable>
      </SectionCard>
    );
  }

  const isOverdue = slaEnabled && finding.daysOverdue !== null;

  return (
    <SectionCard title="Act first">
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
            ` · ${finding.daysOverdue === 0 ? 'Deadline reached today' : `${finding.daysOverdue} days overdue`}`}
        </Text>
      </Pressable>
    </SectionCard>
  );
}

function PostureSection({ data, slaEnabled }: SectionProps) {
  if (slaEnabled) {
    const { overall, bySeverity } = data.sla;
    return (
      <SectionCard title="SLA posture">
        <KvRow label="Within deadline" value={`${overall.withinSla} / ${overall.total}`} />
        <KvRow
          label="Critical overdue"
          value={String(bySeverity.critical.overdue)}
          valueTone="muted"
          dotTone={bySeverity.critical.overdue > 0 ? 'danger' : 'muted'}
        />
        <KvRow
          label="High overdue"
          value={String(bySeverity.high.overdue)}
          valueTone="muted"
          dotTone={bySeverity.high.overdue > 0 ? 'danger' : 'muted'}
        />
        <KvRow
          label="Medium & low overdue"
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
    <SectionCard title="Action posture">
      <KvRow
        label="Confirmed exploitable"
        value={String(data.analysis.exploitable)}
        valueTone="muted"
        dotTone="danger"
      />
      <KvRow
        label="Needs evidence review"
        value={String(data.analysis.needsReview)}
        valueTone="muted"
        dotTone="warn"
      />
      <KvRow
        label="Analysis not complete"
        value={String(analysisIncomplete)}
        valueTone="muted"
        dotTone="muted"
      />
      <KvRow
        label="No immediate action"
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
  const analysisIncomplete = getAnalysisIncompleteCount(data.analysis);

  const rows: {
    label: string;
    value: number;
    tone: 'good' | 'warn' | 'danger' | 'muted';
    href: Href;
  }[] = [
    {
      label: 'Confirmed exploitable',
      value: data.analysis.exploitable,
      tone: 'danger',
      href: findingsHref(scope, { outcomeFilter: 'exploitable', repoFullName }),
    },
    {
      label: 'Not exploitable',
      value: data.analysis.notExploitable,
      tone: 'good',
      href: findingsHref(scope, { outcomeFilter: 'not_exploitable', repoFullName }),
    },
    {
      label: 'Needs your review',
      value: data.analysis.needsReview,
      tone: 'warn',
      href: findingsHref(scope, { outcomeFilter: 'needs_review', repoFullName }),
    },
    {
      label: 'Analysis not complete',
      value: analysisIncomplete,
      tone: 'muted',
      href: findingsHref(scope, { status: 'open', repoFullName }),
    },
  ];
  if (slaEnabled) {
    rows.push({
      label: 'No SLA deadline assigned',
      value: data.sla.untrackedCount,
      tone: 'muted',
      href: findingsHref(scope, { status: 'open', repoFullName }),
    });
  }

  return (
    <SectionCard title="Codebase risk">
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

  if (data.repoHealth.length === 0) {
    return (
      <SectionCard title="Repository action plan">
        <Text variant="muted" className="pb-3 text-sm">
          Repository priorities will appear after findings are synced.
        </Text>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Repository action plan">
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
              {repo.open} open · {repo.critical} critical · {repo.high} high
            </Text>
          </View>
          <Text variant="mono" className="text-xs text-muted-foreground">
            {slaEnabled ? `${repo.slaCompliancePercent}%` : `${repo.needsAction} findings`}
          </Text>
          <ArrowRight size={14} color={colors.mutedForeground} />
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
