'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { AgentCardIcon } from './icons/AgentCardIcon';

// One-time, dismissible prompt shown after first sign-in inviting the user to
// connect Agentcard. It is purely opt-in: nothing happens unless the user
// clicks Connect (which kicks off the OAuth flow). Dismissal is remembered in
// localStorage so we never nag a user who has said "Not now".
const DISMISS_KEY = 'kiloclaw:agentcard-connect-prompt:dismissed';

export function AgentCardConnectPrompt() {
  const { data: status, isLoading } = useKiloClawStatus();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (isLoading || !status) return;
    // Only prompt once the user has a live instance (skips onboarding), and
    // never if they're already connected or have dismissed the prompt before.
    if (!status.status) return;
    if (status.agentcardOAuthConnected) return;
    try {
      if (localStorage.getItem(DISMISS_KEY)) return;
    } catch {
      // localStorage unavailable (e.g. privacy mode) — just don't prompt.
      return;
    }
    setOpen(true);
  }, [isLoading, status]);

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // ignore — worst case the prompt shows again next session.
    }
    setOpen(false);
  }

  // Connect from the dashboard; return the user here afterward.
  const connectUrl = '/api/integrations/agentcard/connect?returnTo=%2Fclaw';

  return (
    <Dialog open={open} onOpenChange={next => (next ? setOpen(true) : dismiss())}>
      <DialogContent>
        <DialogHeader>
          <div className="mb-1 flex items-center gap-2">
            <AgentCardIcon className="h-6 w-auto shrink-0" />
            <DialogTitle>Connect Agentcard?</DialogTitle>
          </div>
          <DialogDescription>
            Give your agent the ability to create and spend virtual debit cards, with per-task spend
            limits enforced by Agentcard. You authenticate with your own Agentcard account — Kilo
            never sees a long-lived key.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
          <p className="text-amber-400 text-xs font-medium">
            Warning: this can permit your agent to spend real money. Use caution.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={dismiss}>
            Not now
          </Button>
          <Button asChild size="sm" onClick={() => setOpen(false)}>
            <Link href={connectUrl}>Connect Agentcard</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
