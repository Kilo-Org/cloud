'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ExternalLink, MoreHorizontal } from 'lucide-react';
import { SessionInfoDialog } from './SessionInfoDialog';
import { SessionActionsDialog } from './SessionActionsDialog';
import { SoundToggleButton } from '@/components/shared/SoundToggleButton';
import { FeedbackDialog } from './FeedbackDialog';
import { buildRepoBrowseUrl, detectGitPlatform } from './utils/git-utils';
import { useTRPC } from '@/lib/trpc/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

function formatRate(microdollars: number | null): string {
  return microdollars === null
    ? 'pricing unavailable'
    : `$${(microdollars / 1_000_000).toFixed(2)}/hour`;
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
  tokenUsage?: number;
  soundEnabled?: boolean;
  onToggleSound?: () => void;
  sessionTitle?: string;
};

export function ChatHeader({
  cloudAgentSessionId,
  repository,
  branch,
  gitUrl,
  model = 'Unknown',
  modelDisplayName,
  tokenUsage = 0,
  soundEnabled = true,
  onToggleSound,
  kiloSessionId,
  organizationId,
  sessionTitle,
}: ChatHeaderProps) {
  const [showInfoDialog, setShowInfoDialog] = useState(false);
  const [showActionsDialog, setShowActionsDialog] = useState(false);
  const trpc = useTRPC();
  const computeQuery = useQuery({
    ...(organizationId
      ? trpc.organizations.cloudAgentNext.getComputeBillingStatus.queryOptions({
          organizationId,
          cloudAgentSessionId,
        })
      : trpc.cloudAgentNext.getComputeBillingStatus.queryOptions({ cloudAgentSessionId })),
    enabled: cloudAgentSessionId.startsWith('agent_'),
    refetchInterval: query => {
      const phase = query.state.data?.phase;
      return phase === 'active' || phase === 'stopping' || phase === 'settling' ? 5_000 : false;
    },
  });
  const computeStatus = computeQuery.data;
  const computeLabel =
    computeStatus?.billingMode === 'shadow'
      ? `Compute est. ${formatRate(computeStatus.estimatedHourlyRateMicrodollars)} · Not currently charged`
      : computeStatus?.phase === 'active' && computeStatus.attribution === 'payer_shared'
        ? `Shared compute active · est. $${((computeStatus.estimatedIntervalAmountMicrodollars ?? 0) / 1_000_000).toFixed(2)}`
        : computeStatus?.phase === 'active'
          ? `Compute active · est. $${((computeStatus.estimatedIntervalAmountMicrodollars ?? 0) / 1_000_000).toFixed(2)}`
          : computeStatus?.phase === 'stopping' || computeStatus?.phase === 'settling'
            ? 'Saving and stopping compute'
            : computeStatus?.phase === 'idle'
              ? computeStatus.estimatedHourlyRateMicrodollars === null
                ? 'Compute pricing unavailable'
                : `Compute est. ${formatRate(computeStatus.estimatedHourlyRateMicrodollars)}`
              : null;

  const browseUrl = buildRepoBrowseUrl(gitUrl);
  const repoUrl =
    browseUrl && branch && detectGitPlatform(gitUrl) === 'github'
      ? `${browseUrl}/compare/${branch}?expand=1`
      : browseUrl;

  return (
    <>
      <SessionInfoDialog
        open={showInfoDialog}
        onOpenChange={setShowInfoDialog}
        sessionId={cloudAgentSessionId}
        kiloSessionId={kiloSessionId}
        model={model}
        modelDisplayName={modelDisplayName}
        tokenUsageMicrodollars={tokenUsage * 1_000_000}
        computeStatus={computeStatus}
      />
      <SessionActionsDialog
        open={showActionsDialog}
        onOpenChange={setShowActionsDialog}
        kiloSessionId={kiloSessionId}
        sessionTitle={sessionTitle}
        repository={repository}
      />
      <div className="flex min-w-0 items-center gap-1">
        {computeLabel && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-muted-foreground max-w-48 truncate px-1 font-mono text-xs tabular-nums">
                {computeLabel}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {computeStatus?.attribution === 'payer_shared'
                ? 'Shared payer-level compute estimate. It is not attributed only to this session.'
                : 'Estimated compute rate from the current billing plan.'}
            </TooltipContent>
          </Tooltip>
        )}
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
            {repoUrl && (
              <DropdownMenuItem asChild>
                <a href={repoUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Open in GitHub
                </a>
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
