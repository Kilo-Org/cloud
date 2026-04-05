'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Link from 'next/link';
import { formatDistanceToNow, format } from 'date-fns';
import { ArrowLeft, ChevronDown, ChevronUp } from 'lucide-react';

type SortDir = 'asc' | 'desc';

export function AuditLogDashboard({ townId }: { townId: string }) {
  const trpc = useTRPC();

  const [search, setSearch] = useState('');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const auditQuery = useQuery(trpc.admin.gastown.listAuditLog.queryOptions({ townId }));
  const entries = auditQuery.data ?? [];

  const filtered = entries.filter(entry => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      entry.admin_user_id.toLowerCase().includes(q) ||
      entry.action.toLowerCase().includes(q) ||
      (entry.target_type ?? '').toLowerCase().includes(q) ||
      (entry.target_id ?? '').toLowerCase().includes(q)
    );
  });

  const sorted = [...filtered].sort((a, b) => {
    const diff = new Date(a.performed_at).getTime() - new Date(b.performed_at).getTime();
    return sortDir === 'desc' ? -diff : diff;
  });

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="flex w-full flex-col gap-y-6">
      {/* Header */}
      <div>
        <Link
          href={`/admin/gastown/towns/${townId}`}
          className="text-muted-foreground hover:text-foreground mb-2 flex items-center gap-1 text-sm transition-colors"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to Town Inspector
        </Link>
        <h1 className="text-2xl font-semibold">Audit Log</h1>
        <p className="text-muted-foreground font-mono text-sm">{townId}</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Admin Actions</CardTitle>
            <Input
              placeholder="Search by action, user, target…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-8 w-64 text-xs"
            />
          </div>
        </CardHeader>
        <CardContent>
          {auditQuery.isLoading && (
            <p className="text-muted-foreground py-8 text-center text-sm">Loading audit log…</p>
          )}
          {auditQuery.isError && (
            <p className="py-8 text-center text-sm text-red-400">
              Failed to load audit log: {auditQuery.error.message}
            </p>
          )}
          {!auditQuery.isLoading && sorted.length === 0 && (
            <p className="text-muted-foreground py-8 text-center text-sm">
              {entries.length === 0
                ? 'No audit log entries found. (Requires bead 0 admin endpoints.)'
                : 'No entries match the current search.'}
            </p>
          )}
          {sorted.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-muted-foreground pb-2 text-left font-medium">
                      <button
                        className="hover:text-foreground flex items-center gap-1 transition-colors"
                        onClick={() => setSortDir(d => (d === 'desc' ? 'asc' : 'desc'))}
                      >
                        Time
                        {sortDir === 'desc' ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronUp className="h-3 w-3" />
                        )}
                      </button>
                    </th>
                    <th className="text-muted-foreground pb-2 text-left font-medium">Admin</th>
                    <th className="text-muted-foreground pb-2 text-left font-medium">Action</th>
                    <th className="text-muted-foreground pb-2 text-left font-medium">
                      Target Type
                    </th>
                    <th className="text-muted-foreground pb-2 text-left font-medium">Target ID</th>
                    <th className="text-muted-foreground pb-2 text-left font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(entry => {
                    const isExpanded = expandedIds.has(entry.id);
                    const hasDetail = entry.detail != null && Object.keys(entry.detail).length > 0;
                    return (
                      <React.Fragment key={entry.id}>
                        <tr className="hover:bg-muted/40 border-b transition-colors">
                          <td
                            className="text-muted-foreground py-2 pr-4 text-xs"
                            title={format(new Date(entry.performed_at), 'PPpp')}
                          >
                            {formatDistanceToNow(new Date(entry.performed_at), {
                              addSuffix: true,
                            })}
                          </td>
                          <td className="py-2 pr-4">
                            <span className="font-mono text-xs">{entry.admin_user_id}</span>
                          </td>
                          <td className="py-2 pr-4">
                            <span className="rounded bg-gray-500/10 px-1.5 py-0.5 font-mono text-xs">
                              {entry.action}
                            </span>
                          </td>
                          <td className="text-muted-foreground py-2 pr-4 font-mono text-xs">
                            {entry.target_type ?? '—'}
                          </td>
                          <td className="py-2 pr-4">
                            {entry.target_id ? (
                              <TargetLink
                                townId={townId}
                                targetType={entry.target_type}
                                targetId={entry.target_id}
                              />
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </td>
                          <td className="py-2">
                            {hasDetail ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-xs"
                                onClick={() => toggleExpand(entry.id)}
                              >
                                {isExpanded ? 'Hide' : 'Show'}
                              </Button>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </td>
                        </tr>
                        {isExpanded && hasDetail && (
                          <tr className="border-b">
                            <td colSpan={6} className="bg-muted/20 py-2 pr-4 pl-4">
                              <pre className="overflow-x-auto rounded bg-gray-900/50 p-3 font-mono text-xs text-gray-300">
                                {JSON.stringify(entry.detail, null, 2)}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TargetLink({
  townId,
  targetType,
  targetId,
}: {
  townId: string;
  targetType: string | null;
  targetId: string;
}) {
  if (targetType === 'bead') {
    return (
      <Link
        href={`/admin/gastown/towns/${townId}/beads/${targetId}`}
        className="font-mono text-xs text-blue-400 hover:underline"
      >
        {targetId.slice(0, 8)}…
      </Link>
    );
  }
  if (targetType === 'agent') {
    return (
      <Link
        href={`/admin/gastown/towns/${townId}/agents/${targetId}`}
        className="font-mono text-xs text-blue-400 hover:underline"
      >
        {targetId.slice(0, 8)}…
      </Link>
    );
  }
  return <span className="font-mono text-xs">{targetId.slice(0, 8)}…</span>;
}
