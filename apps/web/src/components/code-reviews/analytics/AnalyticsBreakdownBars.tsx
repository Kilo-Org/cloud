'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

type ChangeType =
  | 'bug_fix'
  | 'feature'
  | 'refactor'
  | 'maintenance'
  | 'dependency'
  | 'test'
  | 'documentation'
  | 'mixed'
  | 'other';

type ComplexityLevel = 'low' | 'medium' | 'high';

type FindingCategory =
  | 'security'
  | 'correctness'
  | 'reliability'
  | 'data_integrity'
  | 'performance'
  | 'compatibility'
  | 'maintainability'
  | 'test_quality'
  | 'documentation'
  | 'accessibility'
  | 'other';

type SecurityClass =
  | 'auth_access'
  | 'injection'
  | 'data_protection'
  | 'request_resource_boundary'
  | 'deserialization_object_integrity'
  | 'dependency_supply_chain'
  | 'memory_safety'
  | 'availability'
  | 'concurrency'
  | 'security_configuration'
  | 'other';

type DistributionRow<T extends string> = {
  value: T;
  count: number;
  lowConfidenceCount: number;
};

type SeverityBreakdownRow<T extends string> = {
  value: T;
  total: number;
  critical: number;
  warning: number;
  suggestion: number;
};

type ImpactBreakdown = {
  impact: Record<'low' | 'medium' | 'high' | 'unclassified', number>;
  complexity: DistributionRow<ComplexityLevel>[];
  changeTypes: DistributionRow<ChangeType>[];
};

type AnalyticsBreakdownBarsProps = {
  impactBreakdown: ImpactBreakdown;
  findingBreakdown: SeverityBreakdownRow<FindingCategory>[];
  securityBreakdown: SeverityBreakdownRow<SecurityClass>[];
};

type BarColor = 'bg-chart-1' | 'bg-chart-2' | 'bg-chart-3' | 'bg-chart-4' | 'bg-chart-5';

type BarItem = {
  key: string;
  label: string;
  count: number;
  detail?: string;
  color: BarColor;
};

const impactLabels = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  unclassified: 'Unclassified (low confidence)',
} as const;

const impactColors = {
  low: 'bg-chart-2',
  medium: 'bg-chart-3',
  high: 'bg-chart-5',
  unclassified: 'bg-chart-4',
} as const satisfies Record<keyof typeof impactLabels, BarColor>;

const complexityLabels = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
} as const satisfies Record<ComplexityLevel, string>;

const changeTypeLabels = {
  bug_fix: 'Bug fix',
  feature: 'Feature',
  refactor: 'Refactor',
  maintenance: 'Maintenance',
  dependency: 'Dependency',
  test: 'Test',
  documentation: 'Documentation',
  mixed: 'Mixed',
  other: 'Other',
} as const satisfies Record<ChangeType, string>;

const findingCategoryLabels = {
  security: 'Security',
  correctness: 'Correctness',
  reliability: 'Reliability',
  data_integrity: 'Data integrity',
  performance: 'Performance',
  compatibility: 'Compatibility',
  maintainability: 'Maintainability',
  test_quality: 'Test quality',
  documentation: 'Documentation',
  accessibility: 'Accessibility',
  other: 'Other',
} as const satisfies Record<FindingCategory, string>;

const securityClassLabels = {
  auth_access: 'Authentication and access',
  injection: 'Injection',
  data_protection: 'Data protection',
  request_resource_boundary: 'Request and resource boundaries',
  deserialization_object_integrity: 'Deserialization and object integrity',
  dependency_supply_chain: 'Dependency and supply chain',
  memory_safety: 'Memory safety',
  availability: 'Availability',
  concurrency: 'Concurrency',
  security_configuration: 'Security configuration',
  other: 'Other',
} as const satisfies Record<SecurityClass, string>;

const complexityOrder: ComplexityLevel[] = ['low', 'medium', 'high'];
const impactOrder: Array<keyof ImpactBreakdown['impact']> = [
  'low',
  'medium',
  'high',
  'unclassified',
];

function lowConfidenceDetail(count: number): string | undefined {
  if (count === 0) return undefined;
  return `${count.toLocaleString()} low confidence`;
}

