'use client';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';
import { AlertTriangle } from 'lucide-react';

type ActiveKiloclawsTableProps = {
  organizationId: string;
};

export function ActiveKiloclawsTable({ organizationId }: ActiveKiloclawsTableProps) {
  const trpc = useTRPC();
  const { data, isLoading, isError } = useQuery(
    trpc.organizations.kiloclaw.listActiveInstances.queryOptions({
      organizationId,
    })
  );

  const instanceCount = data?.length ?? 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          Active KiloClaws
          {!isLoading && !isError && (
            <span className="text-muted-foreground ml-2 text-sm font-normal">
              {instanceCount} {instanceCount === 1 ? 'instance' : 'instances'}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-4/5" />
          </div>
        ) : isError ? (
          <div className="flex items-start gap-3 px-4 pb-4 pt-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <p className="text-muted-foreground">
              Unable to load active KiloClaw instances. Please try again later.
            </p>
          </div>
        ) : instanceCount === 0 ? (
          <p className="text-muted-foreground px-4 pb-4 pt-2 text-sm">
            No active KiloClaw instances in this organization.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[680px] table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40%]">User</TableHead>
                  <TableHead className="w-[30%]">Instance Name</TableHead>
                  <TableHead className="w-[18%]">Created</TableHead>
                  <TableHead className="w-[12%]">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.map(instance => (
                  <TableRow key={instance.id}>
                    <TableCell className="max-w-0 text-sm">
                      <span className="block truncate" title={instance.userEmail}>
                        {instance.userEmail}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-0 text-sm">
                      {instance.name ? (
                        <span className="block truncate" title={instance.name}>
                          {instance.name}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatIsoDateString_UsaDateOnlyFormat(instance.createdAt)}
                    </TableCell>
                    <TableCell>
                      {instance.isSuspended ? (
                        <Badge variant="destructive" className="text-xs">
                          Suspended
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">
                          Active
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
