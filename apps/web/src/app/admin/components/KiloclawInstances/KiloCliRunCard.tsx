'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2, Play, RefreshCw, Square, Terminal, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import { useTRPC } from '@/lib/trpc/utils';
import { selectCurrentCliRun } from '@/lib/kiloclaw/cli-run-selection';
import { stripAnsi } from '@/lib/stripAnsi';
import { formatRelativeTime, DetailField } from './shared';

const STATUS_BADGE_CLASSES: Record<string, string> = {
  running: 'bg-blue-500',
  completed: 'bg-green-600',
  failed: 'bg-red-600',
  cancelled: 'bg-amber-600',
};

function getStatusBadgeClass(status: string | null): string {
  return status ? (STATUS_BADGE_CLASSES[status] ?? '') : '';
}

export function KiloCliRunCard({ userId, instanceId }: { userId: string; instanceId: string }) {
  const trpc = useTRPC();
  const [prompt, setPrompt] = useState('');
  const [showOutput, setShowOutput] = useState(true);
  const [runId, setRunId] = useState<string | null>(null);

  const { data: latestRuns, refetch: refetchRuns } = useQuery(
    trpc.admin.kiloclawInstances.listKiloCliRuns.queryOptions(
      { userId, limit: 20 },
      { staleTime: 10_000, refetchInterval: 3000 }
    )
  );

  const selectedRunId = runId ?? selectCurrentCliRun(latestRuns?.runs, instanceId)?.id ?? null;

  const {
    data: runStatus,
    isLoading: statusLoading,
    refetch: refetchStatus,
  } = useQuery({
    // tRPC queryOptions requires Zod-valid input for cache key generation even
    // when the query is disabled. The nil UUID is inert — enabled:false prevents
    // any request.
    ...trpc.admin.kiloclawInstances.getKiloCliRunStatus.queryOptions(
      selectedRunId
        ? { userId, instanceId, runId: selectedRunId }
        : { userId, instanceId, runId: '00000000-0000-0000-0000-000000000000' }
    ),
    enabled: selectedRunId !== null,
    refetchInterval: query => (query?.state?.data?.status === 'running' ? 3000 : false),
  });

  const isRunning = runStatus?.status === 'running';
  const isUserRun = runStatus?.initiatedBy === 'user';

  const { mutateAsync: startRun, isPending: isStarting } = useMutation(
    trpc.admin.kiloclawInstances.startKiloCliRun.mutationOptions({
      onSuccess: result => {
        toast.success('CLI run started');
        // Select the new run immediately instead of waiting for the next latest-runs poll.
        setRunId(result.id);
        setShowOutput(true);
        void refetchRuns();
        void refetchStatus();
      },
      onError: err => {
        toast.error(`Failed to start CLI run: ${err.message}`);
      },
    })
  );

  const { mutateAsync: cancelRun, isPending: isCancelling } = useMutation(
    trpc.admin.kiloclawInstances.cancelKiloCliRun.mutationOptions({
      onSuccess: () => {
        toast.success('CLI run cancelled');
        void refetchRuns();
        void refetchStatus();
      },
      onError: err => {
        toast.error(`Failed to cancel CLI run: ${err.message}`);
      },
    })
  );

  const handleStart = () => {
    if (!prompt.trim()) return;
    void startRun({ userId, instanceId, prompt: prompt.trim() });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Terminal className="h-5 w-5" />
          <div>
            <CardTitle>Kilo CLI Run</CardTitle>
            <CardDescription>
              Run an autonomous agent task on this instance via <code>kilo run --auto</code>
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isRunning && isUserRun && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              A user-initiated CLI run is currently in progress on this instance. You can monitor or
              cancel it below.
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <label className="text-sm font-medium">Prompt</label>
          <Textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="e.g., Fix the baseUrl in openclaw.json to use the correct gateway endpoint..."
            maxLength={10_000}
            className="min-h-[80px] resize-y font-mono text-sm"
            rows={3}
            disabled={isRunning || isStarting}
          />
          <p className="text-muted-foreground text-xs">
            {prompt.length.toLocaleString()} / 10,000 characters
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleStart}
            disabled={!prompt.trim() || isRunning || isStarting}
          >
            {isStarting ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-1 h-4 w-4" />
            )}
            {isStarting ? 'Starting...' : 'Start CLI Run'}
          </Button>

          {isRunning && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() =>
                selectedRunId && void cancelRun({ userId, instanceId, runId: selectedRunId })
              }
              disabled={isCancelling}
            >
              {isCancelling ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Square className="mr-1 h-4 w-4" />
              )}
              Cancel
            </Button>
          )}

          <Button size="sm" variant="outline" onClick={() => void refetchStatus()}>
            <RefreshCw className="mr-1 h-4 w-4" />
            Refresh Status
          </Button>
        </div>

        {statusLoading && (
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-muted-foreground text-sm">Loading run status...</span>
          </div>
        )}

        {statusLoading && !runStatus && (
          <div className="space-y-3 rounded border p-3">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
              <DetailField label="Status">—</DetailField>
              <DetailField label="Initiated By">—</DetailField>
              <DetailField label="Exit Code">—</DetailField>
              <DetailField label="Started">—</DetailField>
              <DetailField label="Completed">—</DetailField>
            </div>
          </div>
        )}

        {runStatus?.hasRun && (
          <div className="space-y-3 rounded border p-3">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
              <DetailField label="Status">
                <Badge className={getStatusBadgeClass(runStatus.status)}>
                  {runStatus.status ?? 'unknown'}
                </Badge>
              </DetailField>
              <DetailField label="Initiated By">
                <Badge variant={runStatus.initiatedBy === 'admin' ? 'default' : 'secondary'}>
                  {runStatus.initiatedBy === 'admin'
                    ? 'Admin-initiated'
                    : runStatus.initiatedBy === 'user'
                      ? 'User-initiated'
                      : '—'}
                </Badge>
              </DetailField>
              <DetailField label="Exit Code">
                {runStatus.exitCode !== null && runStatus.exitCode !== undefined
                  ? String(runStatus.exitCode)
                  : '—'}
              </DetailField>
              <DetailField label="Started">
                {runStatus.startedAt ? formatRelativeTime(runStatus.startedAt) : '—'}
              </DetailField>
              <DetailField label="Completed">
                {runStatus.completedAt ? formatRelativeTime(runStatus.completedAt) : '—'}
              </DetailField>
            </div>

            {runStatus.prompt && (
              <DetailField label="Prompt">
                <p className="text-muted-foreground max-h-[60px] overflow-y-auto text-xs">
                  {runStatus.prompt}
                </p>
              </DetailField>
            )}

            {runStatus.output && (
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowOutput(prev => !prev)}
                  className="mb-1 h-auto px-0 py-1 text-xs"
                >
                  {showOutput ? 'Hide output' : 'Show output'}
                </Button>
                {showOutput && (
                  <div className="border-border bg-background max-h-[300px] overflow-auto rounded-md border">
                    <pre
                      className="p-3 text-xs leading-relaxed whitespace-pre-wrap"
                      style={{ fontFamily: "'Courier New', Courier, monospace" }}
                    >
                      {stripAnsi(runStatus.output)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
