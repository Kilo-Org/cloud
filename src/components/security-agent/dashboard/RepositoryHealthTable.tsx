'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import Link from 'next/link';

type RepoHealth = {
  repoFullName: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  overdue: number;
  slaCompliancePercent: number;
};

type RepositoryHealthTableProps = {
  repos: RepoHealth[];
  isLoading: boolean;
  basePath: string;
  extraParams?: string;
};

function countCell(count: number) {
  if (count === 0) {
    return <span className="text-muted-foreground">-</span>;
  }
  return <span className="text-foreground font-medium">{count}</span>;
}

function complianceColor(pct: number): string {
  if (pct >= 90) return 'text-green-400';
  if (pct >= 70) return 'text-yellow-400';
  return 'text-red-400';
}

export function RepositoryHealthTable({
  repos,
  isLoading,
  basePath,
  extraParams = '',
}: RepositoryHealthTableProps) {
  return (
    <Card className="border border-gray-800 bg-gray-900/50">
      <CardHeader>
        <CardTitle className="text-sm font-medium">Repository Health</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : repos.length === 0 ? (
          <div className="text-muted-foreground py-6 text-center text-sm">
            No repositories with open findings
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-gray-800 hover:bg-transparent">
                    <TableHead>Repository</TableHead>
                    <TableHead className="text-center">Critical</TableHead>
                    <TableHead className="text-center">High</TableHead>
                    <TableHead className="text-center">Medium</TableHead>
                    <TableHead className="text-center">Low</TableHead>
                    <TableHead className="text-center">Overdue</TableHead>
                    <TableHead className="text-right">SLA %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {repos.map(repo => (
                    <TableRow key={repo.repoFullName} className="border-gray-800">
                      <TableCell>
                        <Link
                          href={`${basePath}/findings?repoFullName=${encodeURIComponent(repo.repoFullName)}${extraParams}`}
                          className="text-sm text-gray-300 hover:text-white"
                        >
                          {repo.repoFullName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-center">{countCell(repo.critical)}</TableCell>
                      <TableCell className="text-center">{countCell(repo.high)}</TableCell>
                      <TableCell className="text-center">{countCell(repo.medium)}</TableCell>
                      <TableCell className="text-center">{countCell(repo.low)}</TableCell>
                      <TableCell className="text-center">{countCell(repo.overdue)}</TableCell>
                      <TableCell className="text-right">
                        <span
                          className={cn('font-medium', complianceColor(repo.slaCompliancePercent))}
                        >
                          {repo.slaCompliancePercent}%
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {repos.length >= 10 && (
              <div className="mt-3 text-right">
                <Link
                  href={`${basePath}/findings?status=open${extraParams}`}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  View all &rarr;
                </Link>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
