'use client';

import { useState } from 'react';
import { MessageCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { MessageBubble } from '@/components/cloud-agent/MessageBubble';
import type { Message } from '@/components/cloud-agent/types';

type PreviewDialogProps = {
  messages: Message[];
  totalCount: number;
  userName?: string;
  userAvatarUrl?: string;
  sessionTitle?: string;
};

export function SessionPreviewDialog({
  messages,
  totalCount,
  userName,
  userAvatarUrl,
  sessionTitle,
}: PreviewDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex justify-center">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" className="gap-2">
            <MessageCircle className="h-4 w-4" />
            Preview session
          </Button>
        </DialogTrigger>
        <DialogContent className="flex h-[80vh] max-h-[80vh] w-full max-w-2xl flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 shrink-0" />
              <span className="truncate" title={sessionTitle}>
                {sessionTitle || 'Session Preview'}
              </span>
            </DialogTitle>
            <DialogDescription>Preview of the shared session</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-2">
            {messages.length === 0 ? (
              <div className="text-muted-foreground py-8 text-center text-sm">
                No messages to preview
              </div>
            ) : (
              <>
                {messages.map((msg, index) => (
                  <MessageBubble
                    key={msg.timestamp || index}
                    message={{
                      ...msg,
                      // Truncate long assistant messages for preview
                      content:
                        msg.role === 'assistant' && msg.content.length > 500
                          ? `${msg.content.slice(0, 500)}...`
                          : msg.content,
                    }}
                    userName={msg.role === 'user' ? userName : undefined}
                    userAvatarUrl={msg.role === 'user' ? userAvatarUrl : undefined}
                  />
                ))}
                {totalCount > 10 && (
                  <div className="text-muted-foreground pt-4 text-center text-sm">
                    ... and {totalCount - 10} more messages
                  </div>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
