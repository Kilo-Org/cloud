'use client';
import React, { useState } from 'react';

import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { OpenAILogo } from '@/components/auth/OpenAILogo';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  CHATGPT_BUSINESS_USAGE_LIMIT_CODE,
  CHATGPT_USAGE_SETTINGS_URL,
} from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/usage-limit';

export const USAGE_LIMIT_TITLE = 'ChatGPT usage limit reached';
export const USAGE_LIMIT_DESCRIPTION = 'Review your usage settings in ChatGPT.';
export const MANAGE_USAGE_LABEL = 'Manage usage';
export const BUY_CREDITS_LABEL = 'Buy Kilo credits instead';
const CREDITS_PATH = '/credits';
const BUSINESS_USAGE_LIMIT_DESCRIPTION =
  "You've reached your workspace's limit for using your ChatGPT plan in other apps. Copy a message below to ask your workspace admin for increased usage limits.";
const BUSINESS_ADMIN_REQUEST = `I've reached the limit for using my ChatGPT plan in Kilo. Could you increase our workspace's usage limits so I can continue?

Go to admin.openai.com → Workspace → Usage limits.
Thank you!`;

export function ChatGptUsageLimitContent({ code }: { code: string | null }) {
  const isBusiness = code === CHATGPT_BUSINESS_USAGE_LIMIT_CODE;
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  async function copyAdminRequest() {
    try {
      await navigator.clipboard.writeText(BUSINESS_ADMIN_REQUEST);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }

  return (
    <>
      <DialogHeader className="items-center text-center">
        <OpenAILogo className="size-8" />
        <DialogTitle>{USAGE_LIMIT_TITLE}</DialogTitle>
        <DialogDescription>
          {isBusiness ? BUSINESS_USAGE_LIMIT_DESCRIPTION : USAGE_LIMIT_DESCRIPTION}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter className="flex-col gap-2 sm:flex-col">
        {isBusiness ? (
          <>
            <Button className="w-full" onClick={copyAdminRequest}>
              Copy request for admin
            </Button>
            <p role="status" className="text-muted-foreground text-center text-sm">
              {copyState === 'copied'
                ? 'Request copied. Send it to your workspace admin.'
                : copyState === 'error'
                  ? 'Could not copy the request. Try again.'
                  : null}
            </p>
          </>
        ) : (
          <>
            <Button asChild className="w-full">
              <a href={CHATGPT_USAGE_SETTINGS_URL} target="_blank" rel="noreferrer noopener">
                {MANAGE_USAGE_LABEL}
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
            <Button asChild variant="ghost" className="w-full">
              <Link href={CREDITS_PATH}>{BUY_CREDITS_LABEL}</Link>
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

export function ChatGptUsageLimitDialog({
  open,
  code,
  onDismiss,
}: {
  code: string | null;
  open: boolean;
  onDismiss: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onDismiss();
      }}
    >
      <DialogContent>
        <ChatGptUsageLimitContent code={code} />
      </DialogContent>
    </Dialog>
  );
}
