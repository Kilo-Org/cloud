'use client';

import { useState, type FormEvent } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import Link from 'next/link';

import { AdminActionAuditAction, type AdminActionAuditTargetType } from '@kilocode/db/schema-types';
import type { RootRouter } from '@/routers/root-router';
import { useTRPC } from '@/lib/trpc/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const PAGE_SIZE = 50;
const ANY = 'any';

type RouterInputs = inferRouterInputs<RootRouter>;
type RouterOutputs = inferRouterOutputs<RootRouter>;
type ListInput = RouterInputs['admin']['actionAuditLogs']['list'];
type Cursor = NonNullable<ListInput['cursor']>;
export type AdminActionAuditLogRow =
  RouterOutputs['admin']['actionAuditLogs']['list']['rows'][number];

type Filters = {
  action: string;
  actorEmail: string;
  targetType: string;
  targetId: string;
  search: string;
};

const EMPTY_FILTERS: Filters = {
  action: ANY,
  actorEmail: '',
  targetType: ANY,
  targetId: '',
  search: '',
};

export function toListInput(filters: Filters): Omit<ListInput, 'cursor' | 'limit'> {
  const action = AdminActionAuditAction.safeParse(filters.action);
  return {
    action: action.success ? action.data : undefined,
    actorEmail: filters.actorEmail.trim() || undefined,
    targetType:
      filters.targetType === 'user' || filters.targetType === 'organization'
        ? filters.targetType
        : undefined,
    targetId: filters.targetId.trim() || undefined,
    search: filters.search.trim() || undefined,
  };
}

export function AdminActionAuditLogContent() {
  const trpc = useTRPC();
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  // Cursor for each visited page; the first page has none.
  const [cursors, setCursors] = useState<(Cursor | undefined)[]>([undefined]);
  const cursor = cursors.at(-1);

  const logsQuery = useQuery({
    ...trpc.admin.actionAuditLogs.list.queryOptions({
      ...toListInput(applied),
      limit: PAGE_SIZE,
      cursor,
    }),
    placeholderData: keepPreviousData,
  });
  const rows = logsQuery.data?.rows ?? [];
  const nextCursor = logsQuery.data?.nextCursor ?? null;

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setApplied(draft);
    setCursors([undefined]);
  }

  function clearFilters() {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setCursors([undefined]);
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold">Admin Action Log</h2>
        <p className="text-muted-foreground max-w-4xl">
          Actions platform admins took on users and organizations. Entries are kept for six months.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Search</CardTitle>
          <CardDescription>
            Filter by action, admin, or target. Newest entries first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={applyFilters} className="flex flex-wrap items-start gap-3">
            <div className="w-64 space-y-1.5">
              <Label htmlFor="audit-action">Action</Label>
              <Select
                value={draft.action}
                onValueChange={action => setDraft(current => ({ ...current, action }))}
              >
                <SelectTrigger id="audit-action" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any action</SelectItem>
                  {AdminActionAuditAction.options.map(action => (
                    <SelectItem key={action} value={action}>
                      {action}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-64 space-y-1.5">
              <Label htmlFor="audit-actor">Admin email</Label>
              <Input
                id="audit-actor"
                type="email"
                value={draft.actorEmail}
                onChange={event =>
                  setDraft(current => ({ ...current, actorEmail: event.target.value }))
                }
                placeholder="admin@kilocode.ai"
              />
            </div>
            <div className="w-40 space-y-1.5">
              <Label htmlFor="audit-target-type">Target type</Label>
              <Select
                value={draft.targetType}
                onValueChange={targetType => setDraft(current => ({ ...current, targetType }))}
              >
                <SelectTrigger id="audit-target-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any target</SelectItem>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="organization">Organization</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-72 space-y-1.5">
              <Label htmlFor="audit-target-id">Target ID</Label>
              <Input
                id="audit-target-id"
                value={draft.targetId}
                onChange={event =>
                  setDraft(current => ({ ...current, targetId: event.target.value }))
                }
                placeholder="User or organization ID"
              />
            </div>
            <div className="w-64 space-y-1.5">
              <Label htmlFor="audit-search">Message contains</Label>
              <Input
                id="audit-search"
                value={draft.search}
                onChange={event =>
                  setDraft(current => ({ ...current, search: event.target.value }))
                }
              />
            </div>
            <div className="flex gap-2 self-end">
              <Button type="submit" size="sm">
                Search
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={clearFilters}>
                Clear
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          {logsQuery.isError ? (
            <p className="text-destructive text-sm" role="alert">
              The admin action log could not be loaded. Refresh the page to try again.
            </p>
          ) : (
            <>
              <AdminActionAuditLogTable rows={rows} isLoading={logsQuery.isLoading} />
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setCursors(current => current.slice(0, -1))}
                  disabled={cursors.length <= 1 || logsQuery.isFetching}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    if (nextCursor) setCursors(current => [...current, nextCursor]);
                  }}
                  disabled={!nextCursor || logsQuery.isFetching}
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function AdminActionAuditLogTable({
  rows,
  isLoading,
}: {
  rows: AdminActionAuditLogRow[];
  isLoading: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Admin</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground h-24 text-center">
                {isLoading ? 'Loading admin actions...' : 'No admin actions match these filters.'}
              </TableCell>
            </TableRow>
          ) : (
            rows.map(row => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap text-sm">
                  {new Date(row.createdAt).toLocaleString()}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-mono">
                    {row.action}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm break-all">
                  <Link
                    href={`/admin/users/${encodeURIComponent(row.actorId)}`}
                    className="hover:underline"
                  >
                    {row.actorEmail ?? row.actorId}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs break-all">
                  <TargetLink type={row.targetType} id={row.targetId} />
                </TableCell>
                <TableCell className="min-w-72 text-sm whitespace-normal">
                  <div>{row.message}</div>
                  {row.metadata ? <MetadataList metadata={row.metadata} /> : null}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function MetadataList({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata);
  if (entries.length === 0) return null;
  return (
    <dl className="text-muted-foreground mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt>{key}</dt>
          <dd className="font-mono break-all">
            {typeof value === 'string' ? value : JSON.stringify(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function TargetLink({ type, id }: { type: AdminActionAuditTargetType | null; id: string | null }) {
  if (!type || !id) return <span className="text-muted-foreground">—</span>;
  const href =
    type === 'user'
      ? `/admin/users/${encodeURIComponent(id)}`
      : `/admin/organizations/${encodeURIComponent(id)}`;
  return (
    <Link href={href} className="hover:underline">
      {type}:{id}
    </Link>
  );
}
