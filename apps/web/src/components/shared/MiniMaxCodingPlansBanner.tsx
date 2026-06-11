'use client';

import { useState, useEffect } from 'react';
import { Megaphone, X } from 'lucide-react';
import { Banner } from '@/components/shared/Banner';
import { Button } from '@/components/ui/button';

const DISMISS_KEY = 'minimax-coding-plans-banner-dismissed';

export function MiniMaxCodingPlansBanner() {
  // Start as dismissed to avoid a flash before localStorage is read
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setDismissed(localStorage.getItem(DISMISS_KEY) === 'true');
  }, []);

  if (dismissed) return null;

  function handleDismiss() {
    localStorage.setItem(DISMISS_KEY, 'true');
    setDismissed(true);
  }

  return (
    <Banner color="blue" role="banner" className="rounded-none border-x-0 border-t-0">
      <Banner.Icon>
        <Megaphone />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>New! Purchase MiniMax token plans with your Kilo Credits.</Banner.Title>
      </Banner.Content>
      <Banner.Action>
        <Banner.Button href="/subscriptions#coding-plans">Learn more</Banner.Button>
      </Banner.Action>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleDismiss}
        aria-label="Dismiss announcement"
        className="h-6 w-6 shrink-0 text-blue-400 hover:bg-blue-500/20 hover:text-blue-300"
      >
        <X className="h-4 w-4" />
      </Button>
    </Banner>
  );
}
