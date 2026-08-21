'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Share2 } from 'lucide-react';
import { ShareSessionDialog } from './ShareSessionDialog';
import { formatShortModelName } from '@/lib/format-model-name';
import type { ComputeBillingStatus } from '@/lib/cloud-agent-next/cloud-agent-client';

type SessionInfoDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  /** The Kilo session ID (UUID from cliSessions.session_id) */
  kiloSessionId?: string;
  model: string;
  modelDisplayName?: string;
  tokenUsageMicrodollars: number;
  computeStatus?: ComputeBillingStatus;
};

export function SessionInfoDialog({
  open,
  onOpenChange,
  sessionId,
  model,
  modelDisplayName,
  tokenUsageMicrodollars,
  computeStatus,
  kiloSessionId,
}: SessionInfoDialogProps) {
  const [showShareDialog, setShowShareDialog] = useState(false);

  const tokenUsageDollars = tokenUsageMicrodollars / 1_000_000;

  return (
    <>
      <ShareSessionDialog
        open={showShareDialog}
        onOpenChange={setShowShareDialog}
        kiloSessionId={kiloSessionId}
      />
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Session Information</DialogTitle>
            <DialogDescription>Details about the current Cloud Agent session</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-muted-foreground mb-2 block text-sm font-medium">
                Session ID
              </label>
              <div className="flex items-center gap-2">
                <code className="bg-muted flex-1 overflow-x-auto rounded-md px-3 py-2 font-mono text-xs">
                  {kiloSessionId || sessionId}
                </code>
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => setShowShareDialog(true)}
                  className="h-11 min-h-11 w-11 min-w-11 shrink-0"
                  title="Share session"
                  aria-label="Share session"
                >
                  <Share2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div>
              <label className="text-muted-foreground mb-2 block text-sm font-medium">Model</label>
              <div className="bg-muted rounded-md px-3 py-2 text-sm">
                {modelDisplayName ?? formatShortModelName(model)}
              </div>
            </div>

            <div>
              <label className="text-muted-foreground mb-2 block text-sm font-medium">
                Token Usage
              </label>
              <div className="bg-muted rounded-md px-3 py-2 font-mono text-sm">
                ${tokenUsageDollars.toFixed(4)}
              </div>
            </div>
            <div>
              <label className="text-muted-foreground mb-2 block text-sm font-medium">
                Compute
              </label>
              <div className="bg-muted space-y-1 rounded-md px-3 py-2 text-sm">
                {computeStatus?.phase === 'unavailable' || !computeStatus ? (
                  <span className="text-muted-foreground">Compute status unavailable</span>
                ) : computeStatus.estimatedHourlyRateMicrodollars === null ? (
                  <span className="text-muted-foreground">Compute pricing unavailable</span>
                ) : (
                  <>
                    <div className="font-mono tabular-nums">
                      Est. ${(computeStatus.estimatedHourlyRateMicrodollars / 1_000_000).toFixed(2)}{' '}
                      / hour
                    </div>
                    <p className="text-muted-foreground text-xs">
                      Estimated compute rate from the current billing plan.
                    </p>
                    {computeStatus.billingMode === 'shadow' && <p>Not currently charged</p>}
                    <p className="text-muted-foreground text-xs">
                      {computeStatus.attribution === 'payer_shared'
                        ? 'This is a payer-level shared sandbox estimate, not a per-session charge.'
                        : 'This estimate is attributed to this session.'}
                    </p>
                    {computeStatus.phase === 'stopping' || computeStatus.phase === 'settling' ? (
                      <p className="text-muted-foreground text-xs">
                        Saving and stopping compute. Final amount is not available yet.
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
