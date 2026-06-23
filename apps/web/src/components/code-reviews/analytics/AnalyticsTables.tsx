'use client';

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

type RepositoryRow = {
  repository: string;
  trackedPrsOrMrs: number;
  estimatedImpactPoints: number;
  highImpactChanges: number;
  criticalFindings: number;
  warningFindings: number;
  suggestionFindings: number;
};

type ContributorRow = {
  contributorKey: string;
  displayName: string;
  limitedIdentity: boolean;
  limitedData: boolean;
  trackedPrs: number;
  estimatedImpactPoints: number;
  highImpactPrs: number;
  criticalFindings: number;
  warningFindings: number;
  suggestionFindings: number;
  prsWithoutCriticalFindings: number;
};

type ContributorCapability = 'available' | 'stable_gitlab_author_attribution_unavailable';

type AnalyticsTablesProps = {
  platform: 'github' | 'gitlab';
  repositories: RepositoryRow[];
  contributors: {
    capability: ContributorCapability;
    rows: ContributorRow[];
  };
};

type SortDirection = 'ascending' | 'descending';
type RepositorySortKey =
  | 'repository'
  | 'trackedPrsOrMrs'
  | 'estimatedImpactPoints'
  | 'highImpactChanges'
  | 'criticalFindings'
  | 'warningFindings'
  | 'suggestionFindings';
type ContributorSortKey =
  | 'displayName'
  | 'prsWithoutCriticalFindings'
  | 'trackedPrs'
  | 'estimatedImpactPoints'
  | 'highImpactPrs'
  | 'criticalFindings'
  | 'warningFindings'
  | 'suggestionFindings';

type SortableTableHeadProps = {
  label: string;
  sortLabel?: string;
  active: boolean;
  direction: SortDirection;
  onSort: () => void;
  align?: 'left' | 'right';
};

function SortableTableHead({
  label,
  sortLabel = label,
  active,
  direction,
  onSort,
  align = 'left',
}: SortableTableHeadProps) {
  const ariaSort = active ? direction : 'none';
  const Icon = active ? (direction === 'ascending' ? ArrowUp : ArrowDown) : ArrowUpDown;

  return (
    <TableHead scope="col" aria-sort={ariaSort} className={align === 'right' ? 'text-right' : ''}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn('-mx-2 h-8 px-2', align === 'right' ? 'w-full justify-end' : 'justify-start')}
        onClick={onSort}
        aria-label={`Sort by ${sortLabel}, ${
          active && direction === 'ascending' ? 'descending' : 'ascending'
        }`}
      >
        {label}
        <Icon aria-hidden="true" />
      </Button>
    </TableHead>
  );
}

function nextSortDirection(
  activeKey: string,
  selectedKey: string,
  currentDirection: SortDirection,
  defaultDirection: SortDirection
): SortDirection {
  if (activeKey !== selectedKey) return defaultDirection;
  return currentDirection === 'ascending' ? 'descending' : 'ascending';
}

function compareNumbers(left: number, right: number, direction: SortDirection): number {
  return direction === 'ascending' ? left - right : right - left;
}

function compareText(left: string, right: string, direction: SortDirection): number {
  const result = left.localeCompare(right, undefined, { sensitivity: 'base' });
  return direction === 'ascending' ? result : -result;
}

