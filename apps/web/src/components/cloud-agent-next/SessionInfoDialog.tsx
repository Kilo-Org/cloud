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
import { Share2 } from 'lucide-react';
import { ShareSessionDialog } from './ShareSessionDialog';
import {
  formatSessionCost,
  getDisplayedSessionCostBreakdown,
  isRenderableSessionCost,
  type SessionCostBreakdown,
} from './session-cost-breakdown';
import { formatShortModelName } from '@/lib/format-model-name';
import type { ComputeBillingStatus } from '@/lib/cloud-agent-next/cloud-agent-client';

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
  computeStatus?: ComputeBillingStatus;
};

export function SessionInfoDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  sessionId,
  model,
  modelDisplayName,
  sessionCostBreakdown,
  computeStatus,
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
  const showTotalCost = isRenderableSessionCost(totalCostUsd);
  const showSubagentCost = isRenderableSessionCost(displayedSessionCostBreakdown.subagentCostUsd);
  const showOlderActivityCost = isRenderableSessionCost(
    displayedSessionCostBreakdown.olderActivityCostUsd
  );
  const showCostBreakdown =
    showTotalCost &&
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
            <DialogDescription>Usage and session details.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {showTotalCost && (
              <dl className="bg-muted/30 grid gap-2 rounded-lg border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <dt className="text-sm font-medium">Token Usage</dt>
                  <dd className="font-mono text-2xl font-semibold tracking-tight tabular-nums">
                    {formatSessionCost(displayedSessionCostBreakdown.totalCostUsd)}
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
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-sm">
              <dt className="font-medium">Compute</dt>
              {computeStatus?.phase === 'unavailable' || !computeStatus ? (
                <dd className="text-muted-foreground text-right">Status unavailable</dd>
              ) : computeStatus.estimatedHourlyRateMicrodollars === null ? (
                <dd className="text-muted-foreground text-right">Pricing unavailable</dd>
              ) : (
                <>
                  <dd className="text-right font-mono tabular-nums">
                    Est. ${(computeStatus.estimatedHourlyRateMicrodollars / 1_000_000).toFixed(2)} /
                    hour
                  </dd>
                  <dd className="text-muted-foreground col-span-2 space-y-1 text-xs">
                    <p>Billed only while the sandbox runs.</p>
                    {computeStatus.billingMode === 'shadow' && (
                      <p className="text-foreground">Not currently charged</p>
                    )}
                    <p>
                      {computeStatus.attribution === 'payer_shared'
                        ? 'The estimate may include other sessions using this shared sandbox.'
                        : 'The estimate is based on this sandbox’s runtime.'}
                    </p>
                    {computeStatus.phase === 'stopping' || computeStatus.phase === 'settling' ? (
                      <p>Saving and stopping. Final cost is confirmed after it stops.</p>
                    ) : null}
                  </dd>
                </>
              )}
            </dl>
            <dl className="space-y-3 border-t pt-4 text-sm">
              <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-4">
                <dt className="text-muted-foreground">Model</dt>
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
