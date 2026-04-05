'use client';

import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatRelativeTime } from '@/lib/admin-utils';

type RecentCodeIndexSearchesProps = {
  organizationId: string;
  searchResults?: unknown;
  submittedSearch: { project: string; branch: string; query: string } | null;
};

export function RecentCodeIndexSearches({
  organizationId,
  searchResults,
  submittedSearch,
}: RecentCodeIndexSearchesProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Fetch recent searches
  const { data: recentSearches, isLoading: isLoadingSearches } = useQuery(
    trpc.codeIndexing.getRecentSearches.queryOptions({ organizationId })
  );

  // State for expanded search row
  const [expandedSearchId, setExpandedSearchId] = useState<string | null>(null);

  // Invalidate recent searches after search results are loaded
  useEffect(() => {
    if (searchResults && submittedSearch) {
      void queryClient.invalidateQueries({
        queryKey: trpc.codeIndexing.getRecentSearches.queryKey({ organizationId }),
      });
    }
  }, [
    searchResults,
    submittedSearch,
    queryClient,
    organizationId,
    trpc.codeIndexing.getRecentSearches,
  ]);

  return (
    <div>
      <h3 className="mb-4 text-lg font-semibold">Recent Searches</h3>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Query</TableHead>
              <TableHead>Project</TableHead>
              <TableHead className="text-right">Results</TableHead>
              <TableHead>Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoadingSearches ? (
              Array.from({ length: 5 }).map((_, idx) => (
                <TableRow key={idx}>
                  <TableCell>
                    <Skeleton className="h-4 w-[200px]" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-[150px]" />
                  </TableCell>
                  <TableCell className="text-right">
                    <Skeleton className="ml-auto h-4 w-[40px]" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-[100px]" />
                  </TableCell>
                </TableRow>
              ))
            ) : !recentSearches || recentSearches.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground h-24 text-center">
                  No searches yet
                </TableCell>
              </TableRow>
            ) : (
              recentSearches.map(search => {
                const isExpanded = expandedSearchId === search.id;
                const metadata = search.metadata as {
                  results?: Array<{
                    id: string;
                    filePath: string;
                    startLine: number;
                    endLine: number;
                    score: number;
                    gitBranch: string;
                    fromPreferredBranch: boolean;
                  }>;
                };
                const results = metadata?.results || [];

                return (
                  <>
                    <TableRow
                      key={search.id}
                      className="hover:bg-muted/50 cursor-pointer"
                      onClick={() => setExpandedSearchId(isExpanded ? null : search.id)}
                    >
                      <TableCell className="font-mono text-sm">
                        <div className="flex items-center gap-2">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 shrink-0" />
                          ) : (
                            <ChevronRight className="h-4 w-4 shrink-0" />
                          )}
                          <span className="max-w-[500px] truncate">{search.query}</span>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{search.project_id}</TableCell>
                      <TableCell className="text-right">{search.results_count}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {formatRelativeTime(search.created_at)}
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow key={`${search.id}-expanded`}>
                        <TableCell colSpan={4} className="bg-muted/30 p-0">
                          <div className="px-4 py-2">
                            <div className="mb-2 text-xs font-semibold">Search Query:</div>
                            <div className="wrap-break-words mb-3 font-mono text-sm">
                              {search.query}
                            </div>
                            <div className="mb-1 text-xs font-semibold">Search Results:</div>
                            {results.length === 0 ? (
                              <div className="text-muted-foreground py-2 text-xs">
                                No results found
                              </div>
                            ) : (
                              <div className="divide-y">
                                {results.map((result, idx) => (
                                  <div
                                    key={idx}
                                    className="flex items-center justify-between py-2 text-xs"
                                  >
                                    <div className="min-w-0 flex-1">
                                      <div className="mb-0.5 font-mono">{result.filePath}</div>
                                      <div className="text-muted-foreground flex gap-3">
                                        <span>
                                          Lines {result.startLine}-{result.endLine}
                                        </span>
                                        <span>Branch: {result.gitBranch}</span>
                                        {result.fromPreferredBranch && (
                                          <Badge variant="secondary" className="h-4 text-xs">
                                            Preferred
                                          </Badge>
                                        )}
                                      </div>
                                    </div>
                                    <div className="ml-4 shrink-0 text-right">
                                      <div className="font-semibold">{result.score.toFixed(3)}</div>
                                      <div className="text-muted-foreground">score</div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      {recentSearches && recentSearches.length > 0 && (
        <div className="text-muted-foreground mt-4 text-sm">
          Showing {recentSearches.length} most recent{' '}
          {recentSearches.length === 1 ? 'search' : 'searches'}
        </div>
      )}
    </div>
  );
}
