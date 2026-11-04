'use client';

import { useQuery } from '@tanstack/react-query';
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
import type { PermissionEventDecision } from '@/lib/organizations/permissions/types';
import { useTRPC } from '@/lib/trpc/utils';
import { clientLabel } from '../mcp-and-skills/guardrail-display';
import { formatConnectTime } from '../mcp-and-skills/format-connect-time';
import { eventDecisionLabel } from './permission-display';
import type { PermissionEventFilters } from './PermissionUsageLog';

export function PermissionEventUsersDialog({
  organizationId,
  permission,
  commandKey,
  filters,
  onClose,
}: {
  organizationId: string;
  permission: string;
  commandKey: string;
  filters: PermissionEventFilters;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const usersQuery = useQuery(
    trpc.organizations.permissionRules.eventUsers.queryOptions({
      organizationId,
      permission,
      commandKey,
      ...filters,
    })
  );

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-mono">
            {permission} {commandKey}
          </DialogTitle>
          <DialogDescription>Members who used this tool or command.</DialogDescription>
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
                  <TableHead className="text-right">Uses</TableHead>
                  <TableHead>Last used</TableHead>
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
                      <DecisionBadge decision={user.decision} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{user.uses}</TableCell>
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

function DecisionBadge({ decision }: { decision: PermissionEventDecision }) {
  return (
    <Badge variant={decision === 'denied' ? 'destructive' : 'outline'}>
      {eventDecisionLabel(decision)}
    </Badge>
  );
}
