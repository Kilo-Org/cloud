'use client';

import { useSidebarToggle } from './CloudSidebarLayout';

export function MobileSidebarToggle() {
  const { toggleMobileSidebar } = useSidebarToggle();
  return (
    <button
      type="button"
      onClick={toggleMobileSidebar}
      className="text-muted-foreground hover:text-foreground border-border hover:bg-accent absolute left-3 top-3 z-10 cursor-pointer rounded-md border px-2.5 py-1 text-sm transition-colors lg:hidden"
    >
      Session list
    </button>
  );
}
