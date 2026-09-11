'use client';

import { useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
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
import type { SessionCostBreakdown } from './session-cost-breakdown';
import { SessionActionsDialog } from './SessionActionsDialog';
import { SoundToggleButton } from '@/components/shared/SoundToggleButton';
import { FeedbackDialog } from './FeedbackDialog';
import { WorktreeChangesButton } from './WorktreeChanges';
import { buildRepoBrowseUrl, detectGitPlatform } from './utils/git-utils';
import { useTRPC } from '@/lib/trpc/utils';
import { SandboxStatusIndicator } from './SandboxStatusIndicator';

export function computeBillingRefetchInterval(
  sessionActive: boolean,
  phase: 'idle' | 'active' | 'stopping' | 'settling' | 'unavailable' | undefined
): number | false {
  return sessionActive || phase === 'active' || phase === 'stopping' || phase === 'settling'
    ? 5_000
    : false;
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
  getSessionCostBreakdown?: () => SessionCostBreakdown;
  sessionInfoOpen: boolean;
  onSessionInfoOpenChange: (open: boolean) => void;
  sessionInfoTriggerRef: RefObject<HTMLElement | null>;
  soundEnabled?: boolean;
  onToggleSound?: () => void;
  changesOpen?: boolean;
  onToggleChanges?: (event: MouseEvent<HTMLButtonElement>) => void;
  sessionTitle?: string;
  sessionActive: boolean;
  sandboxStatusEligible?: boolean;
};

export function ChatHeader({
  cloudAgentSessionId,
  repository,
  branch,
  gitUrl,
  model = 'Unknown',
  modelDisplayName,
  getSessionCostBreakdown,
  sessionInfoOpen,
  onSessionInfoOpenChange,
  sessionInfoTriggerRef,
  soundEnabled = true,
  onToggleSound,
  changesOpen = false,
  onToggleChanges,
  kiloSessionId,
  organizationId,
  sessionTitle,
  sessionActive,
  sandboxStatusEligible = false,
}: ChatHeaderProps) {
  const [showActionsDialog, setShowActionsDialog] = useState(false);
  const moreOptionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sessionCostBreakdown = useMemo(
    () => (sessionInfoOpen ? getSessionCostBreakdown?.() : undefined),
    [getSessionCostBreakdown, sessionInfoOpen]
  );
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
      return computeBillingRefetchInterval(sessionActive, query.state.data?.phase);
    },
  });
  const wasSessionActive = useRef(sessionActive);
  useEffect(() => {
    if (sessionActive && !wasSessionActive.current) void computeQuery.refetch();
    wasSessionActive.current = sessionActive;
  }, [computeQuery.refetch, sessionActive]);
  const computeStatus = computeQuery.data;

  const browseUrl = buildRepoBrowseUrl(gitUrl);
  const repoUrl =
    browseUrl && branch && detectGitPlatform(gitUrl) === 'github'
      ? `${browseUrl}/compare/${branch}?expand=1`
      : browseUrl;

  return (
    <>
      <SessionInfoDialog
        open={sessionInfoOpen}
        onOpenChange={onSessionInfoOpenChange}
        onCloseAutoFocus={event => {
          const trigger = sessionInfoTriggerRef.current;
          sessionInfoTriggerRef.current = null;
          if (!trigger?.isConnected) return;
          event.preventDefault();
          trigger.focus();
        }}
        sessionId={cloudAgentSessionId}
        kiloSessionId={kiloSessionId}
        model={model}
        modelDisplayName={modelDisplayName}
        sessionCostBreakdown={sessionCostBreakdown}
        computeStatus={computeStatus}
      />
      <SessionActionsDialog
        open={showActionsDialog}
        onOpenChange={setShowActionsDialog}
        kiloSessionId={kiloSessionId}
        sessionTitle={sessionTitle}
        repository={repository}
        organizationId={organizationId}
      />
      <div className="flex min-w-0 items-center gap-1">
        {sandboxStatusEligible && (
          <SandboxStatusIndicator
            key={`sandbox-status:${organizationId ?? 'personal'}:${cloudAgentSessionId}`}
            cloudAgentSessionId={cloudAgentSessionId}
            organizationId={organizationId}
            sessionActive={sessionActive}
          />
        )}
        {onToggleChanges && (
          <WorktreeChangesButton
            key={`worktree-changes:${organizationId ?? 'personal'}:${cloudAgentSessionId}`}
            cloudAgentSessionId={cloudAgentSessionId}
            organizationId={organizationId}
            open={changesOpen}
            onToggle={onToggleChanges}
          />
        )}
        {onToggleSound && (
          <SoundToggleButton enabled={soundEnabled} onToggle={onToggleSound} size="toolbar" />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={moreOptionsTriggerRef}
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground"
              aria-label="More options"
            >
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
            <DropdownMenuItem
              onSelect={() => {
                sessionInfoTriggerRef.current = moreOptionsTriggerRef.current;
                onSessionInfoOpenChange(true);
              }}
            >
              Session Info
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <FeedbackDialog organizationId={organizationId} kiloSessionId={kiloSessionId} />
      </div>
    </>
  );
}
