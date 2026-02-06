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
import { Loader2, Copy, Check, Share2, GitFork } from 'lucide-react';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { CliSessionSharedState } from '@/types/cli-session-shared-state';
import { OpenInEditorButton } from '@/app/share/[shareId]/open-in-editor-button';
import { OpenInCliButton } from '@/app/share/[shareId]/open-in-cli-button';
import { CopyableCommand } from '@/components/CopyableCommand';

type SessionActionsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Kilo session ID (UUID from cliSessions.session_id) */
  kiloSessionId?: string;
  sessionTitle?: string;
  repository?: string;
};

export function SessionActionsDialog({
  open,
  onOpenChange,
  kiloSessionId,
  sessionTitle,
  repository,
}: SessionActionsDialogProps) {
  const [isSharing, setIsSharing] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const trpc = useRawTRPCClient();

  const handleShare = async () => {
    if (!kiloSessionId) {
      toast.error('Session ID is missing');
      return;
    }

    setIsSharing(true);

    try {
      const result = await trpc.cliSessions.share.mutate({
        session_id: kiloSessionId,
        shared_state: CliSessionSharedState.Public,
      });

      const url = new URL(`/share/${result.share_id}`, window.location.origin).toString();
      setShareUrl(url);
      toast.success('Session shared successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to share session';
      toast.error(message);
    } finally {
      setIsSharing(false);
    }
  };

  const handleCopyShareUrl = async () => {
    if (!shareUrl) return;

    try {
      await navigator.clipboard.writeText(shareUrl);
      setIsCopied(true);
      toast.success('Link copied to clipboard');
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      toast.error('Failed to copy link');
    }
  };

  const handleClose = () => {
    onOpenChange(false);
    // Reset state after dialog closes
    setTimeout(() => {
      setShareUrl(null);
      setIsCopied(false);
    }, 200);
  };

  const truncateId = (id: string, length: number = 8): string => {
    if (id.length <= length) return id;
    return `${id.slice(0, length)}...`;
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
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
            <p className="text-muted-foreground text-xs">
              Share a public snapshot of this session with others
            </p>

            {shareUrl ? (
              <div className="space-y-2">
                <div className="overflow-hidden rounded-md border border-gray-700 bg-gray-800/50 p-3">
                  <a
                    href={shareUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-sm break-all text-blue-400 hover:text-blue-300 hover:underline"
                  >
                    {shareUrl}
                  </a>
                </div>
                <Button size="sm" variant="outline" onClick={handleCopyShareUrl} className="w-full">
                  {isCopied ? (
                    <>
                      <Check className="h-4 w-4" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" />
                      Copy Link
                    </>
                  )}
                </Button>
              </div>
            ) : (
              <Button
                onClick={handleShare}
                disabled={isSharing || !kiloSessionId}
                variant="outline"
                className="w-full"
              >
                {isSharing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Sharing...
                  </>
                ) : (
                  <>
                    <Share2 className="h-4 w-4" />
                    Share Session
                  </>
                )}
              </Button>
            )}
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
              Fork this session to continue working on it in your editor or CLI
            </p>

            {kiloSessionId && (
              <div className="space-y-3">
                {/* Open in Editor */}
                <div className="flex justify-center">
                  <OpenInEditorButton sessionId={kiloSessionId} />
                </div>

                {/* Open in CLI */}
                <div className="flex justify-center">
                  <OpenInCliButton command={`kilocode --fork ${kiloSessionId}`} />
                </div>

                {/* Manual fork command */}
                <div className="space-y-2">
                  <p className="text-muted-foreground text-xs">Or use the fork command manually:</p>
                  <CopyableCommand
                    command={`/session fork ${kiloSessionId}`}
                    className="bg-muted rounded-md px-3 py-2 text-sm"
                  />
                </div>
              </div>
            )}

            {!kiloSessionId && (
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
