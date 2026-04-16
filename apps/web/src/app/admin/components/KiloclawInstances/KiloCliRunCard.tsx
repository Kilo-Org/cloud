'use client';

import { useRef, useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { CheckCircle2, Clock, Loader2, Square, Terminal, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { stripAnsi } from '@/lib/stripAnsi';
import { DetailField } from './shared';

// Nil UUID used as cache key for disabled queries. react-query requires a stable
// queryKey even when the query is disabled; a nil UUID avoids colliding with
// real run IDs while keeping the key deterministic.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function RunStatusBadge({ status }: { status: string }) {
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

export function KiloCliRunCard({ userId, instanceId }: { userId: string; instanceId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const outputRef = useRef<HTMLPreElement>(null);
  const [prompt, setPrompt] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const { data: runsData } = useQuery({
    ...trpc.admin.kiloclawInstances.listKiloCliRuns.queryOptions({
      userId,
      limit: 5,
    }),
    refetchInterval: activeRunId ? 5_000 : false,
  });

  const latestRun = runsData?.runs[0] ?? null;
  const hasActiveRun = latestRun?.status === 'running';

  // Track the active run — prefer explicit state, fall back to latest running run
  const trackedRunId = activeRunId ?? (hasActiveRun ? latestRun.id : null);

  const { data: runStatus } = useQuery({
    ...trpc.admin.kiloclawInstances.getKiloCliRunStatus.queryOptions({
      userId,
      instanceId,
      runId: trackedRunId ?? NIL_UUID,
    }),
    enabled: !!trackedRunId,
    refetchInterval: trackedRunId ? 3_000 : false,
  });

  // Clear activeRunId when the tracked run reaches a terminal state
  useEffect(() => {
    if (runStatus && runStatus.status !== null && runStatus.status !== 'running') {
      setActiveRunId(null);
    }
  }, [runStatus?.status]);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [runStatus?.output]);

  const startMutation = useMutation(
    trpc.admin.kiloclawInstances.startKiloCliRun.mutationOptions({
      onSuccess: data => {
        setActiveRunId(data.id);
        setPrompt('');
        toast.success('CLI run started');
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.listKiloCliRuns.queryKey(),
        });
      },
      onError: err => {
        toast.error(`Failed to start CLI run: ${err.message}`);
      },
    })
  );

  const cancelMutation = useMutation(
    trpc.admin.kiloclawInstances.cancelKiloCliRun.mutationOptions({
      onSuccess: () => {
        toast.success('CLI run cancelled');
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.listKiloCliRuns.queryKey(),
        });
      },
      onError: err => {
        toast.error(`Failed to cancel CLI run: ${err.message}`);
      },
    })
  );

  const handleStart = () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    startMutation.mutate({ userId, instanceId, prompt: trimmed });
  };

  const handleCancel = () => {
    if (!trackedRunId) return;
    cancelMutation.mutate({ userId, instanceId, runId: trackedRunId });
  };

  const isDone = runStatus?.hasRun && runStatus.status !== null && runStatus.status !== 'running';
  const isRunning = runStatus?.status === 'running';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            <div>
              <CardTitle>CLI Run</CardTitle>
              <CardDescription>
                Start or view Kilo CLI recovery runs for this instance
              </CardDescription>
            </div>
          </div>
          {isRunning && trackedRunId && (
            <Button
              size="sm"
              variant="outline"
              className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
              disabled={cancelMutation.isPending}
              onClick={handleCancel}
            >
              {cancelMutation.isPending ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Square className="mr-1 h-3 w-3" />
              )}
              Cancel Run
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Start new run */}
        {!trackedRunId && (
          <div className="space-y-2">
            <Textarea
              placeholder="Describe the problem to diagnose and fix..."
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              className="min-h-20 resize-none"
              maxLength={10_000}
              disabled={startMutation.isPending || hasActiveRun}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handleStart();
                }
              }}
            />
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-xs">
                Cmd+Enter to start. Runs as admin-initiated recovery.
              </p>
              <Button
                size="sm"
                onClick={handleStart}
                disabled={!prompt.trim() || startMutation.isPending || hasActiveRun}
              >
                {startMutation.isPending ? (
                  <>
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    Starting...
                  </>
                ) : (
                  <>
                    <Terminal className="mr-1 h-3 w-3" />
                    Start Run
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Active/tracked run viewer */}
        {trackedRunId && runStatus && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RunStatusBadge status={runStatus.status ?? 'running'} />
                {runStatus.prompt && (
                  <span className="text-muted-foreground max-w-md truncate text-xs">
                    {runStatus.prompt}
                  </span>
                )}
              </div>
            </div>

            {runStatus.output !== null && (
              <div className="border-border bg-background max-h-[300px] overflow-auto rounded-md border">
                <pre
                  ref={outputRef}
                  className="p-3 text-xs leading-relaxed whitespace-pre-wrap break-words"
                  style={{ fontFamily: "'Courier New', Courier, monospace", tabSize: 8 }}
                >
                  {stripAnsi(runStatus.output)}
                </pre>
              </div>
            )}

            {isDone && (
              <div className="flex items-center gap-2">
                {runStatus.status === 'completed' ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                ) : (
                  <XCircle className="h-4 w-4 text-red-400" />
                )}
                <span className="text-sm">
                  {runStatus.status === 'completed'
                    ? 'Run completed successfully'
                    : runStatus.status === 'cancelled'
                      ? 'Run was cancelled'
                      : `Run failed${runStatus.exitCode !== null ? ` (exit code ${runStatus.exitCode})` : ''}`}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Recent runs list */}
        {runsData && runsData.runs.length > 0 && (
          <details className="mt-2">
            <summary className="text-muted-foreground cursor-pointer text-xs font-medium">
              Recent runs ({runsData.runs.length})
            </summary>
            <div className="mt-2 space-y-1.5">
              {runsData.runs.map(run => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => {
                    if (run.status === 'running') {
                      setActiveRunId(run.id);
                    }
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/50"
                >
                  <RunStatusBadge status={run.status} />
                  <span className="text-muted-foreground flex-1 truncate">{run.prompt}</span>
                  <span className="text-muted-foreground shrink-0 whitespace-nowrap">
                    {formatDistanceToNow(new Date(run.started_at), { addSuffix: true })}
                  </span>
                  {run.completed_at && (
                    <span className="text-muted-foreground shrink-0">
                      {formatDuration(run.started_at, run.completed_at)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
