'use client';

import { Fragment, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ExternalLink, MoreHorizontal, ChevronLeft, Layers, GitMerge } from 'lucide-react';
import { useFeatureFlagEnabled } from 'posthog-js/react';
import { SessionInfoDialog } from './SessionInfoDialog';
import type { SessionCostBreakdown } from './session-cost-breakdown';
import type { SessionUsage } from './session-token-usage';
import { SessionActionsDialog } from './SessionActionsDialog';
import { SoundToggleButton } from '@/components/shared/SoundToggleButton';
import { FeedbackDialog } from './FeedbackDialog';
import { WorktreeChangesButton } from './WorktreeChanges';
import { buildRepoBrowseUrl, detectGitPlatform } from './utils/git-utils';
import { SandboxStatusIndicator } from './SandboxStatusIndicator';
import { CLOUD_AGENT_STACKED_WORKSPACES_FLAG } from './feature-flags';
import { StackedWorkspaceActions } from './StackedWorkspaceActions';
import { useStackedWorkspaceSource } from './hooks/useStackedWorkspaceSource';
import { resolveStackedWorkspaceAvailability } from './workspace-stacks';
import type { WorktreeBranchOperationTarget } from './useWorktreeBranchOperations';
import { Badge } from '@/components/ui/badge';

export type ChatStackBreadcrumbItem = {
  worktreeId: string;
  label: string;
  prNumber: number | null;
  prState: string | null;
  prUrl: string | null;
  isCurrent: boolean;
};

export type ChatStackInfo = {
  entries: readonly ChatStackBreadcrumbItem[];
  behindParent: boolean;
  remoteBranchChanged: boolean;
  canCreateStackedWorkspace: boolean;
  createStackedWorkspaceDisabledReason: string | null;
  onCreateStackedWorkspace?: () => void;
  onOpenWorktree?: (worktreeId: string) => void;
  branchOperations?: {
    worktreeId: string;
    cloudAgentSessionId: string;
    branch: string | null;
    baseBranch: string | null;
    stack: readonly WorktreeBranchOperationTarget[];
  };
};

function prStateLabel(state: string | null): string {
  return state === 'draft' || state === 'closed' || state === 'merged' ? state : '';
}

type ChatHeaderProps = {
  /** The signed-in user: worktree caches are partitioned by user. */
  currentUserId: string;
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
  getSessionUsage?: () => SessionUsage;
  hasIncompleteHistory?: boolean;
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
  stack?: ChatStackInfo | null;
  onSendStackInstruction?: (instruction: string) => Promise<boolean | void> | boolean | void;
  onStackOperationCompleted?: () => void;
};

