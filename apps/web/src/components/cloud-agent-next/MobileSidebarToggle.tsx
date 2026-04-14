'use client';

import { cn } from '@/lib/utils';
import { useSidebarToggle } from './CloudSidebarLayout';

type MobileSidebarToggleProps = {
  variant?: 'floating' | 'inline';
  label?: string;
};

export function MobileSidebarToggle({
  variant = 'floating',
  label = 'Session list',
}: MobileSidebarToggleProps = {}) {
  const { toggleMobileSidebar } = useSidebarToggle();
  return (
    <button
      type="button"
      onClick={toggleMobileSidebar}
      className={cn(
        'text-muted-foreground hover:text-foreground border-border hover:bg-accent cursor-pointer rounded-md border px-2.5 py-1 text-sm transition-colors lg:hidden',
        variant === 'floating' ? 'absolute left-3 top-3 z-10' : 'shrink-0'
      )}
    >
      {label}
    </button>
  );
}