function RepositoryAnalyticsTable({
  platform,
  rows,
}: {
  platform: AnalyticsTablesProps['platform'];
  rows: RepositoryRow[];
}) {
  const [sort, setSort] = useState<{
    key: RepositorySortKey;
    direction: SortDirection;
  }>({ key: 'estimatedImpactPoints', direction: 'descending' });

  const sortedRows = useMemo(() => {
    return [...rows].sort((left, right) => {
      let result: number;
      switch (sort.key) {
        case 'repository':
          result = compareText(left.repository, right.repository, sort.direction);
          break;
        case 'trackedPrsOrMrs':
          result = compareNumbers(left.trackedPrsOrMrs, right.trackedPrsOrMrs, sort.direction);
          break;
        case 'estimatedImpactPoints':
          result = compareNumbers(
            left.estimatedImpactPoints,
            right.estimatedImpactPoints,
            sort.direction
          );
          break;
        case 'highImpactChanges':
          result = compareNumbers(left.highImpactChanges, right.highImpactChanges, sort.direction);
          break;
        case 'criticalFindings':
          result = compareNumbers(left.criticalFindings, right.criticalFindings, sort.direction);
          break;
        case 'warningFindings':
          result = compareNumbers(left.warningFindings, right.warningFindings, sort.direction);
          break;
        case 'suggestionFindings':
          result = compareNumbers(
            left.suggestionFindings,
            right.suggestionFindings,
            sort.direction
          );
          break;
      }
      return result || left.repository.localeCompare(right.repository);
    });
  }, [rows, sort]);

  const selectSort = (key: RepositorySortKey) => {
    setSort(current => ({
      key,
      direction: nextSortDirection(
        current.key,
        key,
        current.direction,
        key === 'repository' ? 'ascending' : 'descending'
      ),
    }));
  };

  const changeLabel = platform === 'github' ? 'PRs' : 'MRs';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Repositories</CardTitle>
        <CardDescription>
          Tracked changes, AI-estimated impact, and findings raised by repository.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          className="focus-visible:ring-ring/50 overflow-x-auto rounded-md focus-visible:ring-[3px] focus-visible:outline-none"
          tabIndex={0}
          role="region"
          aria-label="Repository analytics table"
        >
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <SortableTableHead
                  label="Repository"
                  active={sort.key === 'repository'}
                  direction={sort.direction}
                  onSort={() => selectSort('repository')}
                />
                <SortableTableHead
                  label={`Tracked ${changeLabel}`}
                  active={sort.key === 'trackedPrsOrMrs'}
                  direction={sort.direction}
                  onSort={() => selectSort('trackedPrsOrMrs')}
                  align="right"
                />
                <SortableTableHead
                  label="Impact points"
                  sortLabel="estimated impact points"
                  active={sort.key === 'estimatedImpactPoints'}
                  direction={sort.direction}
                  onSort={() => selectSort('estimatedImpactPoints')}
                  align="right"
                />
                <SortableTableHead
                  label="High impact"
                  active={sort.key === 'highImpactChanges'}
                  direction={sort.direction}
                  onSort={() => selectSort('highImpactChanges')}
                  align="right"
                />
                <SortableTableHead
                  label="Critical"
                  active={sort.key === 'criticalFindings'}
                  direction={sort.direction}
                  onSort={() => selectSort('criticalFindings')}
                  align="right"
                />
                <SortableTableHead
                  label="Warning"
                  active={sort.key === 'warningFindings'}
                  direction={sort.direction}
                  onSort={() => selectSort('warningFindings')}
                  align="right"
                />
                <SortableTableHead
                  label="Suggestion"
                  active={sort.key === 'suggestionFindings'}
                  direction={sort.direction}
                  onSort={() => selectSort('suggestionFindings')}
                  align="right"
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground h-20 text-center">
                    No repository analytics for this selection.
                  </TableCell>
                </TableRow>
              ) : (
                sortedRows.map(row => (
                  <TableRow key={row.repository}>
                    <TableCell className="max-w-80 truncate font-medium" title={row.repository}>
                      {row.repository}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.trackedPrsOrMrs.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.estimatedImpactPoints.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.highImpactChanges.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.criticalFindings.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.warningFindings.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.suggestionFindings.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function ContributorLeaderboard({ rows }: { rows: ContributorRow[] }) {
  const [sort, setSort] = useState<{
    key: ContributorSortKey;
    direction: SortDirection;
  }>({ key: 'estimatedImpactPoints', direction: 'descending' });

  const sortedRows = useMemo(() => {
    return [...rows].sort((left, right) => {
      if (left.limitedData !== right.limitedData) return left.limitedData ? 1 : -1;

      let result: number;
      switch (sort.key) {
        case 'displayName':
          result = compareText(left.displayName, right.displayName, sort.direction);
          break;
        case 'prsWithoutCriticalFindings':
          result = compareNumbers(
            left.prsWithoutCriticalFindings,
            right.prsWithoutCriticalFindings,
            sort.direction
          );
          break;
        case 'trackedPrs':
          result = compareNumbers(left.trackedPrs, right.trackedPrs, sort.direction);
          break;
        case 'estimatedImpactPoints':
          result = compareNumbers(
            left.estimatedImpactPoints,
            right.estimatedImpactPoints,
            sort.direction
          );
          break;
        case 'highImpactPrs':
          result = compareNumbers(left.highImpactPrs, right.highImpactPrs, sort.direction);
          break;
        case 'criticalFindings':
          result = compareNumbers(left.criticalFindings, right.criticalFindings, sort.direction);
          break;
        case 'warningFindings':
          result = compareNumbers(left.warningFindings, right.warningFindings, sort.direction);
          break;
        case 'suggestionFindings':
          result = compareNumbers(
            left.suggestionFindings,
            right.suggestionFindings,
            sort.direction
          );
          break;
      }
      return result || left.contributorKey.localeCompare(right.contributorKey);
    });
  }, [rows, sort]);

  const selectSort = (key: ContributorSortKey) => {
    setSort(current => ({
      key,
      direction: nextSortDirection(
        current.key,
        key,
        current.direction,
        key === 'displayName' ? 'ascending' : 'descending'
      ),
    }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>PR author leaderboard</CardTitle>
        <CardDescription>
          Impact and findings are model-generated review signals. They are not an individual
          performance score.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          className="focus-visible:ring-ring/50 overflow-x-auto rounded-md focus-visible:ring-[3px] focus-visible:outline-none"
          tabIndex={0}
          role="region"
          aria-label="GitHub pull request author leaderboard"
        >
          <Table className="min-w-[1120px]">
            <TableHeader>
              <TableRow>
                <SortableTableHead
                  label="Author"
                  active={sort.key === 'displayName'}
                  direction={sort.direction}
                  onSort={() => selectSort('displayName')}
                />
                <SortableTableHead
                  label="PRs without critical findings"
                  sortLabel="pull requests without critical findings raised"
                  active={sort.key === 'prsWithoutCriticalFindings'}
                  direction={sort.direction}
                  onSort={() => selectSort('prsWithoutCriticalFindings')}
                  align="right"
                />
                <SortableTableHead
                  label="Tracked PRs"
                  active={sort.key === 'trackedPrs'}
                  direction={sort.direction}
                  onSort={() => selectSort('trackedPrs')}
                  align="right"
                />
                <SortableTableHead
                  label="Impact points"
                  sortLabel="estimated impact points"
                  active={sort.key === 'estimatedImpactPoints'}
                  direction={sort.direction}
                  onSort={() => selectSort('estimatedImpactPoints')}
                  align="right"
                />
                <SortableTableHead
                  label="High-impact PRs"
                  active={sort.key === 'highImpactPrs'}
                  direction={sort.direction}
                  onSort={() => selectSort('highImpactPrs')}
                  align="right"
                />
                <SortableTableHead
                  label="Critical"
                  active={sort.key === 'criticalFindings'}
                  direction={sort.direction}
                  onSort={() => selectSort('criticalFindings')}
                  align="right"
                />
                <SortableTableHead
                  label="Warning"
                  active={sort.key === 'warningFindings'}
                  direction={sort.direction}
                  onSort={() => selectSort('warningFindings')}
                  align="right"
                />
                <SortableTableHead
                  label="Suggestion"
                  active={sort.key === 'suggestionFindings'}
                  direction={sort.direction}
                  onSort={() => selectSort('suggestionFindings')}
                  align="right"
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground h-20 text-center">
                    No contributor analytics for this selection.
                  </TableCell>
                </TableRow>
              ) : (
                sortedRows.map(row => (
                  <TableRow key={row.contributorKey}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{row.displayName || 'Unknown author'}</span>
                        {row.limitedData && <Badge variant="outline">Limited data</Badge>}
                        {row.limitedIdentity && <Badge variant="outline">Limited identity</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.prsWithoutCriticalFindings.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.trackedPrs.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.estimatedImpactPoints.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.highImpactPrs.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.criticalFindings.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.warningFindings.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.suggestionFindings.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export function AnalyticsTables({ platform, repositories, contributors }: AnalyticsTablesProps) {
  return (
    <div className="space-y-6">
      <RepositoryAnalyticsTable platform={platform} rows={repositories} />
      {platform === 'gitlab' ? (
        <div className="bg-muted/20 flex items-start gap-3 rounded-xl border p-4">
          <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="text-muted-foreground text-sm">
            Stable merge request author attribution is not available yet.
          </p>
        </div>
      ) : contributors.capability === 'available' ? (
        <ContributorLeaderboard rows={contributors.rows} />
      ) : null}
    </div>
  );
}
