'use client';

import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ExternalLink, Share2 } from 'lucide-react';
import { ShareSessionDialog } from './ShareSessionDialog';
import { formatShortModelName } from '@/lib/format-model-name';
import type { AssociatedPullRequest } from '@/lib/cloud-agent-sdk';
import { prStateVisual } from './utils/pr-menu';

const PR_TITLE_MAX_LENGTH = 60;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

type SessionInfoDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  /** The Kilo session ID (UUID from cliSessions.session_id) */
  kiloSessionId?: string;
  model: string;
  modelDisplayName?: string;
  cost: number; // in microdollars
  associatedPr?: AssociatedPullRequest | null;
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

            <div>
              <label className="text-muted-foreground mb-2 block text-sm font-medium">
                Pull Request
              </label>
              <PullRequestRow associatedPr={associatedPr ?? null} />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PullRequestRow({ associatedPr }: { associatedPr: AssociatedPullRequest | null }) {
  if (!associatedPr) {
    return (
      <div className="bg-muted text-muted-foreground rounded-md px-3 py-2 text-sm italic">
        No PR associated with this branch
      </div>
    );
  }

  const stateVisual = prStateVisual(associatedPr.state);
  const displayTitle = associatedPr.title
    ? truncate(associatedPr.title, PR_TITLE_MAX_LENGTH)
    : '(no title)';

  let syncedAgo: string | null = null;
  try {
    syncedAgo = formatDistanceToNow(new Date(associatedPr.lastSyncedAt), { addSuffix: true });
  } catch {
    syncedAgo = null;
  }

  return (
    <div className="bg-muted space-y-1 rounded-md px-3 py-2 text-sm">
      <a
        href={associatedPr.url}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-primary flex items-center gap-2"
      >
        <span className="font-mono text-xs">#{associatedPr.number}</span>
        <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
        <span
          className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${stateVisual.chipClassName}`}
        >
          {stateVisual.label}
        </span>
        <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </a>
      {syncedAgo && (
        <div className="text-muted-foreground text-xs">Last checked: {syncedAgo}</div>
      )}
    </div>
  );
}
