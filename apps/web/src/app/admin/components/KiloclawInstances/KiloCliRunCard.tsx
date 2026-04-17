'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Loader2, Play, RefreshCw, Square, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { stripAnsi } from '@/lib/stripAnsi';

// Nil UUID used as cache key for disabled queries. react-query requires a stable
// queryKey even when the query is disabled; a nil UUID avoids colliding with
// real run IDs while keeping the key deterministic.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const PROMPT_MAX_LENGTH = 10_000;

function RunStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return (
        <Badge variant="outline" className="border-blue-500/30 text-blue-400">
          running
        </Badge>
      );
    case 'completed':
      return (
        <Badge variant="outline" className="border-emerald-500/30 text-emerald-400">
          completed
        </Badge>
      );
    case 'failed':
      return (
        <Badge variant="outline" className="border-red-500/30 text-red-400">
          failed
        </Badge>
      );
    case 'cancelled':
      return (
        <Badge variant="outline" className="border-yellow-500/30 text-yellow-400">
          cancelled
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function InitiatedByBadge({ initiatedBy }: { initiatedBy: 'admin' | 'user' | null }) {
  const label = initiatedBy === 'admin' ? 'Admin-initiated' : 'User-initiated';
  return <Badge variant="outline">{label}</Badge>;
}

function RunOutput({
  output,
  open,
  onToggle,
}: {
  output: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  if (output == null) return null;

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="text-muted-foreground cursor-pointer text-xs font-medium select-none flex items-center gap-1"
      >
        <span
          className="inline-block transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          &#9654;
        </span>
        Output
      </button>
      {open && (
        <div className="border-border bg-background mt-2 h-[300px] overflow-auto rounded-md border">
          <pre
            className="p-3 text-xs leading-relaxed whitespace-pre-wrap break-words"
            style={{ fontFamily: "'Courier New', Courier, monospace", tabSize: 8 }}
          >
            {stripAnsi(output)}
          </pre>
        </div>
      )}
    </div>
  );
}

export function KiloCliRunCard({ userId, instanceId }: { userId: string; instanceId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [outputOpen, setOutputOpen] = useState(false);

  const { data: runsData } = useQuery({
    ...trpc.admin.kiloclawInstances.listKiloCliRuns.queryOptions({
      userId,
      instanceId,
      limit: 1,
    }),
    refetchInterval: query => {
      if (activeRunId) return 3_000;
      const latest = query.state.data?.runs[0];
      return latest?.status === 'running' ? 3_000 : false;
    },
  });

  const latestRun = runsData?.runs[0] ?? null;
  const hasActiveRun = latestRun?.status === 'running';

  // Auto-open output when a running run is discovered (page load or started in this session).
  // Never auto-closes — the user keeps control after it opens.
  useEffect(() => {
    if (hasActiveRun) {
      setOutputOpen(true);
    }
  }, [hasActiveRun]);

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
  const trackedRunStatus = runStatus?.status ?? null;
  useEffect(() => {
    if (trackedRunStatus !== null && trackedRunStatus !== 'running') {
      setActiveRunId(null);
    }
  }, [trackedRunStatus]);

  const startMutation = useMutation(
    trpc.admin.kiloclawInstances.startKiloCliRun.mutationOptions({
      onSuccess: data => {
        setActiveRunId(data.id);
        setOutputOpen(true);
        setPrompt('');
        toast.success('CLI run started');
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.listKiloCliRuns.queryKey(),
        });
      },
      onError: err => {
        toast.error(`Failed to start CLI run: ${err.message}`);
        // On conflict (a run is already in progress), immediately refetch the
        // run list so the existing running run is discovered and polling kicks in.
        if (err.data?.code === 'CONFLICT') {
          setOutputOpen(true);
          void queryClient.invalidateQueries({
            queryKey: trpc.admin.kiloclawInstances.listKiloCliRuns.queryKey(),
          });
        }
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

  const handleRefresh = () => {
    void queryClient.invalidateQueries({
      queryKey: trpc.admin.kiloclawInstances.listKiloCliRuns.queryKey(),
    });
    if (trackedRunId) {
      void queryClient.invalidateQueries({
        queryKey: trpc.admin.kiloclawInstances.getKiloCliRunStatus.queryKey(),
      });
    }
  };

  const isRunning = runStatus?.status === 'running';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Terminal className="h-5 w-5" />
          <div>
            <CardTitle>Kilo CLI Run</CardTitle>
            <CardDescription>
              Run an autonomous agent task on this instance via{' '}
              <code className="text-muted-foreground">kilo run --auto</code>
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Prompt</Label>
          <Textarea
            placeholder="e.g., Fix the baseUrl in openclaw.json to use the correct gateway endpoint..."
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            className="min-h-24 resize-y"
            maxLength={PROMPT_MAX_LENGTH}
            disabled={startMutation.isPending || isRunning}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleStart();
              }
            }}
          />
          <p className="text-muted-foreground text-xs">
            {prompt.length.toLocaleString()} / {PROMPT_MAX_LENGTH.toLocaleString()} characters
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isRunning && trackedRunId ? (
            <Button
              size="sm"
              variant="outline"
              className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
              disabled={cancelMutation.isPending}
              onClick={handleCancel}
            >
              {cancelMutation.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="mr-1.5 h-3.5 w-3.5" />
              )}
              Cancel Run
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={handleStart}
              disabled={!prompt.trim() || startMutation.isPending}
            >
              {startMutation.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="mr-1.5 h-3.5 w-3.5" />
              )}
              Start CLI Run
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={handleRefresh}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Refresh Status
          </Button>
        </div>

        {/* Most recent run summary */}
        {latestRun && (
          <div className="border-border bg-muted/30 rounded-md border p-4 space-y-3">
            <div className="grid grid-cols-5 gap-4">
              <div>
                <p className="text-muted-foreground mb-1 text-xs">Status</p>
                <RunStatusBadge status={latestRun.status} />
              </div>
              <div>
                <p className="text-muted-foreground mb-1 text-xs">Initiated By</p>
                <InitiatedByBadge
                  initiatedBy={latestRun.initiated_by_admin_id ? 'admin' : 'user'}
                />
              </div>
              <div>
                <p className="text-muted-foreground mb-1 text-xs">Exit Code</p>
                <p className="text-sm">{latestRun.exit_code ?? '\u2014'}</p>
              </div>
              <div>
                <p className="text-muted-foreground mb-1 text-xs">Started</p>
                <p className="text-sm">
                  {formatDistanceToNow(new Date(latestRun.started_at), { addSuffix: true })}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground mb-1 text-xs">Completed</p>
                <p className="text-sm">
                  {latestRun.completed_at
                    ? formatDistanceToNow(new Date(latestRun.completed_at), { addSuffix: true })
                    : '\u2014'}
                </p>
              </div>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5 text-xs">Prompt</p>
              <p className="text-sm truncate">{latestRun.prompt}</p>
            </div>

            {/* CLI output — use live runStatus output when actively tracking, otherwise latestRun */}
            <RunOutput
              output={
                trackedRunId && runStatus?.output != null ? runStatus.output : latestRun.output
              }
              open={outputOpen}
              onToggle={() => setOutputOpen(prev => !prev)}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
