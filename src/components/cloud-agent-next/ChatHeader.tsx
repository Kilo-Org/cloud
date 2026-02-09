'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { GitBranch, ExternalLink, Loader2, Info, Menu, TrendingUpDown } from 'lucide-react';
import { useState } from 'react';
import { SessionInfoDialog } from './SessionInfoDialog';
import { SessionActionsDialog } from './SessionActionsDialog';
import { SoundToggleButton } from '@/components/shared/SoundToggleButton';

type ChatHeaderProps = {
  /** The cloud-agent session ID (e.g., agent_xxx format) */
  cloudAgentSessionId: string;
  /** The Kilo session ID (UUID from cliSessions.session_id) */
  kiloSessionId?: string;
  repository: string;
  branch?: string;
  model?: string;
  isStreaming?: boolean;
  totalCost?: number;
  onMenuClick?: () => void;
  soundEnabled?: boolean;
  onToggleSound?: () => void;
  sessionTitle?: string;
};

export function ChatHeader({
  cloudAgentSessionId,
  repository,
  branch,
  model = 'Unknown',
  isStreaming = false,
  totalCost = 0,
  onMenuClick,
  soundEnabled = true,
  onToggleSound,
  kiloSessionId,
  sessionTitle,
}: ChatHeaderProps) {
  const [showInfoDialog, setShowInfoDialog] = useState(false);
  const [showActionsDialog, setShowActionsDialog] = useState(false);

  const githubUrl = branch
    ? `https://github.com/${repository}/compare/session/${branch}?expand=1`
    : `https://github.com/${repository}`;

  return (
    <>
      <SessionInfoDialog
        open={showInfoDialog}
        onOpenChange={setShowInfoDialog}
        sessionId={cloudAgentSessionId}
        kiloSessionId={kiloSessionId}
        model={model}
        cost={totalCost * 1_000_000}
      />
      <SessionActionsDialog
        open={showActionsDialog}
        onOpenChange={setShowActionsDialog}
        kiloSessionId={kiloSessionId}
        sessionTitle={sessionTitle}
        repository={repository}
      />
      <div className="bg-background w-full max-w-full border-b px-3 py-2 md:px-4 md:py-3">
        <div className="flex w-full max-w-full items-center justify-between gap-2 overflow-x-hidden md:gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-3">
            {/* Hamburger menu - only visible on mobile */}
            {onMenuClick && (
              <Button
                size="icon"
                variant="ghost"
                onClick={onMenuClick}
                className="h-11 min-h-11 w-11 min-w-11 lg:hidden"
                title="Open menu"
                aria-label="Open menu"
              >
                <Menu className="h-5 w-5" />
              </Button>
            )}

            {/* Info button - only visible on mobile */}
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setShowInfoDialog(true)}
              className="h-11 min-h-11 w-11 min-w-11 lg:hidden"
              title="Session information"
              aria-label="Session information"
            >
              <Info className="h-5 w-5" />
            </Button>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-semibold text-gray-100 md:text-lg">
                  <span className="lg:hidden">Session</span>
                  <span className="hidden lg:inline">Cloud Agent Session</span>
                </h2>
                <Badge variant="new" className="hidden lg:inline-flex">
                  new
                </Badge>
                {isStreaming && (
                  <Badge variant="outline" className="hidden items-center gap-1 lg:flex">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Streaming
                  </Badge>
                )}
                {model && model !== 'Unknown' && (
                  <Badge variant="outline" className="hidden items-center gap-1 lg:flex">
                    {model}
                  </Badge>
                )}
                {totalCost > 0 && (
                  <Badge variant="secondary" className="hidden items-center gap-1 lg:flex">
                    ${totalCost.toFixed(4)}
                  </Badge>
                )}
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-gray-400 md:text-sm">
                <GitBranch className="h-3 w-3 shrink-0" />
                <span className="truncate">{repository}</span>
                <a
                  href={githubUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-blue-400 transition-colors hover:text-blue-300"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          </div>
          <div className="hidden items-center gap-2 lg:flex">
            {onToggleSound && (
              <SoundToggleButton enabled={soundEnabled} onToggle={onToggleSound} size="sm" />
            )}
            {/* Session Actions Button */}
            <Button
              variant="outline"
              onClick={() => setShowActionsDialog(true)}
              className="gap-2"
              title="Share or fork this session"
              aria-label="Share or fork this session"
            >
              <TrendingUpDown className="h-4 w-4" />
              Share or Fork
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
