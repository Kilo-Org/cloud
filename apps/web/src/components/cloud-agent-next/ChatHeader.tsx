'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ExternalLink, Loader2, MoreHorizontal, RefreshCw } from 'lucide-react';
import { SessionInfoDialog } from './SessionInfoDialog';
import { SessionActionsDialog } from './SessionActionsDialog';
import { SoundToggleButton } from '@/components/shared/SoundToggleButton';
import { FeedbackDialog } from './FeedbackDialog';
import { useTRPC } from '@/lib/trpc/utils';
import type { AssociatedPullRequest } from '@/lib/cloud-agent-sdk';
import { prStateVisual, resolveGitHubMenuAction } from './utils/pr-menu';

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
  associatedPr?: AssociatedPullRequest | null;
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
}: ChatHeaderProps) {
  const [showInfoDialog, setShowInfoDialog] = useState(false);
  const [showActionsDialog, setShowActionsDialog] = useState(false);

  const menuAction = resolveGitHubMenuAction({ gitUrl, branch, associatedPr });

  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const refreshMutation = useMutation(
    trpc.cliSessionsV2.refreshAssociatedPullRequest.mutationOptions({
      onSuccess: () => {
        if (kiloSessionId) {
          void queryClient.invalidateQueries({
            queryKey: trpc.cliSessionsV2.getWithRuntimeState.queryKey({
              session_id: kiloSessionId,
            }),
          });
        }
        toast.success('PR info refreshed');
      },
      onError: (error: unknown) => {
        if (error instanceof TRPCClientError && error.data?.code === 'TOO_MANY_REQUESTS') {
          toast.error('Try again in a moment — PR info was just refreshed.');
          return;
        }
        if (error instanceof TRPCClientError && error.data?.code === 'BAD_REQUEST') {
          toast.error(error.message || 'Cannot refresh PR info for this session.');
          return;
        }
        toast.error('Failed to refresh PR info.');
      },
    })
  );

  const handleRefresh = () => {
    if (!kiloSessionId || refreshMutation.isPending) return;
    refreshMutation.mutate({ sessionId: kiloSessionId });
  };

  const stateVisual = associatedPr ? prStateVisual(associatedPr.state) : null;

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
            {menuAction && (
              <DropdownMenuItem asChild>
                <a href={menuAction.href} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  <span className="flex-1">{menuAction.label}</span>
                  {stateVisual && menuAction.kind === 'pr' && (
                    <span
                      className={`ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${stateVisual.chipClassName}`}
                    >
                      {stateVisual.label}
                    </span>
                  )}
                </a>
              </DropdownMenuItem>
            )}
            {kiloSessionId && (
              <DropdownMenuItem
                onSelect={event => {
                  event.preventDefault();
                  handleRefresh();
                }}
                disabled={refreshMutation.isPending}
              >
                {refreshMutation.isPending ? (
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
