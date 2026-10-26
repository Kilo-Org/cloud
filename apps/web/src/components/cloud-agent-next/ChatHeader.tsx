'use client';

import { useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
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
import { SandboxStatusIndicator } from './SandboxStatusIndicator';

type ChatHeaderProps = {
  cloudAgentSessionId: string;
  changesCloudAgentSessionId?: string;
  worktreeId?: string;
  /** The worktree, or the session when it has none: chats of one worktree share its sandbox. */
  sandboxScopeId: string;
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
  /** Whether the source session is a Cloud Agent session that can be forked. */
  canForkToCloud?: boolean;
};

export function ChatHeader({
  cloudAgentSessionId,
  changesCloudAgentSessionId = cloudAgentSessionId,
  worktreeId,
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
  canForkToCloud = false,
  sandboxScopeId,
}: ChatHeaderProps) {
  const [showActionsDialog, setShowActionsDialog] = useState(false);
  const moreOptionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sessionCostBreakdown = useMemo(
    () => (sessionInfoOpen ? getSessionCostBreakdown?.() : undefined),
    [getSessionCostBreakdown, sessionInfoOpen]
  );

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
      />
      <SessionActionsDialog
        open={showActionsDialog}
        onOpenChange={setShowActionsDialog}
        kiloSessionId={kiloSessionId}
        sessionTitle={sessionTitle}
        repository={repository}
        organizationId={organizationId}
        canForkToCloud={canForkToCloud}
      />
      <div className="flex min-w-0 items-center gap-1">
        {/* First, so its late-loading counts grow into the reserved space on the left
            instead of moving the other controls. */}
        {onToggleChanges && (
          <WorktreeChangesButton
            key={`worktree-changes:${organizationId ?? 'personal'}:${worktreeId ?? changesCloudAgentSessionId}`}
            cloudAgentSessionId={changesCloudAgentSessionId}
            organizationId={organizationId}
            worktreeId={worktreeId}
            open={changesOpen}
            onToggle={onToggleChanges}
          />
        )}
        {sandboxStatusEligible && (
          <SandboxStatusIndicator
            key={`sandbox-status:${organizationId ?? 'personal'}:${sandboxScopeId}`}
            scopeId={sandboxScopeId}
            cloudAgentSessionId={cloudAgentSessionId}
            organizationId={organizationId}
            sessionActive={sessionActive}
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
