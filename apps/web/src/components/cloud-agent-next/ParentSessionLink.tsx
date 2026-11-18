'use client';

import Link from 'next/link';
import { ArrowUpRight, CornerUpLeft } from 'lucide-react';
import { getChatDisplayTitle } from './utils/session-title';

export function ParentSessionLink({ href, title }: { href: string; title: string | null }) {
  const parentTitle = getChatDisplayTitle(title);

  return (
    <div className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs leading-4">
      <CornerUpLeft className="size-3 shrink-0" aria-hidden="true" />
      <span className="hidden shrink-0 sm:inline">Started from:</span>
      <Link
        href={href}
        title={parentTitle}
        aria-label={`View parent session: ${parentTitle}`}
        className="hover:text-foreground focus-visible:ring-ring inline-flex min-h-6 min-w-0 items-center gap-1 rounded-sm hover:underline focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="hidden truncate sm:inline">{parentTitle}</span>
        <span className="sm:hidden">View parent</span>
        <ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />
      </Link>
    </div>
  );
}