export function ChatHeader({
  currentUserId,
  cloudAgentSessionId,
  changesCloudAgentSessionId = cloudAgentSessionId,
  worktreeId,
  repository,
  branch,
  gitUrl,
  model = 'Unknown',
  modelDisplayName,
  getSessionCostBreakdown,
  getSessionUsage,
  hasIncompleteHistory,
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
  stack = null,
  onSendStackInstruction,
  onStackOperationCompleted,
}: ChatHeaderProps) {
  const stackedWorkspacesEnabled = useFeatureFlagEnabled(CLOUD_AGENT_STACKED_WORKSPACES_FLAG);
  const [showActionsDialog, setShowActionsDialog] = useState(false);
  const [showBranchOperations, setShowBranchOperations] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const stackedInfo = stackedWorkspacesEnabled ? stack : null;
  const preflight = useStackedWorkspaceSource({
    worktreeId,
    organizationId,
    enabled: Boolean(stackedInfo && menuOpen),
  });
  const { canCreateStackedWorkspace, createStackedWorkspaceDisabledReason } =
    resolveStackedWorkspaceAvailability({
      source: preflight.source,
      isPending: preflight.isPending && Boolean(stackedInfo && menuOpen),
      isError: preflight.isError,
      fallbackCanCreate: stackedInfo?.canCreateStackedWorkspace,
      fallbackDisabledReason: stackedInfo?.createStackedWorkspaceDisabledReason,
    });
  const moreOptionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sessionCostBreakdown = useMemo(
    () => (sessionInfoOpen ? getSessionCostBreakdown?.() : undefined),
    [getSessionCostBreakdown, sessionInfoOpen]
  );
  const sessionUsage = useMemo(
    () => (sessionInfoOpen ? getSessionUsage?.() : undefined),
    [getSessionUsage, sessionInfoOpen]
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
        sessionTokenUsage={sessionUsage?.tokens}
        sessionModelUsage={sessionUsage?.models}
        hasIncompleteHistory={hasIncompleteHistory}
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
      {stackedInfo?.branchOperations &&
        Boolean(stackedInfo.branchOperations.cloudAgentSessionId) && (
          <StackedWorkspaceActions
            open={showBranchOperations}
            onOpenChange={setShowBranchOperations}
            worktreeId={stackedInfo.branchOperations.worktreeId}
            cloudAgentSessionId={stackedInfo.branchOperations.cloudAgentSessionId}
            branch={stackedInfo.branchOperations.branch}
            baseBranch={stackedInfo.branchOperations.baseBranch}
            stack={stackedInfo.branchOperations.stack}
            organizationId={organizationId}
            onSendInstruction={onSendStackInstruction}
            onCompleted={onStackOperationCompleted}
          />
        )}
      <div className="flex min-w-0 items-center gap-1">
        {stackedInfo && stackedInfo.entries.length > 0 && (
          <nav
            aria-label="Workspace stack"
            className="hidden min-w-0 items-center gap-0.5 overflow-x-auto md:flex"
          >
            {stackedInfo.entries.map((entry, index) => (
              <Fragment key={entry.worktreeId}>
                {index > 0 && (
                  <ChevronLeft
                    className="text-muted-foreground size-3 shrink-0"
                    aria-hidden="true"
                  />
                )}
                <button
                  type="button"
                  onClick={() => stackedInfo.onOpenWorktree?.(entry.worktreeId)}
                  disabled={!stackedInfo.onOpenWorktree}
                  aria-current={entry.isCurrent ? 'page' : undefined}
                  title={`Open ${entry.label}`}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring aria-[current=page]:text-foreground inline-flex min-w-0 max-w-32 items-center gap-1 rounded-sm px-1 py-1 text-xs focus-visible:ring-2 focus-visible:outline-none disabled:cursor-default"
                >
                  <span className="min-w-0 truncate font-mono">{entry.label}</span>
                </button>
                {entry.prNumber !== null &&
                  (entry.prUrl ? (
                    <a
                      href={entry.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring shrink-0 rounded-sm font-mono text-xs focus-visible:ring-2 focus-visible:outline-none"
                      title={`Open pull request #${entry.prNumber}`}
                      onClick={event => event.stopPropagation()}
                    >
                      #{entry.prNumber}
                    </a>
                  ) : (
                    <span className="text-muted-foreground shrink-0 font-mono text-xs">
                      #{entry.prNumber}
                    </span>
                  ))}
                {prStateLabel(entry.prState) && (
                  <span className="shrink-0 text-[10px] uppercase">
                    {prStateLabel(entry.prState)}
                  </span>
                )}
              </Fragment>
            ))}
            {stackedInfo.behindParent && (
              <Badge
                variant="outline"
                className="shrink-0 text-[10px] font-normal"
                title="This branch does not include the latest changes from its parent. Sync or restack it from Branch operations."
              >
                Behind parent
              </Badge>
            )}
            {stackedInfo.remoteBranchChanged && (
              <button
                type="button"
                onClick={() => {
                  if (stackedInfo.branchOperations) setShowBranchOperations(true);
                }}
                className="focus-visible:ring-ring shrink-0 rounded-sm border border-amber-500/40 px-1.5 py-0.5 text-[10px] text-amber-700 focus-visible:ring-2 focus-visible:outline-none dark:text-amber-400"
                title="A push was rejected because the remote branch has commits this worktree lacks. Sync to fast-forward."
              >
                Remote branch changed
              </button>
            )}
          </nav>
        )}
        {/* First, so its late-loading counts grow into the reserved space on the left
            instead of moving the other controls. */}
        {onToggleChanges && (
          <WorktreeChangesButton
            key={`worktree-changes:${currentUserId}:${organizationId ?? 'personal'}:${worktreeId ?? changesCloudAgentSessionId}`}
            userId={currentUserId}
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
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
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
            {stackedInfo && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  aria-disabled={!canCreateStackedWorkspace}
                  title={
                    createStackedWorkspaceDisabledReason ?? 'Start a workspace stacked on this one'
                  }
                  onSelect={event => {
                    if (!canCreateStackedWorkspace) {
                      event.preventDefault();
                      return;
                    }
                    stackedInfo.onCreateStackedWorkspace?.();
                  }}
                >
                  <Layers className="mr-2 h-4 w-4" />
                  New stacked workspace
                </DropdownMenuItem>
                {stackedInfo.branchOperations &&
                  Boolean(stackedInfo.branchOperations.cloudAgentSessionId) && (
                    <DropdownMenuItem onSelect={() => setShowBranchOperations(true)}>
                      <GitMerge className="mr-2 h-4 w-4" />
                      Branch operations
                    </DropdownMenuItem>
                  )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <FeedbackDialog organizationId={organizationId} kiloSessionId={kiloSessionId} />
      </div>
    </>
  );
}
