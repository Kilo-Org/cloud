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
import { GitBranch, ExternalLink, Menu, MoreHorizontal } from 'lucide-react';
import { SessionInfoDialog } from './SessionInfoDialog';
import { SessionActionsDialog } from './SessionActionsDialog';
import { SoundToggleButton } from '@/components/shared/SoundToggleButton';
import { FeedbackDialog } from './FeedbackDialog';
import { buildRepoBrowseUrl, detectGitPlatform } from './utils/git-utils';
import { useSidebarToggle } from './CloudSidebarLayout';
import { formatShortModelName } from '@/lib/format-model-name';

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
}: ChatHeaderProps) {
  const [showInfoDialog, setShowInfoDialog] = useState(false);
  const [showActionsDialog, setShowActionsDialog] = useState(false);
  const { toggleMobileSidebar } = useSidebarToggle();

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
        cost={totalCost * 1_000_000}
      />
      <SessionActionsDialog
        open={showActionsDialog}
        onOpenChange={setShowActionsDialog}
        kiloSessionId={kiloSessionId}
        sessionTitle={sessionTitle}
        repository={repository}
      />
      <div className="bg-background w-full border-b px-3 py-2">
        <div className="flex items-center gap-2 overflow-hidden">
          {/* Mobile hamburger */}
          <Button
            size="icon"
            variant="ghost"
            onClick={toggleMobileSidebar}
            className="h-8 w-8 shrink-0 lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </Button>

          {/* Left: repo, branch, model, cost */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
            {repository && (
              <>
                <GitBranch className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                <span className="truncate font-medium">{repository}</span>
              </>
            )}
            {branch && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground truncate">{branch}</span>
              </>
            )}
            {model && model !== 'Unknown' && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground hidden shrink-0 sm:inline">
                  {modelDisplayName ?? formatShortModelName(model)}
                </span>
              </>
            )}
            {totalCost > 0 && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground shrink-0">${totalCost.toFixed(4)}</span>
              </>
            )}
          </div>

          {/* Right: sound toggle + overflow menu */}
          <div className="flex shrink-0 items-center gap-1">
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
        </div>
      </div>
    </>
  );
}