function DistributionBarList({ items, label }: { items: BarItem[]; label: string }) {
  const maxCount = Math.max(...items.map(item => item.count), 1);

  return (
    <div className="space-y-3" aria-label={label}>
      {items.map(item => (
        <div key={item.key} className="space-y-1.5">
          <div className="flex items-start justify-between gap-3 text-sm">
            <div className="min-w-0">
              <span>{item.label}</span>
              {item.detail && (
                <span className="text-muted-foreground ml-2 text-xs">{item.detail}</span>
              )}
            </div>
            <span className="shrink-0 tabular-nums">{item.count.toLocaleString()}</span>
          </div>
          <div className="bg-muted h-2 overflow-hidden rounded-full" aria-hidden="true">
            <div
              className={cn('h-full rounded-full', item.color)}
              style={{ width: `${(item.count / maxCount) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function SeverityBarList<T extends string>({
  rows,
  labels,
  label,
}: {
  rows: SeverityBreakdownRow<T>[];
  labels: Record<T, string>;
  label: string;
}) {
  const maxTotal = Math.max(...rows.map(row => row.total), 1);

  return (
    <div className="space-y-3" aria-label={label}>
      {rows.map(row => (
        <div key={row.value} className="space-y-1.5">
          <div className="flex items-start justify-between gap-3 text-sm">
            <span>{labels[row.value]}</span>
            <span className="shrink-0 tabular-nums">{row.total.toLocaleString()}</span>
          </div>
          <div className="bg-muted flex h-2 overflow-hidden rounded-full" aria-hidden="true">
            <div
              className="bg-chart-5 h-full"
              style={{ width: `${(row.critical / maxTotal) * 100}%` }}
            />
            <div
              className="bg-chart-3 h-full"
              style={{ width: `${(row.warning / maxTotal) * 100}%` }}
            />
            <div
              className="bg-chart-2 h-full"
              style={{ width: `${(row.suggestion / maxTotal) * 100}%` }}
            />
          </div>
          <p className="text-muted-foreground text-xs tabular-nums">
            Critical {row.critical.toLocaleString()} / Warning {row.warning.toLocaleString()} /
            Suggestion {row.suggestion.toLocaleString()}
          </p>
        </div>
      ))}
    </div>
  );
}

function ImpactBreakdownCard({ impactBreakdown }: { impactBreakdown: ImpactBreakdown }) {
  const complexityByValue = new Map(
    impactBreakdown.complexity.map(row => [row.value, row] as const)
  );
  const impactItems = impactOrder.map(value => ({
    key: value,
    label: impactLabels[value],
    count: impactBreakdown.impact[value],
    color: impactColors[value],
  }));
  const complexityItems = complexityOrder.map(value => {
    const row = complexityByValue.get(value);
    return {
      key: value,
      label: complexityLabels[value],
      count: row?.count ?? 0,
      detail: lowConfidenceDetail(row?.lowConfidenceCount ?? 0),
      color: 'bg-chart-1' as const,
    };
  });
  const changeTypeItems = [...impactBreakdown.changeTypes]
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .map(row => ({
      key: row.value,
      label: changeTypeLabels[row.value],
      count: row.count,
      detail: lowConfidenceDetail(row.lowConfidenceCount),
      color: 'bg-chart-2' as const,
    }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change profile</CardTitle>
        <CardDescription>
          AI-estimated impact, implementation complexity, and change type for the latest tracked
          version of each pull or merge request.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3" aria-labelledby="analytics-impact-heading">
          <h3 id="analytics-impact-heading" className="text-sm font-medium">
            AI-estimated impact
          </h3>
          <DistributionBarList items={impactItems} label="AI-estimated impact distribution" />
        </section>
        <section className="space-y-3" aria-labelledby="analytics-complexity-heading">
          <h3 id="analytics-complexity-heading" className="text-sm font-medium">
            Complexity
          </h3>
          <DistributionBarList items={complexityItems} label="Complexity distribution" />
        </section>
        <section className="space-y-3" aria-labelledby="analytics-change-type-heading">
          <h3 id="analytics-change-type-heading" className="text-sm font-medium">
            Change type
          </h3>
          {changeTypeItems.length > 0 ? (
            <DistributionBarList items={changeTypeItems} label="Change type distribution" />
          ) : (
            <p className="text-muted-foreground text-sm">No change types in this selection.</p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

function FindingBreakdownCard({
  findingBreakdown,
  securityBreakdown,
}: Pick<AnalyticsBreakdownBarsProps, 'findingBreakdown' | 'securityBreakdown'>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Finding taxonomy</CardTitle>
        <CardDescription>
          Newly raised Code Review Findings grouped by controlled category and severity.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3" aria-labelledby="analytics-finding-category-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id="analytics-finding-category-heading" className="text-sm font-medium">
              Categories
            </h3>
            <div className="text-muted-foreground flex flex-wrap gap-3 text-xs" aria-hidden="true">
              <span className="flex items-center gap-1.5">
                <span className="bg-chart-5 size-2 rounded-full" /> Critical
              </span>
              <span className="flex items-center gap-1.5">
                <span className="bg-chart-3 size-2 rounded-full" /> Warning
              </span>
              <span className="flex items-center gap-1.5">
                <span className="bg-chart-2 size-2 rounded-full" /> Suggestion
              </span>
            </div>
          </div>
          {findingBreakdown.length > 0 ? (
            <SeverityBarList
              rows={findingBreakdown}
              labels={findingCategoryLabels}
              label="Finding category and severity distribution"
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              No Code Review Findings were raised in captured results for this selection.
            </p>
          )}
        </section>
        {securityBreakdown.length > 0 && (
          <section className="space-y-3 border-t pt-6" aria-labelledby="analytics-security-heading">
            <h3 id="analytics-security-heading" className="text-sm font-medium">
              Security concern classes
            </h3>
            <SeverityBarList
              rows={securityBreakdown}
              labels={securityClassLabels}
              label="Security concern class and severity distribution"
            />
          </section>
        )}
      </CardContent>
    </Card>
  );
}

export function AnalyticsBreakdownBars({
  impactBreakdown,
  findingBreakdown,
  securityBreakdown,
}: AnalyticsBreakdownBarsProps) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <ImpactBreakdownCard impactBreakdown={impactBreakdown} />
      <FindingBreakdownCard
        findingBreakdown={findingBreakdown}
        securityBreakdown={securityBreakdown}
      />
    </div>
  );
}
