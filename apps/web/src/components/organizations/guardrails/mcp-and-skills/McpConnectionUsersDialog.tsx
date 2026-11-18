'use client';

import { useQuery } from '@tanstack/react-query';
import type { OrganizationMcpConnectDecision } from '@kilocode/db/schema-types';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTRPC } from '@/lib/trpc/utils';
import { clientLabel, decisionLabel } from './guardrail-display';
import { formatConnectTime } from './format-connect-time';

export function McpConnectionUsersDialog({
  organizationId,
  identityKey,
  title,
  decision,
  client,
  onClose,
}: {
  organizationId: string;
  identityKey: string;
  title: string;
  decision?: OrganizationMcpConnectDecision;
  client?: string;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const usersQuery = useQuery(
    trpc.organizations.mcpGuardrails.connectionUsers.queryOptions({
      organizationId,
      identityKey,
      decision,
      client,
    })
  );

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Members who connected to this server.</DialogDescription>
        </DialogHeader>
        {usersQuery.isPending ? (
          <Skeleton className="h-32 w-full" aria-busy="true" />
        ) : usersQuery.isError ? (
          <p role="alert" className="text-destructive text-sm">
            {usersQuery.error.message}
          </p>
        ) : usersQuery.data.users.length === 0 ? (
          <p className="text-muted-foreground text-sm">No members match the current filters.</p>
        ) : (
          <div className="max-h-96 overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-right">Connects</TableHead>
                  <TableHead>Last connected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersQuery.data.users.map(user => (
                  <TableRow key={`${user.userId}:${user.client}:${user.decision}`}>
                    <TableCell className="max-w-56">
                      <div className="grid">
                        <span className="truncate font-medium">{user.name ?? 'Unknown user'}</span>
                        {user.email && (
                          <span className="text-muted-foreground truncate text-xs">
                            {user.email}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{clientLabel(user.client)}</TableCell>
                    <TableCell>
                      <Badge variant={user.decision === 'denied' ? 'destructive' : 'outline'}>
                        {decisionLabel(user.decision)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{user.connects}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatConnectTime(user.lastSeenAt)}
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
