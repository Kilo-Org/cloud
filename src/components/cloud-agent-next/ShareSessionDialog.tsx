'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, Copy, Check } from 'lucide-react';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { CliSessionSharedState } from '@/types/cli-session-shared-state';

type ShareSessionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Kilo session ID (UUID from cliSessions.session_id) */
  kiloSessionId?: string;
};

export function ShareSessionDialog({ open, onOpenChange, kiloSessionId }: ShareSessionDialogProps) {
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

      const url = `${window.location.origin}/share/${result.share_id}`;
      setShareUrl(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to share session';
      toast.error(message);
    } finally {
      setIsSharing(false);
    }
  };

  const handleCopy = async () => {
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
    setTimeout(() => {
      setShareUrl(null);
      setIsCopied(false);
    }, 200);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share Session</DialogTitle>
          <DialogDescription>
            {shareUrl
              ? 'Your session is ready to share!'
              : 'Would you like to publicly share a snapshot of this session?'}
          </DialogDescription>
        </DialogHeader>

        {shareUrl && (
          <div className="flex items-center gap-2 overflow-hidden rounded-md border border-gray-700 bg-gray-800/50 p-3">
            <a
              href={shareUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate text-sm text-blue-400 hover:text-blue-300 hover:underline"
            >
              {shareUrl}
            </a>
            <Button size="sm" variant="outline" onClick={handleCopy} className="shrink-0">
              {isCopied ? (
                <>
                  <Check className="h-4 w-4" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  Copy
                </>
              )}
            </Button>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {shareUrl ? (
            <Button onClick={handleClose} className="w-full sm:w-auto">
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={handleClose}
                disabled={isSharing}
                className="w-full sm:w-auto"
              >
                Cancel
              </Button>
              <Button onClick={handleShare} disabled={isSharing} className="w-full sm:w-auto">
                {isSharing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Sharing...
                  </>
                ) : (
                  'Share'
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
