'use client';

import { useRef, useState, type ComponentProps } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ChevronDown, Share2 } from 'lucide-react';
import { ShareSessionDialog } from './ShareSessionDialog';
import {
  formatSessionCost,
  formatSessionTotalCost,
  getDisplayedSessionCostBreakdown,
  isRenderableSessionCost,
  type SessionCostBreakdown,
} from './session-cost-breakdown';
import type { SessionModelUsage, SessionTokenUsage } from './session-token-usage';
import { formatModelRefName, formatShortModelName } from '@/lib/format-model-name';

type SessionInfoDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>['onCloseAutoFocus'];
  sessionId: string;
  /** The Kilo session ID (UUID from cliSessions.session_id) */
  kiloSessionId?: string;
  model: string;
  modelDisplayName?: string;
  sessionCostBreakdown?: SessionCostBreakdown;
  sessionTokenUsage?: SessionTokenUsage;
  sessionModelUsage?: SessionModelUsage[];
  hasIncompleteHistory?: boolean;
};

export function SessionInfoDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  sessionId,
  model,
  modelDisplayName,
  sessionCostBreakdown,
  sessionTokenUsage,
  sessionModelUsage,
  hasIncompleteHistory = false,
  kiloSessionId,
}: SessionInfoDialogProps) {
  const [showShareDialog, setShowShareDialog] = useState(false);
  const shareButtonRef = useRef<HTMLButtonElement | null>(null);

  const totalCostUsd = sessionCostBreakdown?.totalCostUsd ?? 0;
  const rootCostUsd = sessionCostBreakdown?.rootCostUsd ?? 0;
  const subagentCostUsd = sessionCostBreakdown?.subagentCostUsd ?? 0;
  const olderActivityCostUsd = sessionCostBreakdown?.olderActivityCostUsd ?? 0;
  const displayedSessionCostBreakdown = getDisplayedSessionCostBreakdown({
    totalCostUsd,
    rootCostUsd,
    subagentCostUsd,
    olderActivityCostUsd,
  });
  const showTotalCost = sessionCostBreakdown !== undefined;
  const showSubagentCost = isRenderableSessionCost(displayedSessionCostBreakdown.subagentCostUsd);
  const showOlderActivityCost = isRenderableSessionCost(
    displayedSessionCostBreakdown.olderActivityCostUsd
  );
  const showCostBreakdown =
    isRenderableSessionCost(totalCostUsd) &&
    (isRenderableSessionCost(rootCostUsd) || showSubagentCost || showOlderActivityCost);

  return (
    <>
      <ShareSessionDialog
        open={showShareDialog}
        onOpenChange={setShowShareDialog}
        onCloseAutoFocus={event => {
          if (!shareButtonRef.current?.isConnected) return;
          event.preventDefault();
          shareButtonRef.current.focus();
        }}
        kiloSessionId={kiloSessionId}
      />
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <DialogHeader className="pr-6 text-left">
            <DialogTitle>Session Information</DialogTitle>
            <DialogDescription>Recorded model cost in USD and token usage.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {showTotalCost && (
              <dl className="bg-muted/30 grid gap-2 rounded-lg border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <dt className="text-sm font-medium">Total cost</dt>
                  <dd className="font-mono text-2xl font-semibold tracking-tight tabular-nums">
                    {formatSessionTotalCost(totalCostUsd)}
                  </dd>
                </div>
                {showCostBreakdown && (
                  <>
                    <div className="mt-1 flex items-baseline justify-between gap-4 border-t pt-3 text-sm">
                      <dt className="text-muted-foreground">Root session</dt>
                      <dd className="font-mono tabular-nums">
                        {formatSessionCost(displayedSessionCostBreakdown.rootCostUsd)}
                      </dd>
                    </div>
                    {showSubagentCost && (
                      <div className="flex items-baseline justify-between gap-4 text-sm">
                        <dt className="text-muted-foreground">Subagents</dt>
                        <dd className="font-mono tabular-nums">
                          {formatSessionCost(displayedSessionCostBreakdown.subagentCostUsd)}
                        </dd>
                      </div>
                    )}
                    {showOlderActivityCost && (
                      <div className="flex items-baseline justify-between gap-4 text-sm">
                        <dt className="text-muted-foreground">Older activity</dt>
                        <dd className="font-mono tabular-nums">
                          {formatSessionCost(displayedSessionCostBreakdown.olderActivityCostUsd)}
                        </dd>
                      </div>
                    )}
                  </>
                )}
              </dl>
            )}
            {sessionTokenUsage && (
              <section className="space-y-3" aria-labelledby="session-token-usage-title">
                <h3 id="session-token-usage-title" className="text-sm font-medium">
                  Main agent tokens
                </h3>
                <TokenUsageDetails usage={sessionTokenUsage} />
                <p className="text-muted-foreground text-xs">
                  Cumulative reported usage from loaded main-agent activity, excluding subagents.
                  Reasoning may also be included in output, depending on the provider.
                </p>
                {(hasIncompleteHistory || olderActivityCostUsd > 0) && (
                  <p className="text-muted-foreground text-xs" role="status">
                    Token counts cover loaded activity only and may not cover the full session.
                    Recorded cost can include activity not available in this view.
                  </p>
                )}
              </section>
            )}
            {sessionModelUsage && sessionModelUsage.length > 0 && (
              <section aria-labelledby="session-model-usage-title" className="space-y-2">
                <h3 id="session-model-usage-title" className="text-sm font-medium">
                  By model
                </h3>
                <p className="text-muted-foreground text-xs">
                  Loaded main-agent activity only. Subagent and older-activity costs are not
                  attributed to models.
                </p>
                {sessionModelUsage.map(usage => (
                  <details
                    key={JSON.stringify([usage.providerID, usage.modelID])}
                    className="group border-b py-2 last:border-b-0"
                  >
                    <summary className="focus-visible:ring-ring flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-sm text-sm focus-visible:ring-2 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
                      <ChevronDown
                        className="text-muted-foreground size-4 shrink-0 group-open:rotate-180"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium wrap-anywhere">
                          {formatModelRefName(usage)}
                        </span>
                        <span className="text-muted-foreground block text-xs wrap-anywhere">
                          {usage.providerID} / {usage.modelID}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono tabular-nums">
                        {formatSessionTotalCost(usage.costUsd)}
                      </span>
                    </summary>
                    <div className="pt-3 pb-2">
                      <TokenUsageDetails usage={usage.tokens} />
                    </div>
                  </details>
                ))}
              </section>
            )}
            <dl className="space-y-3 border-t pt-4 text-sm">
              <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-4">
                <dt className="text-muted-foreground">Selected model</dt>
                <dd className="text-right font-medium wrap-anywhere">
                  {modelDisplayName ?? formatShortModelName(model)}
                </dd>
              </div>
              <div className="space-y-1.5">
                <dt className="text-muted-foreground">Session ID</dt>
                <dd>
                  <code className="block font-mono text-xs break-all">
                    {kiloSessionId || sessionId}
                  </code>
                </dd>
              </div>
            </dl>
          </div>
          <DialogFooter>
            <Button
              ref={shareButtonRef}
              type="button"
              variant="outline"
              onClick={() => setShowShareDialog(true)}
              className="min-h-11"
            >
              <Share2 className="h-4 w-4" aria-hidden="true" />
              Share session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TokenUsageDetails({ usage }: { usage: SessionTokenUsage }) {
  return (
    <dl className="space-y-2 text-sm">
      {(
        [
          ['Input', usage.input],
          ['Output', usage.output],
          ['Reasoning', usage.reasoning],
          ['Cache read', usage.cacheRead],
          ['Cache write', usage.cacheWrite],
        ] as const
      ).map(([label, count]) => (
        <div key={label} className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="font-mono tabular-nums">{count.toLocaleString('en-US')}</dd>
        </div>
      ))}
    </dl>
  );
}
