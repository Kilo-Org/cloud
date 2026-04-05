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
import { CheckCircle2 } from 'lucide-react';
import { format } from 'date-fns';
import Link from 'next/link';
import { SeverityBadge } from '../SeverityBadge';

type OverdueFinding = {
  id: string;
  severity: string;
  title: string;
  repoFullName: string;
  packageName: string;
  slaDueAt: string;
  daysOverdue: number;
};

type OverdueFindingsTableProps = {
  findings: OverdueFinding[];
  isLoading: boolean;
  basePath: string;
  extraParams?: string;
};

function toSeverity(s: string): 'critical' | 'high' | 'medium' | 'low' {
  if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low') {
    return s;
  }
  return 'medium';
}

export function OverdueFindingsTable({
  findings,
  isLoading,
  basePath,
  extraParams = '',
}: OverdueFindingsTableProps) {
  return (
    <Card className="border border-gray-800 bg-gray-900/50">
      <CardHeader>
        <CardTitle className="text-sm font-medium">Overdue Findings</CardTitle>
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
        ) : findings.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-sm">
            <CheckCircle2 className="h-8 w-8 text-green-400" />
            <span className="text-muted-foreground">No overdue findings</span>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-gray-800 hover:bg-transparent">
                    <TableHead>Severity</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Repository</TableHead>
                    <TableHead>Package</TableHead>
                    <TableHead className="text-right">Days Overdue</TableHead>
                    <TableHead className="text-right">SLA Due Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {findings.map(finding => (
                    <TableRow key={finding.id} className="border-gray-800">
                      <TableCell>
                        <Link
                          href={`${basePath}/findings?status=open&overdue=true&findingId=${finding.id}${extraParams}`}
                        >
                          <SeverityBadge severity={toSeverity(finding.severity)} size="sm" />
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        <Link
                          href={`${basePath}/findings?status=open&overdue=true&findingId=${finding.id}${extraParams}`}
                          className="truncate text-sm text-gray-300 hover:text-white"
                          title={finding.title}
                        >
                          <span className="block truncate">{finding.title}</span>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <span className="text-muted-foreground text-xs">
                          {finding.repoFullName}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-muted-foreground text-xs">{finding.packageName}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="font-medium text-red-400">{finding.daysOverdue}d</span>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="text-muted-foreground text-xs">
                          {format(new Date(finding.slaDueAt), 'MMM d, yyyy')}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="mt-3 text-right">
              <Link
                href={`${basePath}/findings?status=open&overdue=true${extraParams}`}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                View all overdue &rarr;
              </Link>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
