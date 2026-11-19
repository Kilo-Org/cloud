'use client';

import { useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  CornerUpLeft,
  ExternalLink,
  GitMerge,
  Globe,
  Info,
  Layers,
  MessageSquareWarning,
  MoreHorizontal,
  Share2,
} from 'lucide-react';
import Link from 'next/link';
import { SessionInfoDialog } from './SessionInfoDialog';
import type { SessionCostBreakdown } from './session-cost-breakdown';
import type { SessionUsage } from './session-token-usage';
import { SessionActionsDialog } from './SessionActionsDialog';
import { FeedbackDialog } from './FeedbackDialog';
import { PreviewPortDialog } from './PreviewPortDialog';
import type { PreviewController } from './use-preview-controller';
import { WorktreeChangesButton } from './WorktreeChanges';
import { WorkspaceArtifactsButton } from './WorkspaceArtifacts';
import { buildRepoBrowseUrl, detectGitPlatform } from './utils/git-utils';
import { SandboxStatusIndicator } from './SandboxStatusIndicator';
import { StackedWorkspaceActions } from './StackedWorkspaceActions';
import { useStackedWorkspaceSource } from './hooks/useStackedWorkspaceSource';
import { resolveStackedWorkspaceAvailability } from './workspace-stacks';
import type { WorktreeBranchOperationTarget } from './useWorktreeBranchOperations';

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

