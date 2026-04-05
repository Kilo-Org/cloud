'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDate } from '@/lib/admin-utils';
import { CopyButton } from '@/components/admin/CopyButton';
import { useCodeReviewErrorSessions, type FilterParams } from '@/app/admin/api/code-reviews/hooks';

type CategoryData = {
  category: string;
  count: number;
  firstOccurrence: string;
  lastOccurrence: string;
};

type DetailData = {
  errorType: string;
  category: string;
  count: number;
  firstOccurrence: string;
  lastOccurrence: string;
};

type ErrorAnalysisData = {
  categories: CategoryData[];
  details: DetailData[];
};

type Props = {
  data: ErrorAnalysisData;
  filterParams: FilterParams;
};

const CATEGORY_COLORS: Record<string, string> = {
  'Rate Limited': 'bg-amber-500',
  Timeout: 'bg-orange-500',
  'Context Window Exceeded': 'bg-purple-500',
  'Auth / Permission Error': 'bg-red-500',
  'Not Found': 'bg-slate-500',
  'Upstream Server Error': 'bg-rose-600',
  'Network Error': 'bg-sky-500',
  'Parse Error': 'bg-indigo-500',
  'Unknown Error': 'bg-gray-400',
  Other: 'bg-gray-500',
};

function ErrorSessionsModal({
  error,
  filterParams,
  onClose,
}: {
  error: DetailData;
  filterParams: FilterParams;
  onClose: () => void;
}) {
  const {
    data: sessions,
    isLoading,
    error: fetchError,
  } = useCodeReviewErrorSessions({
    ...filterParams,
    errorMessage: error.errorType,
  });

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Recent Sessions — {error.category}</DialogTitle>
          <DialogDescription className="max-w-full truncate font-mono text-xs">
            {error.errorType}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
          </div>
        ) : fetchError ? (
          <p className="text-destructive py-4 text-center text-sm">
            Failed to load sessions: {fetchError.message}
          </p>
        ) : !sessions?.length ? (
          <p className="text-muted-foreground py-4 text-center text-sm">No sessions found.</p>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session ID</TableHead>
                  <TableHead>User / Org</TableHead>
                  <TableHead>Repo</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Timestamp</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session, idx) => (
                  <TableRow key={session.sessionId ?? `${session.createdAt}-${idx}`}>
                    <TableCell className="font-mono text-xs">
                      {(() => {
                        const copyableId = session.sessionId ?? session.cliSessionId;
                        return (
                          <span className="flex items-center gap-1">
                            {copyableId ?? '—'}
                            {copyableId && <CopyButton text={copyableId} label="session ID" />}
                          </span>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="text-xs">
                      {session.orgId ? (
                        <span title={`Org: ${session.orgId}`}>org:{session.orgId.slice(0, 8)}</span>
                      ) : session.userId ? (
                        <span title={`User: ${session.userId}`}>
                          user:{session.userId.slice(0, 12)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate text-xs">
                      {session.repoFullName}#{session.prNumber}
                    </TableCell>
                    <TableCell className="text-xs">{session.agentVersion ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDate(session.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function CodeReviewErrorAnalysis({ data, filterParams }: Props) {
  const [selectedError, setSelectedError] = useState<DetailData | null>(null);

  const totalCategoryErrors = data.categories.reduce((sum, cat) => sum + cat.count, 0);
  // Use category totals (uncapped) as the denominator so percentages are accurate
  // even when the detail list is truncated to top 50.
  const totalErrors = totalCategoryErrors;
  const maxCategoryCount = Math.max(...data.categories.map(c => c.count), 1);

  if (data.details.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error Analysis</CardTitle>
          <CardDescription>No errors in selected period</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            No failed reviews found in this time range.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Error Analysis</CardTitle>
          <CardDescription>
            {data.categories.length} error categories, {totalCategoryErrors.toLocaleString()} total
            failures
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Category horizontal bar chart */}
          <div className="space-y-2">
            {data.categories.map(cat => {
              const pct = totalCategoryErrors > 0 ? (cat.count / totalCategoryErrors) * 100 : 0;
              const barWidth = (cat.count / maxCategoryCount) * 100;
              const colorClass = CATEGORY_COLORS[cat.category] ?? 'bg-gray-500';
              return (
                <div key={cat.category} className="flex items-center gap-3">
                  <span className="w-44 shrink-0 truncate text-right text-xs font-medium">
                    {cat.category}
                  </span>
                  <div className="bg-muted relative h-5 flex-1 overflow-hidden rounded">
                    <div
                      className={`${colorClass} absolute inset-y-0 left-0 rounded transition-all`}
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>
                  <span className="text-muted-foreground w-20 shrink-0 text-right text-xs">
                    {cat.count.toLocaleString()} ({pct.toFixed(1)}%)
                  </span>
                </div>
              );
            })}
          </div>

          {/* Detail table */}
          <div className="max-h-[400px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="w-[40%]">Error Message</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                  <TableHead className="text-right">% of Errors</TableHead>
                  <TableHead>First Seen</TableHead>
                  <TableHead>Last Seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.details.map((error, idx) => (
                  <TableRow
                    key={idx}
                    className="hover:bg-muted/50 cursor-pointer"
                    onClick={() => setSelectedError(error)}
                  >
                    <TableCell className="text-xs">{error.category}</TableCell>
                    <TableCell
                      className="max-w-[400px] truncate font-mono text-xs"
                      title={error.errorType}
                    >
                      {error.errorType}
                    </TableCell>
                    <TableCell className="text-right font-medium">{error.count}</TableCell>
                    <TableCell className="text-muted-foreground text-right">
                      {((error.count / totalErrors) * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDate(error.firstOccurrence)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDate(error.lastOccurrence)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {selectedError && (
        <ErrorSessionsModal
          error={selectedError}
          filterParams={filterParams}
          onClose={() => setSelectedError(null)}
        />
      )}
    </>
  );
}
