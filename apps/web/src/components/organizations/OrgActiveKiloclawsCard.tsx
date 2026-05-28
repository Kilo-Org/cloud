'use client';
import { AlertTriangle, Users } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type Props = {
  organizationId: string;
};

export function OrgActiveKiloclawsCard({ organizationId }: Props) {
  const trpc = useTRPC();
  const { data, isLoading, isError } = useQuery(
    trpc.organizations.kiloclaw.listActiveInstances.queryOptions({ organizationId })
  );

  const activeEmails = [...new Set(data?.filter(i => !i.isSuspended).map(i => i.userEmail) ?? [])];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex min-h-8 items-center gap-2">
          <Users className="h-4 w-4" />
          <CardTitle>Active KiloClaws</CardTitle>
        </div>
        {!isLoading && !isError && (
          <CardDescription className="text-xs">
            You have {activeEmails.length} active KiloClaw
            {activeEmails.length !== 1 ? 's' : ''} in this organization
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="pt-0">
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
        ) : activeEmails.length === 0 ? (
          <p className="text-muted-foreground px-4 pb-4 pt-2 text-sm">
            No active KiloClaw instances in this organization.
          </p>
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-full px-6 text-muted-foreground text-xs font-normal">
                  Owner
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeEmails.map(email => (
                <TableRow key={email}>
                  <TableCell className="max-w-0 px-6 text-sm">
                    <span className="block truncate" title={email}>
                      {email}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
