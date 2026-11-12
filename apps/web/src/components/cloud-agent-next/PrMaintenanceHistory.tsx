import Link from 'next/link';
import { ExternalLink, MessageSquare } from 'lucide-react';
import type { WatchPrMaintenanceHistoryEntry } from '@/lib/cloud-agent/watch-pr-maintenance-history';
import { TimeAgo } from '@/components/shared/TimeAgo';
import { Button } from '@/components/ui/button';
import { DialogClose } from '@/components/ui/dialog';
import {
  getMaintenancePublicationLabel,
  getMaintenanceRecoveryMessage,
  getMaintenanceEvidenceUrl,
} from './pr-maintenance-presentation';

export function maintenanceChatHref(sessionId: string, organizationId?: string | null): string {
  const base = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
  return `${base}/chat?sessionId=${encodeURIComponent(sessionId)}`;
}

export function PrMaintenanceHistory({
  history,
  organizationId,
}: {
  history: readonly WatchPrMaintenanceHistoryEntry[];
  organizationId?: string | null;
}) {
  if (!history.length) {
    return (
      <p className="text-muted-foreground text-xs">
        No repair chats yet. Waiting does not create a chat or use agent compute.
      </p>
    );
  }

  return (
    <ol className="space-y-4" aria-label="Maintenance history">
      {history.map(attempt => (
        <li key={attempt.id} className="border-border space-y-2 border-t pt-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">
              Attempt {attempt.ordinal} · {attempt.status.replaceAll('_', ' ')}
            </span>
            <TimeAgo timestamp={attempt.created_at} />
          </div>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2">
            <dt className="text-muted-foreground">Trigger</dt>
            <dd className="min-w-0 space-y-1">
              {attempt.triggers.length < attempt.triggerCount && (
                <p className="text-muted-foreground">
                  Showing {attempt.triggers.length} of {attempt.triggerCount} triggers.
                </p>
              )}
              {attempt.triggers.map(trigger => (
                <p key={trigger.problemKey} className="line-clamp-3 wrap-anywhere">
                  {trigger.kind === 'review'
                    ? `Review feedback: ${trigger.label}`
                    : trigger.kind === 'failed_check'
                      ? `Failed check: ${trigger.label}`
                      : trigger.label}
                </p>
              ))}
            </dd>
            <dt className="text-muted-foreground">Changes</dt>
            <dd className="min-w-0 wrap-anywhere">
              {attempt.result?.summary ?? 'No recorded result yet.'}
              {attempt.result && (
                <details className="mt-1">
                  <summary className="text-muted-foreground cursor-pointer">
                    {attempt.result.changedFileCount} changed files
                    {attempt.result.changedFiles.length < attempt.result.changedFileCount
                      ? ` (${attempt.result.changedFiles.length} shown)`
                      : ''}
                  </summary>
                  <ul className="mt-1 space-y-1">
                    {attempt.result.changedFiles.map(file => (
                      <li key={file}>
                        <code>{file}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </dd>
            <dt className="text-muted-foreground">Verification</dt>
            <dd className="min-w-0 space-y-2">
              {attempt.result &&
                attempt.result.verification.length < attempt.result.verificationCount && (
                  <p className="text-muted-foreground">
                    Showing {attempt.result.verification.length} of{' '}
                    {attempt.result.verificationCount} verification results.
                  </p>
                )}
              {attempt.result?.verification.length
                ? attempt.result.verification.map((verification, index) => (
                    <div
                      key={`${verification.command}:${index}`}
                      className="space-y-1 wrap-anywhere"
                    >
                      <p>
                        <code>{verification.command}</code> ·{' '}
                        {verification.outcome.replaceAll('_', ' ')}
                      </p>
                      {verification.summary && (
                        <p className="text-muted-foreground">{verification.summary}</p>
                      )}
                      {verification.evidenceUrls.flatMap(value => {
                        const url = getMaintenanceEvidenceUrl(value);
                        return url
                          ? [
                              <a
                                key={url}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-muted-foreground inline-flex items-center gap-1 underline underline-offset-2"
                              >
                                Evidence <ExternalLink className="size-3" aria-hidden="true" />
                              </a>,
                            ]
                          : [];
                      })}
                    </div>
                  ))
                : 'No verification recorded.'}
            </dd>
            <dt className="text-muted-foreground">Publication</dt>
            <dd className="min-w-0 wrap-anywhere">
              {getMaintenancePublicationLabel(attempt.result?.publication)}
              {attempt.result?.publication && attempt.result.publication.status !== 'published' && (
                <p className="text-muted-foreground mt-1">{attempt.result.publication.reason}</p>
              )}
            </dd>
            {attempt.total_cost_microdollars != null && (
              <>
                <dt className="text-muted-foreground">Usage</dt>
                <dd className="tabular-nums">
                  ${(attempt.total_cost_microdollars / 1_000_000).toFixed(4)}
                </dd>
              </>
            )}
          </dl>
          {(attempt.reason || attempt.result?.needsInput) && (
            <p className="text-muted-foreground wrap-anywhere">
              {attempt.result?.needsInput ?? getMaintenanceRecoveryMessage(attempt.reason)}
            </p>
          )}
          {attempt.chatAvailable && attempt.session_id && (
            <DialogClose asChild>
              <Button asChild size="sm" variant="outline" className="min-h-9 text-xs">
                <Link href={maintenanceChatHref(attempt.session_id, organizationId)}>
                  <MessageSquare aria-hidden="true" /> Open maintenance chat
                </Link>
              </Button>
            </DialogClose>
          )}
        </li>
      ))}
    </ol>
  );
}
