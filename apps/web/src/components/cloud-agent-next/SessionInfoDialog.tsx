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
import { ExternalLink, Share2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ShareSessionDialog } from './ShareSessionDialog';
import { formatShortModelName } from '@/lib/format-model-name';
import { PrStateBadge } from './PrStateBadge';
import { normalizePrBadgeState, truncatePrTitle, type AssociatedPr } from './utils/github-pr-link';

type SessionInfoDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  /** The Kilo session ID (UUID from cliSessions.session_id) */
  kiloSessionId?: string;
  model: string;
  modelDisplayName?: string;
  cost: number; // in microdollars
  associatedPr?: AssociatedPr | null;
};

export function SessionInfoDialog({
  open,
  onOpenChange,
  sessionId,
  model,
  modelDisplayName,
  cost,
  kiloSessionId,
  associatedPr,
}: SessionInfoDialogProps) {
  const [showShareDialog, setShowShareDialog] = useState(false);

  const costInDollars = cost / 1_000_000;

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
                Total Cost
              </label>
              <div className="bg-muted rounded-md px-3 py-2 font-mono text-sm">
                ${costInDollars.toFixed(4)}
              </div>
            </div>

            <PullRequestRow associatedPr={associatedPr ?? null} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PullRequestRow({ associatedPr }: { associatedPr: AssociatedPr | null }) {
  return (
    <div>
      <label className="text-muted-foreground mb-2 block text-sm font-medium">Pull Request</label>
      {associatedPr ? (
        <>
          <a
            href={associatedPr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-muted hover:bg-muted/70 flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors"
          >
            <span className="font-mono text-xs">#{associatedPr.number}</span>
            <span className="flex-1 truncate">{truncatePrTitle(associatedPr.title)}</span>
            <PrStateBadge state={normalizePrBadgeState(associatedPr.state)} />
            <ExternalLink className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
          </a>
          <p className="text-muted-foreground mt-1 text-xs">
            Last checked{' '}
            {formatDistanceToNow(new Date(associatedPr.lastSyncedAt), { addSuffix: true })}
          </p>
        </>
      ) : (
        <div className="bg-muted text-muted-foreground rounded-md px-3 py-2 text-sm">
          No PR associated with this branch
        </div>
      )}
    </div>
  );
}
