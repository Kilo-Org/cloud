'use client';

import type { ReactNode } from 'react';
import { useId } from 'react';

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

type ModelBreakdownRow = {
  model: string | null;
  trackedReviews: number;
  totalFindings: number;
  criticalFindings: number;
  warningFindings: number;
  suggestionFindings: number;
};

type ModelSeverityRow = SeverityBreakdownRow<string> & {
  model: string | null;
  trackedReviews: number;
};

type ImpactBreakdown = {
  impact: Record<'low' | 'medium' | 'high' | 'unclassified', number>;
  complexity: DistributionRow<ComplexityLevel>[];
  changeTypes: DistributionRow<ChangeType>[];
};

type AnalyticsBreakdownBarsProps = {
  impactBreakdown: ImpactBreakdown;
  modelBreakdown: ModelBreakdownRow[];
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

function formatReviewModelName(model: string | null): string {
  const trimmed = model?.trim();
  if (!trimmed) return 'Model metadata unavailable';

  const [, ...withoutProvider] = trimmed.split('/');
  const display = withoutProvider.join('/');
  return display.length > 0 ? display : trimmed;
}

function rawReviewModelTitle(model: string | null): string | undefined {
  const trimmed = model?.trim();
  return trimmed ? trimmed : undefined;
}

function reviewCountDetail(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'review' : 'reviews'}`;
}

function DistributionBarList({ items, label }: { items: BarItem[]; label: string }) {
  const maxCount = Math.max(...items.map(item => item.count), 1);

  return (
    <div className="space-y-3" role="list" aria-label={label}>
      {items.map(item => (
        <div key={item.key} className="space-y-1.5" role="listitem">
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

function SeverityBarList<Row extends SeverityBreakdownRow<string>>({
  rows,
  label,
  labelForRow,
  detailForRow,
  titleForRow,
}: {
  rows: Row[];
  label: string;
  labelForRow: (row: Row) => string;
  detailForRow?: (row: Row) => string | undefined;
  titleForRow?: (row: Row) => string | undefined;
}) {
  const maxTotal = Math.max(...rows.map(row => row.total), 1);

  return (
    <div className="space-y-3" role="list" aria-label={label}>
      {rows.map(row => {
        const rowDetail = detailForRow?.(row);
        const severityCounts = [
          { label: 'Critical', count: row.critical },
          { label: 'Warning', count: row.warning },
          { label: 'Suggestion', count: row.suggestion },
        ];
        const visibleSummary = severityCounts
          .filter(severity => severity.count > 0)
          .map(severity => `${severity.label} ${severity.count.toLocaleString()}`)
          .join(' / ');
        const accessibleSummary = severityCounts
          .map(severity => `${severity.label} ${severity.count.toLocaleString()}`)
          .join(', ');

        return (
          <div key={row.value} className="space-y-1.5" role="listitem">
            <div className="flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <span className="block truncate" title={titleForRow?.(row)}>
                  {labelForRow(row)}
                </span>
                {rowDetail && (
                  <span className="text-muted-foreground mt-0.5 block text-xs tabular-nums">
                    {rowDetail}
                  </span>
                )}
              </div>
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
              <span className="sr-only">{accessibleSummary}.</span>
              {visibleSummary && <span aria-hidden="true">{visibleSummary}</span>}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function SeverityLegend() {
  return (
    <div
      className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-2 text-xs sm:justify-end"
      aria-hidden="true"
    >
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
  );
}

function BreakdownCard({
  headingId,
  title,
  children,
}: {
  headingId: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle>
          <h3 id={headingId}>{title}</h3>
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ReviewModelSection({
  modelBreakdown,
  headingId,
}: Pick<AnalyticsBreakdownBarsProps, 'modelBreakdown'> & {
  headingId: string;
}) {
  if (modelBreakdown.length === 0) return null;

  if (modelBreakdown.length === 1) {
    const row = modelBreakdown[0];
    if (!row) return null;

    return (
      <p className="text-muted-foreground text-sm">
        Code Reviewer model:{' '}
        <span className="text-foreground" title={rawReviewModelTitle(row.model)}>
          {formatReviewModelName(row.model)}
        </span>
      </p>
    );
  }

  const modelRows: ModelSeverityRow[] = modelBreakdown.map((row, index) => ({
    value: `${row.model ?? 'model-metadata-unavailable'}-${index}`,
    model: row.model,
    trackedReviews: row.trackedReviews,
    total: row.totalFindings,
    critical: row.criticalFindings,
    warning: row.warningFindings,
    suggestion: row.suggestionFindings,
  }));
  const modelsHeadingId = `${headingId}-models`;

  return (
    <section className="space-y-4" aria-labelledby={headingId}>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <h2 id={headingId} className="text-lg font-semibold tracking-tight">
            Findings by model
          </h2>
          <CardDescription>
            Critical, warning, and suggestion Code Review Findings raised by each Code Reviewer
            model in this selection.
          </CardDescription>
        </div>
        <SeverityLegend />
      </header>
      <BreakdownCard headingId={modelsHeadingId} title="Code Reviewer models">
        <SeverityBarList
          rows={modelRows}
          label="Code Reviewer model and severity distribution"
          labelForRow={row => formatReviewModelName(row.model)}
          detailForRow={row => reviewCountDetail(row.trackedReviews)}
          titleForRow={row => rawReviewModelTitle(row.model)}
        />
      </BreakdownCard>
    </section>
  );
}

function ChangeProfileSection({
  impactBreakdown,
  headingId,
}: {
  impactBreakdown: ImpactBreakdown;
  headingId: string;
}) {
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
  const impactHeadingId = `${headingId}-impact`;
  const complexityHeadingId = `${headingId}-complexity`;
  const changeTypeHeadingId = `${headingId}-change-type`;

  return (
    <section className="space-y-4" aria-labelledby={headingId}>
      <header className="space-y-1.5">
        <h2 id={headingId} className="text-lg font-semibold tracking-tight">
          Change profile
        </h2>
        <CardDescription>
          AI-estimated impact, implementation complexity, and change type for the latest tracked
          version of each pull or merge request.
        </CardDescription>
      </header>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="grid gap-6">
          <BreakdownCard headingId={impactHeadingId} title="AI-estimated impact">
            <DistributionBarList items={impactItems} label="AI-estimated impact distribution" />
          </BreakdownCard>
          <BreakdownCard headingId={complexityHeadingId} title="Complexity">
            <DistributionBarList items={complexityItems} label="Complexity distribution" />
          </BreakdownCard>
        </div>
        <BreakdownCard headingId={changeTypeHeadingId} title="Change type">
          {changeTypeItems.length > 0 ? (
            <DistributionBarList items={changeTypeItems} label="Change type distribution" />
          ) : (
            <p className="text-muted-foreground text-sm">No change types in this selection.</p>
          )}
        </BreakdownCard>
      </div>
    </section>
  );
}

function FindingTaxonomySection({
  findingBreakdown,
  securityBreakdown,
  headingId,
}: Pick<AnalyticsBreakdownBarsProps, 'findingBreakdown' | 'securityBreakdown'> & {
  headingId: string;
}) {
  const categoriesHeadingId = `${headingId}-categories`;
  const securityHeadingId = `${headingId}-security`;
  const hasSecurityBreakdown = securityBreakdown.length > 0;

  return (
    <section className="space-y-4" aria-labelledby={headingId}>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <h2 id={headingId} className="text-lg font-semibold tracking-tight">
            Finding taxonomy
          </h2>
          <CardDescription>
            Newly raised Code Review Findings grouped by controlled category and severity.
          </CardDescription>
        </div>
        <SeverityLegend />
      </header>
      <div className={cn('grid gap-6', hasSecurityBreakdown && 'lg:grid-cols-2 lg:items-start')}>
        <BreakdownCard headingId={categoriesHeadingId} title="Categories">
          {findingBreakdown.length > 0 ? (
            <SeverityBarList
              rows={findingBreakdown}
              label="Finding category and severity distribution"
              labelForRow={row => findingCategoryLabels[row.value]}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              No Code Review Findings were raised in captured results for this selection.
            </p>
          )}
        </BreakdownCard>
        {hasSecurityBreakdown && (
          <BreakdownCard headingId={securityHeadingId} title="Security concern classes">
            <SeverityBarList
              rows={securityBreakdown}
              label="Security concern class and severity distribution"
              labelForRow={row => securityClassLabels[row.value]}
            />
          </BreakdownCard>
        )}
      </div>
    </section>
  );
}

export function AnalyticsBreakdownBars({
  impactBreakdown,
  modelBreakdown,
  findingBreakdown,
  securityBreakdown,
}: AnalyticsBreakdownBarsProps) {
  const id = useId();

  return (
    <div className="space-y-8">
      <ChangeProfileSection impactBreakdown={impactBreakdown} headingId={`${id}-change-profile`} />
      <ReviewModelSection modelBreakdown={modelBreakdown} headingId={`${id}-review-model`} />
      <FindingTaxonomySection
        findingBreakdown={findingBreakdown}
        securityBreakdown={securityBreakdown}
        headingId={`${id}-finding-taxonomy`}
      />
    </div>
  );
}
