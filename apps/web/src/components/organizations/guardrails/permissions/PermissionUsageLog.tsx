'use client';

import { useId, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { MCP_CONNECT_CLIENTS } from '@/lib/organizations/guardrails/mcp-connections';
import type { PermissionEventDecision } from '@/lib/organizations/permissions/types';
import { useTRPC } from '@/lib/trpc/utils';
import { CLIENT_FILTER_OPTIONS, clientLabel } from '../mcp-and-skills/guardrail-display';
import { formatConnectTime } from '../mcp-and-skills/format-connect-time';
import { EVENT_DECISION_OPTIONS } from './permission-display';
import { PermissionEventUsersDialog } from './PermissionEventUsersDialog';
import { showRuleWarnings } from './PermissionRuleDialog';
import type { PermissionEventRow } from './permission-types';

const ALL = 'all';

type Client = (typeof MCP_CONNECT_CLIENTS)[number];
type DecisionFilter = PermissionEventDecision | typeof ALL;

export type PermissionEventFilters = { decision?: PermissionEventDecision; client?: Client };

function eventKey(event: Pick<PermissionEventRow, 'permission' | 'commandKey'>): string {
  return `${event.permission}\u0000${event.commandKey}`;
}

function UseCount({ count }: { count: number }) {
  return count === 0 ? (
    <span className="text-muted-foreground">–</span>
  ) : (
    <span className="tabular-nums">{count}</span>
  );
}

export function PermissionUsageLog({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const titleId = useId();
  const [decision, setDecision] = useState<DecisionFilter>(ALL);
  const [client, setClient] = useState<Client | typeof ALL>(ALL);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);

  const filters: PermissionEventFilters = {
    decision: decision === ALL ? undefined : decision,
    client: client === ALL ? undefined : client,
  };

  const eventsQuery = useInfiniteQuery(
    trpc.organizations.permissionRules.listEvents.infiniteQueryOptions(
      { organizationId, ...filters },
      { getNextPageParam: page => page.nextCursor ?? undefined }
    )
  );
  const events = eventsQuery.data?.pages.flatMap(page => page.events) ?? [];
  const details = events.find(event => eventKey(event) === detailsKey) ?? null;

  const approveMutation = useMutation(
    trpc.organizations.permissionRules.approveEvent.mutationOptions({
      onSuccess: async result => {
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.permissionRules.pathKey(),
        });
        toast.success(`Allowed ${result.rule.permission} ${result.rule.pattern}.`);
        showRuleWarnings(result.warnings);
      },
      onError: error => {
        toast.error(error.message || 'The command couldn’t be allowed. Try again.');
      },
    })
  );

  const filtered = decision !== ALL || client !== ALL;

  return (
    <section aria-labelledby={titleId} className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <h3 id={titleId} className="text-sm font-semibold">
            Usage log
          </h3>
          <p className="text-muted-foreground text-sm">
            What your rules decided for members’ tool and command use, from the past 30 days
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Select value={decision} onValueChange={value => setDecision(value as DecisionFilter)}>
            <SelectTrigger className="w-full sm:w-40" aria-label="Filter by result">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All results</SelectItem>
              {EVENT_DECISION_OPTIONS.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={client} onValueChange={value => setClient(value as Client)}>
            <SelectTrigger className="w-full sm:w-40" aria-label="Filter by client">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All clients</SelectItem>
              {CLIENT_FILTER_OPTIONS.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {eventsQuery.isPending ? (
        <Skeleton className="h-32 w-full" aria-busy="true" />
      ) : eventsQuery.isError ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-destructive text-sm">
            {eventsQuery.error.message}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void eventsQuery.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : events.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-md border border-dashed px-6 py-10 text-center">
          <p className="text-sm font-medium">{filtered ? 'No matching usage' : 'No usage yet'}</p>
          <p className="text-muted-foreground max-w-md text-sm">
            {filtered
              ? 'Try a different result or client.'
              : 'Usage appears here when members’ clients report tool and command use while audit or enforce is on.'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tool or command</TableHead>
                <TableHead>Clients</TableHead>
                <TableHead className="text-right">Allowed</TableHead>
                <TableHead className="text-right">Asked</TableHead>
                <TableHead className="text-right">Denied</TableHead>
                <TableHead className="text-right">Members</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="w-44">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map(event => {
                const key = eventKey(event);
                const name = `${event.permission} ${event.commandKey}`;
                const approvePending =
                  approveMutation.isPending &&
                  approveMutation.variables.permission === event.permission &&
                  approveMutation.variables.commandKey === event.commandKey;
                const canAllow = event.deniedCount > 0 && !event.hasRule;
                return (
                  <TableRow key={key}>
                    <TableCell className="max-w-sm">
                      <span className="flex items-center gap-2">
                        <Badge variant="outline">{event.permission}</Badge>
                        <code className="truncate font-mono text-xs">{event.commandKey}</code>
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {event.clients.map(item => (
                          <Badge key={item} variant="secondary">
                            {clientLabel(item)}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <UseCount count={event.allowedCount} />
                    </TableCell>
                    <TableCell className="text-right">
                      <UseCount count={event.askedCount} />
                    </TableCell>
                    <TableCell className="text-right">
                      <UseCount count={event.deniedCount} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{event.users}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatConnectTime(event.lastSeenAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Members who used ${name}`}
                          onClick={() => setDetailsKey(key)}
                        >
                          Users
                        </Button>
                        {canAllow && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={approvePending}
                            aria-label={`Allow ${name}`}
                            onClick={() =>
                              approveMutation.mutate({
                                organizationId,
                                permission: event.permission,
                                commandKey: event.commandKey,
                              })
                            }
                          >
                            {approvePending ? 'Allowing…' : 'Allow this'}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {eventsQuery.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={eventsQuery.isFetchingNextPage}
          onClick={() => void eventsQuery.fetchNextPage()}
        >
          {eventsQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}

      {details && (
        <PermissionEventUsersDialog
          organizationId={organizationId}
          permission={details.permission}
          commandKey={details.commandKey}
          filters={filters}
          onClose={() => setDetailsKey(null)}
        />
      )}
    </section>
  );
}
