'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, Loader2, XCircle, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { SetPageTitle } from '@/components/SetPageTitle';
import KiloCrabIcon from '@/components/KiloCrabIcon';
import { toast } from 'sonner';

/** Strip ANSI escape codes so raw terminal output renders in a browser <pre>. */
function stripAnsi(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function StatusBadge({ status }: { status: string | null }) {
  switch (status) {
    case 'running':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          Running
        </span>
      );
    case 'completed':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
          <CheckCircle2 className="h-3 w-3" />
          Completed
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-0.5 text-xs font-medium text-red-400">
          <XCircle className="h-3 w-3" />
          Failed
        </span>
      );
    case 'cancelled':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-500/10 px-2.5 py-0.5 text-xs font-medium text-yellow-400">
          <Square className="h-3 w-3" />
          Cancelled
        </span>
      );
    default:
      return null;
  }
}

type RunStatusData = {
  hasRun: boolean;
  status: string | null;
  output: string | null;
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  prompt: string | null;
  initiatedBy?: 'admin' | 'user' | null;
};

type KiloCliRunViewProps = {
  runId: string;
  runStatus: RunStatusData | undefined;
  isError: boolean;
  errorMessage: string | undefined;
  cancelMutation: ReturnType<typeof useKiloClawMutations>['cancelKiloCliRun'];
  dashboardPath: string;
};

export function KiloCliRunView({
  runId,
  runStatus,
  isError,
  errorMessage,
  cancelMutation,
  dashboardPath,
}: KiloCliRunViewProps) {
  const router = useRouter();
  const outputRef = useRef<HTMLPreElement>(null);

  const isDone = runStatus?.hasRun && runStatus.status !== null && runStatus.status !== 'running';

  // Auto-scroll output to bottom when new content arrives
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [runStatus?.output]);

  return (
    <div className="mx-auto container max-w-285 space-y-6 p-6">
      <SetPageTitle
        title="KiloClaw > CLI Run"
        icon={<KiloCrabIcon className="text-muted-foreground h-4 w-4" />}
      />
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push(dashboardPath)}>
          <ArrowLeft className="h-4 w-4" />
          Back to Dashboard
        </Button>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            {runStatus?.initiatedBy === 'admin' && (
              <Badge variant="secondary" className="mb-2">
                Admin-initiated
              </Badge>
            )}
            {runStatus?.prompt && (
              <p className="text-muted-foreground mt-1 text-sm">
                Prompt: &quot;
                {runStatus.prompt.length > 200
                  ? runStatus.prompt.slice(0, 200) + '...'
                  : runStatus.prompt}
                &quot;
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {runStatus && <StatusBadge status={runStatus.status} />}
            {runStatus?.status === 'running' && (
              <Button
                size="sm"
                variant="outline"
                className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                disabled={cancelMutation.isPending}
                onClick={() =>
                  cancelMutation.mutate(
                    { runId },
                    {
                      onSuccess: () => toast.success('Recovery run cancelled'),
                      onError: err => toast.error(err.message, { duration: 10000 }),
                    }
                  )
                }
              >
                <Square className="h-3 w-3" />
                Cancel
              </Button>
            )}
          </div>
        </div>

        {/* Loading state: waiting for first poll result */}
        {!runStatus?.hasRun && !isError && (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
            <p className="text-muted-foreground text-sm">Waiting for output...</p>
            <Button
              size="sm"
              variant="outline"
              className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
              disabled={cancelMutation.isPending}
              onClick={() =>
                cancelMutation.mutate(
                  { runId },
                  {
                    onSuccess: () => toast.success('Recovery run cancelled'),
                    onError: err => toast.error(err.message, { duration: 10000 }),
                  }
                )
              }
            >
              <Square className="h-3 w-3" />
              Cancel
            </Button>
          </div>
        )}

        {/* Error loading the run */}
        {isError && (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <XCircle className="h-8 w-8 text-red-400" />
            <p className="text-sm text-red-400">{errorMessage ?? 'Failed to load run status'}</p>
            <Button variant="outline" size="sm" onClick={() => router.push(dashboardPath)}>
              Back to Dashboard
            </Button>
          </div>
        )}

        {/* Output viewer */}
        {runStatus?.hasRun && runStatus.output !== null && (
          <div className="border-border bg-background overflow-hidden rounded-md border">
            <pre
              ref={outputRef}
              className="overflow-auto p-4 text-xs leading-relaxed whitespace-pre-wrap break-words"
              style={{ fontFamily: "'Courier New', Courier, monospace", tabSize: 8 }}
            >
              {stripAnsi(runStatus.output)}
            </pre>
          </div>
        )}

        {/* Run completed summary */}
        {isDone && (
          <div className="flex items-center gap-2 pt-2">
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
            {runStatus.completedAt && (
              <span className="text-muted-foreground text-xs">
                at {new Date(runStatus.completedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
