'use client';

import { CircleHelp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePylonChat } from '@/components/pylon-widget';

export function PylonSupportButton() {
  const { toggle, unreadCount } = usePylonChat();

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={toggle}
      className="fixed bottom-5 right-5 z-50 gap-1.5 rounded-full border-white/10 bg-black/60 py-2 pl-3 pr-4 text-white/80 shadow-lg backdrop-blur-sm hover:bg-white/10 hover:text-white"
    >
      <CircleHelp className="h-4 w-4" />
      Support
      {unreadCount > 0 && (
        <span className="ml-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-semibold leading-none text-white">
          {unreadCount}
        </span>
      )}
    </Button>
  );
}
