'use client';
import React from 'react';

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
import { CHATGPT_USAGE_SETTINGS_URL } from '@/lib/ai-gateway/openai-chatgpt/usage-limit';

/**
 * The usage-limit message from the "Sign in with ChatGPT" partner guidelines.
 *
 * "Manage usage" is the primary action and opens the person's ChatGPT usage
 * settings, where the plan allowance and its reset time live. Kilo credits are
 * the secondary option: Kilo never serves ChatGPT credits, so the person who
 * does not want to wait for the reset continues on Kilo's own billing instead.
 */
export const USAGE_LIMIT_TITLE = 'ChatGPT usage limit reached';
export const USAGE_LIMIT_DESCRIPTION = 'Review your usage settings in ChatGPT.';
export const MANAGE_USAGE_LABEL = 'Manage usage';
export const BUY_CREDITS_LABEL = 'Buy Kilo credits instead';
const CREDITS_PATH = '/credits';

/**
 * The dialog's content, separate from the Radix wrapper so a test can render
 * the copy and the actions as markup: Radix portals its content, which no
 * server renderer emits.
 */
export function ChatGptUsageLimitContent() {
  return (
    <>
      <DialogHeader className="items-center text-center">
        <OpenAILogo className="size-8" />
        <DialogTitle>{USAGE_LIMIT_TITLE}</DialogTitle>
        <DialogDescription>{USAGE_LIMIT_DESCRIPTION}</DialogDescription>
      </DialogHeader>
      <DialogFooter className="flex-col gap-2 sm:flex-col">
        <Button asChild className="w-full">
          <a href={CHATGPT_USAGE_SETTINGS_URL} target="_blank" rel="noreferrer noopener">
            {MANAGE_USAGE_LABEL}
            <ExternalLink aria-hidden="true" />
          </a>
        </Button>
        <Button asChild variant="ghost" className="w-full">
          <Link href={CREDITS_PATH}>{BUY_CREDITS_LABEL}</Link>
        </Button>
      </DialogFooter>
    </>
  );
}

export function ChatGptUsageLimitDialog({
  open,
  onDismiss,
}: {
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
        <ChatGptUsageLimitContent />
      </DialogContent>
    </Dialog>
  );
}
