'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Loader2,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Square,
  Clock,
  Terminal,
  ShieldAlert,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { stripAnsi } from '@/lib/stripAnsi';

const PAGE_SIZE = 25;

type RunStatus = 'all' | 'running' | 'completed' | 'failed' | 'cancelled';
type InitiatedByFilter = 'all' | 'admin' | 'user';

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return (
        <Badge variant="outline" className="border-blue-500/30 text-blue-400">
          <Clock className="mr-1 h-3 w-3" />
          Running
        </Badge>
      );
    case 'completed':
      return (
        <Badge variant="outline" className="border-emerald-500/30 text-emerald-400">
          <CheckCircle2 className="mr-1 h-3 w-3" />
          Completed
        </Badge>
      );
    case 'failed':
      return (
        <Badge variant="outline" className="border-red-500/30 text-red-400">
          <XCircle className="mr-1 h-3 w-3" />
          Failed
        </Badge>
      );
    case 'cancelled':
      return (
        <Badge variant="outline" className="border-yellow-500/30 text-yellow-400">
          <Square className="mr-1 h-3 w-3" />
          Cancelled
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function CliRunsTab() {
  const trpc = useTRPC();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<RunStatus>('all');
  const [initiatedByFilter, setInitiatedByFilter] = useState<InitiatedByFilter>('all');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const [debounceTimer, setDebounceTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (debounceTimer) clearTimeout(debounceTimer);
    setDebounceTimer(
      setTimeout(() => {
        setDebouncedSearch(value);
        setPage(0);
      }, 300)
    );
  };

  const { data, isLoading } = useQuery(
    trpc.admin.kiloclawInstances.listAllCliRuns.queryOptions(
      {
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
        search: debouncedSearch || undefined,
        status: statusFilter,
        initiatedBy: initiatedByFilter,
      },
      { staleTime: 10_000 }
    )
  );

  const pagination = data?.pagination;
  const runs = data?.runs ?? [];
  const selectedRun = runs.find(r => r.id === selectedRunId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="flex items-center gap-3">
        <Input
          placeholder="Search by email, prompt, or instance ID..."
          value={search}
          onChange={e => handleSearchChange(e.target.value)}
          className="max-w-sm"
        />
        <Select
          value={statusFilter}
          onValueChange={v => {
            setStatusFilter(v as RunStatus);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={initiatedByFilter}
          onValueChange={v => {
            setInitiatedByFilter(v as InitiatedByFilter);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="admin">Admin only</SelectItem>
            <SelectItem value="user">User only</SelectItem>
          </SelectContent>
        </Select>
        {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
        {pagination && (
          <span className="text-muted-foreground ml-auto text-sm">
            {pagination.total} run{pagination.total !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* 2-column layout */}
      <div className="flex gap-4" style={{ minHeight: 500 }}>
        {/* Left: run list */}
        <div className="flex w-[380px] shrink-0 flex-col rounded-md border">
          <div className="flex-1 overflow-y-auto">
            {runs.length === 0 && !isLoading && (
              <p className="text-muted-foreground py-12 text-center text-sm">No CLI runs found.</p>
            )}
            {runs.map(run => (
              <button
                key={run.id}
                type="button"
                onClick={() => setSelectedRunId(run.id)}
                className={cn(
                  'flex w-full flex-col gap-1 border-b px-3 py-2.5 text-left transition-colors last:border-b-0',
                  selectedRunId === run.id ? 'bg-accent' : 'hover:bg-muted/50'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 truncate font-mono text-xs">
                    {run.user_email ?? run.user_id}
                    {run.initiated_by_admin_id && (
                      <Badge
                        variant="outline"
                        className="border-purple-500/30 px-1 py-0 text-[10px] text-purple-400"
                      >
                        <ShieldAlert className="mr-0.5 h-2.5 w-2.5" />
                        Admin
                      </Badge>
                    )}
                  </span>
                  <StatusBadge status={run.status} />
                </div>
                <p className="text-muted-foreground truncate text-xs">
                  {run.prompt.length > 100 ? run.prompt.slice(0, 100) + '...' : run.prompt}
                </p>
                <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
                  <span className="shrink-0">
                    {formatDistanceToNow(new Date(run.started_at), { addSuffix: true })}
                  </span>
                  {run.completed_at && (
                    <>
                      <span className="shrink-0">&middot;</span>
                      <span className="shrink-0">
                        {formatDuration(run.started_at, run.completed_at)}
                      </span>
                    </>
                  )}
                  {run.exit_code !== null && run.status === 'failed' && (
                    <>
                      <span className="shrink-0">&middot;</span>
                      <span className="shrink-0">exit {run.exit_code}</span>
                    </>
                  )}
                  {run.instance_id && (
                    <>
                      <span className="shrink-0">&middot;</span>
                      <span className="shrink-0 font-mono" title={run.instance_id}>
                        {run.instance_id.slice(0, 8)}
                      </span>
                    </>
                  )}
                </div>
              </button>
            ))}
          </div>

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-between border-t px-3 py-2">
              <span className="text-muted-foreground text-xs">
                {page + 1}/{pagination.totalPages}
              </span>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={page === 0}
                  onClick={() => setPage(p => p - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={page + 1 >= pagination.totalPages}
                  onClick={() => setPage(p => p + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Right: selected run detail */}
        <div className="flex min-w-0 flex-1 flex-col rounded-md border">
          {selectedRun ? (
            <RunDetail run={selectedRun} />
          ) : (
            <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2">
              <Terminal className="h-8 w-8" />
              <p className="text-sm">Select a run to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunDetail({
  run,
}: {
  run: {
    id: string;
    user_id: string;
    user_email: string | null;
    instance_id: string | null;
    initiated_by_admin_id: string | null;
    initiated_by_admin_email: string | null;
    prompt: string;
    status: string;
    exit_code: number | null;
    started_at: string;
    completed_at: string | null;
  };
}) {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.admin.kiloclawInstances.getCliRunOutput.queryOptions({
      userId: run.user_id,
      runId: run.id,
    })
  );
  const output = data?.output ?? null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Subject header: user/instance + timing on the left, status + admin badge on the right */}
      <div className="bg-muted/30 flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="text-muted-foreground/70 flex min-w-0 flex-col gap-1 font-mono text-sm">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="shrink-0">{run.user_email ?? run.user_id}</span>
            {run.instance_id && (
              <span className="min-w-0 truncate text-xs" title={run.instance_id}>
                ({run.instance_id})
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="shrink-0" title={new Date(run.started_at).toLocaleString()}>
              {formatDistanceToNow(new Date(run.started_at), { addSuffix: true })}
            </span>
            {run.completed_at && (
              <>
                <span className="shrink-0">&middot;</span>
                <span className="shrink-0">{formatDuration(run.started_at, run.completed_at)}</span>
              </>
            )}
            {run.exit_code !== null && (
              <>
                <span className="shrink-0">&middot;</span>
                <span className="shrink-0">exit {run.exit_code}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge status={run.status} />
          {run.initiated_by_admin_id && (
            <Badge
              variant="outline"
              className="gap-1 border-purple-500/30 px-1.5 py-0 text-[10px] font-normal text-purple-400"
            >
              <ShieldAlert className="m-1 h-3 w-3" />
              <span className="font-mono text-sm">
                {run.initiated_by_admin_email ?? run.initiated_by_admin_id}
              </span>
            </Badge>
          )}
        </div>
      </div>

      {/* Prompt (as a blockquote) + output form a single transcript panel. */}
      <div className="flex-1 overflow-auto">
        <div className="px-4 py-3">
          <blockquote className="text-muted-foreground border-muted-foreground/40 mb-3 border-l-2 pl-3 text-sm leading-relaxed break-words whitespace-pre-wrap italic">
            {run.prompt}
          </blockquote>
          {isLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-muted-foreground text-sm">Loading output...</span>
            </div>
          ) : output ? (
            <pre
              className="text-xs leading-relaxed whitespace-pre"
              style={{ fontFamily: "'Courier New', Courier, monospace", tabSize: 8 }}
            >
              {stripAnsi(output)}
            </pre>
          ) : (
            <p className="text-muted-foreground text-sm italic">
              {run.status === 'running'
                ? 'Output will appear when the run completes.'
                : 'No output recorded.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
