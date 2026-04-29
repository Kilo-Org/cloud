'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ExternalLink, Loader2, MoreHorizontal, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { SessionInfoDialog } from './SessionInfoDialog';
import { SessionActionsDialog } from './SessionActionsDialog';
import { SoundToggleButton } from '@/components/shared/SoundToggleButton';
import { FeedbackDialog } from './FeedbackDialog';
import { PrStateBadge } from './PrStateBadge';
import { resolveGithubLink, type AssociatedPr } from './utils/github-pr-link';

function extractTrpcErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('data' in error)) return undefined;
  const { data } = error;
  if (typeof data !== 'object' || data === null || !('code' in data)) return undefined;
  const { code } = data;
  return typeof code === 'string' ? code : undefined;
}

function formatRefreshPrError(error: unknown): string {
  const code = extractTrpcErrorCode(error);
  if (code === 'TOO_MANY_REQUESTS') {
    return 'Refreshed too recently. Please wait a few seconds and try again.';
  }
  if (code === 'BAD_REQUEST') {
    return 'This session has no GitHub branch to look up.';
  }
  return 'Failed to refresh PR info.';
}

type ChatHeaderProps = {
  cloudAgentSessionId: string;
  kiloSessionId?: string;
  organizationId?: string;
  repository: string;
  branch?: string;
  gitUrl?: string | null;
  model?: string;
  modelDisplayName?: string;
  totalCost?: number;
  soundEnabled?: boolean;
  onToggleSound?: () => void;
  sessionTitle?: string;
  associatedPr?: AssociatedPr | null;
  /**
   * When `kiloSessionId` is present and the session has a git branch,
   * the caller can pass a refresh handler to enable the
   * "Refresh PR info" menu item.
   */
  onRefreshPr?: () => Promise<void>;
  isRefreshingPr?: boolean;
};

export function ChatHeader({
  cloudAgentSessionId,
  repository,
  branch,
  gitUrl,
  model = 'Unknown',
  modelDisplayName,
  totalCost = 0,
  soundEnabled = true,
  onToggleSound,
  kiloSessionId,
  organizationId,
  sessionTitle,
  associatedPr,
  onRefreshPr,
  isRefreshingPr = false,
}: ChatHeaderProps) {
  const [showInfoDialog, setShowInfoDialog] = useState(false);
  const [showActionsDialog, setShowActionsDialog] = useState(false);

  const githubLink = resolveGithubLink({ gitUrl, branch, associatedPr });

  const handleRefreshPr = async () => {
    if (!onRefreshPr || isRefreshingPr) return;
    try {
      await onRefreshPr();
    } catch (error) {
      toast.error(formatRefreshPrError(error));
    }
  };

  return (
    <>
      <SessionInfoDialog
        open={showInfoDialog}
        onOpenChange={setShowInfoDialog}
        sessionId={cloudAgentSessionId}
        kiloSessionId={kiloSessionId}
        model={model}
        modelDisplayName={modelDisplayName}
        cost={totalCost * 1_000_000}
        associatedPr={associatedPr ?? null}
      />
      <SessionActionsDialog
        open={showActionsDialog}
        onOpenChange={setShowActionsDialog}
        kiloSessionId={kiloSessionId}
        sessionTitle={sessionTitle}
        repository={repository}
      />
      <div className="flex items-center gap-1">
        {onToggleSound && (
          <SoundToggleButton enabled={soundEnabled} onToggle={onToggleSound} size="sm" />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="More options">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setShowActionsDialog(true)}>
              Share or Fork
            </DropdownMenuItem>
            {githubLink.kind !== 'none' && (
              <DropdownMenuItem asChild>
                <a href={githubLink.href} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  <span className="flex-1">{githubLink.label}</span>
                  {githubLink.kind === 'pr' && (
                    <span className="ml-2">
                      <PrStateBadge state={githubLink.prState} />
                    </span>
                  )}
                </a>
              </DropdownMenuItem>
            )}
            {onRefreshPr && (
              <DropdownMenuItem disabled={isRefreshingPr} onClick={() => void handleRefreshPr()}>
                {isRefreshingPr ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Refresh PR info
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setShowInfoDialog(true)}>
              Session Info
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <FeedbackDialog organizationId={organizationId} kiloSessionId={kiloSessionId} />
      </div>
    </>
  );
}
