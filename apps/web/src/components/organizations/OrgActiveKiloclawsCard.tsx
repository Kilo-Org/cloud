'use client';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  const { data, isLoading } = useQuery(
    trpc.organizations.kiloclaw.listActiveInstances.queryOptions({ organizationId })
  );

  const activeEmails = [...new Set(data?.filter(i => !i.isSuspended).map(i => i.userEmail) ?? [])];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          Active KiloClaws
          {!isLoading && (
            <Badge variant="secondary" className="text-xs font-normal">
              {activeEmails.length} {activeEmails.length === 1 ? 'KiloClaw' : 'KiloClaws'}
            </Badge>
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
        ) : activeEmails.length === 0 ? (
          <p className="text-muted-foreground px-4 pb-4 pt-2 text-sm">
            No active KiloClaw instances in this organization.
          </p>
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-full px-6">Owner</TableHead>
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