type ChatHeaderProps = {
  /** The signed-in user: worktree caches are partitioned by user. */
  currentUserId: string;
  parentSessionHref?: string;
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
  preview: PreviewController;
  changesOpen?: boolean;
  onToggleChanges?: (event: MouseEvent<HTMLButtonElement>) => void;
  artifactsOpen?: boolean;
  onToggleArtifacts?: (event: MouseEvent<HTMLButtonElement>) => void;
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
  parentSessionHref,
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
  preview,
  changesOpen = false,
  onToggleChanges,
  artifactsOpen = false,
  onToggleArtifacts,
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
  const [showActionsDialog, setShowActionsDialog] = useState(false);
  const [showBranchOperations, setShowBranchOperations] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const preflight = useStackedWorkspaceSource({
    worktreeId,
    organizationId,
    enabled: Boolean(stack && menuOpen),
  });
  const { canCreateStackedWorkspace, createStackedWorkspaceDisabledReason } =
    resolveStackedWorkspaceAvailability({
      source: preflight.source,
      isPending: preflight.isPending && Boolean(stack && menuOpen),
      isError: preflight.isError,
      fallbackCanCreate: stack?.canCreateStackedWorkspace,
      fallbackDisabledReason: stack?.createStackedWorkspaceDisabledReason,
    });
  const moreOptionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreMoreOptionsFocus = (event: Event) => {
    const trigger = moreOptionsTriggerRef.current;
    if (!trigger?.isConnected) return;
    event.preventDefault();
    trigger.focus();
  };
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
        organizationId={organizationId}
        sandboxScopeId={sandboxScopeId}
        computeBillingEnabled={sandboxStatusEligible}
        kiloSessionId={kiloSessionId}
        model={model}
        modelDisplayName={modelDisplayName}
        sessionCostBreakdown={sessionCostBreakdown}
        sessionTokenUsage={sessionUsage?.tokens}
        sessionModelUsage={sessionUsage?.models}
        hasIncompleteHistory={hasIncompleteHistory}
      />
      <SessionActionsDialog
        key={kiloSessionId}
        open={showActionsDialog}
        onOpenChange={setShowActionsDialog}
        kiloSessionId={kiloSessionId}
        cloudAgentSessionId={cloudAgentSessionId}
        sessionTitle={sessionTitle}
        repository={repository}
        organizationId={organizationId}
        canForkToCloud={canForkToCloud}
      />
      {preview.dialog && (
        <PreviewPortDialog {...preview.dialog} onCloseAutoFocus={restoreMoreOptionsFocus} />
      )}
      <FeedbackDialog
        open={showFeedback}
        onOpenChange={setShowFeedback}
        onCloseAutoFocus={restoreMoreOptionsFocus}
        organizationId={organizationId}
        kiloSessionId={kiloSessionId}
      />
      {stack?.branchOperations && Boolean(stack.branchOperations.cloudAgentSessionId) && (
        <StackedWorkspaceActions
          open={showBranchOperations}
          onOpenChange={setShowBranchOperations}
          worktreeId={stack.branchOperations.worktreeId}
          cloudAgentSessionId={stack.branchOperations.cloudAgentSessionId}
          branch={stack.branchOperations.branch}
          baseBranch={stack.branchOperations.baseBranch}
          stack={stack.branchOperations.stack}
          organizationId={organizationId}
          onSendInstruction={onSendStackInstruction}
          onCompleted={onStackOperationCompleted}
        />
      )}
      <div className="flex min-w-0 items-center gap-1">
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
        {onToggleArtifacts && (
          <WorkspaceArtifactsButton
            key={`workspace-artifacts:${currentUserId}:${organizationId ?? 'personal'}:${worktreeId ?? changesCloudAgentSessionId}`}
            userId={currentUserId}
            cloudAgentSessionId={changesCloudAgentSessionId}
            organizationId={organizationId}
            open={artifactsOpen}
            onToggle={onToggleArtifacts}
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
        {(onToggleChanges || onToggleArtifacts || sandboxStatusEligible) && (
          <span aria-hidden="true" className="bg-border mx-0.5 h-4 w-px shrink-0" />
        )}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              ref={moreOptionsTriggerRef}
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground relative data-[state=open]:bg-secondary"
              aria-label="More options"
              aria-description={stack?.behindParent ? 'Branch is behind its parent' : undefined}
            >
              <MoreHorizontal aria-hidden="true" />
              {stack?.behindParent && (
                <span
                  aria-hidden="true"
                  className="bg-status-warning-icon absolute top-1.5 right-1.5 size-1.5 rounded-full"
                />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={event => {
              if (showFeedback || preview.dialog?.open) event.preventDefault();
            }}
          >
            {preview.dialog && (
              <>
                <DropdownMenuItem onSelect={preview.openDialog}>
                  <Globe aria-hidden="true" />
                  Open preview
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {parentSessionHref && (
              <>
                <DropdownMenuItem asChild>
                  <Link href={parentSessionHref}>
                    <CornerUpLeft aria-hidden="true" />
                    Open parent session
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onSelect={() => setShowActionsDialog(true)}>
              <Share2 aria-hidden="true" />
              Share or Fork
            </DropdownMenuItem>
            {repoUrl && (
              <DropdownMenuItem asChild>
                <a href={repoUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden="true" />
                  Open in GitHub
                </a>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => {
                sessionInfoTriggerRef.current = moreOptionsTriggerRef.current;
                onSessionInfoOpenChange(true);
              }}
            >
              <Info aria-hidden="true" />
              Session Info
            </DropdownMenuItem>
            {stack && (
              <>
                <DropdownMenuSeparator />
                {stack.behindParent && (
                  <DropdownMenuLabel className="text-muted-foreground text-xs">
                    Branch is behind its parent
                  </DropdownMenuLabel>
                )}
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
                    stack.onCreateStackedWorkspace?.();
                  }}
                >
                  <Layers aria-hidden="true" />
                  New stacked workspace
                </DropdownMenuItem>
                {stack.branchOperations && Boolean(stack.branchOperations.cloudAgentSessionId) && (
                  <DropdownMenuItem onSelect={() => setShowBranchOperations(true)}>
                    <GitMerge aria-hidden="true" />
                    Branch operations
                  </DropdownMenuItem>
                )}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setShowFeedback(true)}>
              <MessageSquareWarning aria-hidden="true" />
              Send feedback
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}
