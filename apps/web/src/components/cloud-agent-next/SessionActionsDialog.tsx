'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, Share2, GitFork, Cloud } from 'lucide-react';
import { CopyableCommand } from '@/components/CopyableCommand';
import { OpenInEditorButton } from '@/app/share/[shareId]/open-in-editor-button';
import { useCloudSessionFork } from './use-cloud-session-fork';
import { SessionSharePanel } from './SessionSharePanel';

type SessionActionsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Kilo session ID (UUID from cli_sessions_v2.session_id) */
  kiloSessionId?: string;
  sessionTitle?: string;
  repository?: string;
  /** Organization context the dialog renders in; omitted for personal sessions. */
  organizationId?: string;
  /** Whether the source session is a Cloud Agent session that can be forked. */
  canForkToCloud?: boolean;
};

export function SessionActionsDialog({
  open,
  onOpenChange,
  kiloSessionId,
  sessionTitle,
  repository,
  organizationId,
  canForkToCloud = false,
}: SessionActionsDialogProps) {
  const [isSharing, setIsSharing] = useState(false);
  const { forkSessionToNewCloudSession, forkingSessionId } = useCloudSessionFork(organizationId);
  const isForkingToCloud = forkingSessionId === kiloSessionId;

  const handleClose = () => {
    if (!isSharing) onOpenChange(false);
  };

  const handleForkToCloud = async () => {
    if (!kiloSessionId) return;
    const forked = await forkSessionToNewCloudSession(kiloSessionId);
    if (forked) {
      handleClose();
    }
  };

  const truncateId = (id: string, length: number = 8): string => {
    if (id.length <= length) return id;
    return `${id.slice(0, length)}...`;
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md" showCloseButton={!isSharing}>
        <DialogHeader>
          <DialogTitle>Session Actions</DialogTitle>
          <DialogDescription>Share or fork this session</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Session Info */}
          {kiloSessionId && (
            <div className="bg-muted/50 space-y-1.5 rounded-lg p-3 text-sm">
              {sessionTitle && (
                <p className="line-clamp-2">
                  <span className="text-muted-foreground">Session:</span> {sessionTitle}
                </p>
              )}
              {repository && (
                <p>
                  <span className="text-muted-foreground">Repository:</span> {repository}
                </p>
              )}
              <p className="font-mono text-xs">
                <span className="text-muted-foreground">ID:</span> {truncateId(kiloSessionId, 36)}
              </p>
            </div>
          )}

          {/* Share Section */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Share2 className="h-4 w-4" />
              <h3 className="text-sm font-medium">Share Session</h3>
            </div>
            <SessionSharePanel
              kiloSessionId={kiloSessionId}
              isSharing={isSharing}
              onSharingChange={setIsSharing}
            />
          </div>

          {/* Divider */}
          <div className="border-border border-t" />

          {/* Fork Section */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <GitFork className="h-4 w-4" />
              <h3 className="text-sm font-medium">Fork Session</h3>
            </div>
            <p className="text-muted-foreground text-xs">
              {canForkToCloud
                ? 'Fork this session to continue working on it in your editor, CLI, or a new Cloud Agent session'
                : 'Fork this session to continue working on it in your editor or CLI'}
            </p>

            {kiloSessionId ? (
              <div className="space-y-3">
                {canForkToCloud && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full gap-2"
                    disabled={isForkingToCloud}
                    onClick={() => void handleForkToCloud()}
                  >
                    {isForkingToCloud ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Cloud className="h-4 w-4" />
                    )}
                    {isForkingToCloud
                      ? 'Forking to a new Cloud Agent session...'
                      : 'Fork to a new Cloud Agent session'}
                  </Button>
                )}

                <div className="flex justify-center">
                  <OpenInEditorButton
                    sessionId={kiloSessionId}
                    pathOverride={`/s/${kiloSessionId}`}
                  />
                </div>

                <div className="space-y-2">
                  <p className="text-muted-foreground text-xs">Use this command in CLI:</p>
                  <CopyableCommand
                    command={`kilo --session ${kiloSessionId} --cloud-fork`}
                    className="bg-muted rounded-md px-3 py-2 text-sm"
                  />
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground text-center text-sm">
                Session ID not available yet
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
