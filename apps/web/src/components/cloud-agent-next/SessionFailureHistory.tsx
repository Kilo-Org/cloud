'use client';

import { useState } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { summarizeSessionFailureHistory } from './session-failure-summary';

type SessionFailureHistoryProps = {
  cloudAgentSessionId: string;
};

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function SessionFailureHistory({ cloudAgentSessionId }: SessionFailureHistoryProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const enabled = /^(agent|workspace)_/.test(cloudAgentSessionId);

  const historyQuery = useQuery({
    ...trpc.cloudAgentNextFailures.getSessionFailureHistory.queryOptions(
      enabled ? { cloudAgentSessionId } : skipToken
    ),
    staleTime: 30_000,
    retry: 2,
  });

  const history = historyQuery.data;

  if (!enabled || !history) {
    return null;
  }

  if (historyQuery.isError) {
    return (
      <section
        className="border-border bg-muted/30 space-y-3 rounded-lg border p-4 text-sm"
        aria-label="Failure history"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="text-destructive h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="text-foreground font-medium">Could not load failure history</span>
        </div>
        <p className="text-muted-foreground text-xs">
          A transient error hid this section. Reopen the dialog to try again.
        </p>
      </section>
    );
  }

  const summary = summarizeSessionFailureHistory(history);

  if (!summary.hasFailures) {
    return null;
  }

  const handleDownload = async (format: 'json' | 'csv') => {
    setIsDownloading(true);
    setDownloadError(null);
    try {
      const file = await queryClient.fetchQuery(
        trpc.cloudAgentNextFailures.exportSessionDiagnostics.queryOptions({
          cloudAgentSessionId,
          format,
        })
      );
      const blob = new Blob([file.content], { type: file.contentType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError('Could not prepare the diagnostics file. Try again.');
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <section
      className="border-border bg-muted/30 space-y-3 rounded-lg border p-4 text-sm"
      aria-label="Failure history"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="text-destructive h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="text-foreground font-medium">
          {history.setupFailure ? 'Environment setup failed' : 'Message failures'}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {summary.failedRuns.length} failed · {summary.completedCount} completed
        </span>
      </div>

      <ul className="space-y-2">
        {history.setupFailure && (
          <li className="space-y-0.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-foreground">
                {history.setupFailure.userVisibleError ?? 'Environment preparation failed'}
              </span>
              <time
                className="text-muted-foreground text-xs"
                dateTime={history.setupFailure.occurredAt}
                title={new Date(history.setupFailure.occurredAt).toLocaleString()}
              >
                {formatTimestamp(history.setupFailure.occurredAt)}
              </time>
            </div>
            {history.setupFailure.diagnostic && (
              <p className="text-muted-foreground text-xs break-all">
                {history.setupFailure.diagnostic}
              </p>
            )}
          </li>
        )}
        {summary.failedRuns.map(run => (
          <li key={run.messageId} className="space-y-0.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-foreground">
                {run.userVisibleError ?? 'The message failed'}
              </span>
              {run.terminalAt && (
                <time
                  className="text-muted-foreground text-xs"
                  dateTime={run.terminalAt}
                  title={new Date(run.terminalAt).toLocaleString()}
                >
                  {formatTimestamp(run.terminalAt)}
                </time>
              )}
            </div>
            {run.diagnostic && (
              <p className="text-muted-foreground text-xs break-all">{run.diagnostic}</p>
            )}
          </li>
        ))}
      </ul>

      <div className="border-border space-y-2 border-t pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleDownload('json')}
            disabled={isDownloading}
          >
            {isDownloading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Preparing diagnostics...
              </>
            ) : (
              <>
                <Download className="h-4 w-4" aria-hidden="true" />
                Download diagnostics
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void handleDownload('csv')}
            disabled={isDownloading}
          >
            Download CSV
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          This file lists failed runs with session IDs and timestamps. Attach it to a support
          ticket.
        </p>
        {downloadError && (
          <p className="text-destructive text-xs" role="alert">
            {downloadError}
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          The list shows the latest {history.retention.historyRunLimit} runs. Diagnostics are stored
          for {history.retention.diagnosticDays} days. Failure records are kept for{' '}
          {history.retention.runWindowDays} days from session creation.
        </p>
      </div>
    </section>
  );
}
