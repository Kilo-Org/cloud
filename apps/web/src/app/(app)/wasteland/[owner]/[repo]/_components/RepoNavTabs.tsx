'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { GitFork, GitPullRequest, ScrollText, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';

type RepoNavTabsProps = {
  owner: string;
  repo: string;
};

type TabDef = {
  /** URL segment after the base. Empty string for the index (upstream view). */
  segment: '' | 'fork' | 'pulls' | 'settings';
  label: string;
  icon: typeof ScrollText;
};

const TABS: readonly TabDef[] = [
  { segment: '', label: 'Upstream', icon: ScrollText },
  { segment: 'fork', label: 'Fork', icon: GitFork },
  { segment: 'pulls', label: 'Pulls', icon: GitPullRequest },
  { segment: 'settings', label: 'Settings', icon: Settings },
];

/**
 * Horizontal nav for the per-wasteland routes. Built from `Link` +
 * `usePathname` rather than the Radix `Tabs` primitive because each tab
 * is a distinct URL — we want real navigation, browser back, and shareable
 * links, not a controlled tabs widget.
 */
export function RepoNavTabs({ owner, repo }: RepoNavTabsProps) {
  const pathname = usePathname();
  const base = `/wasteland/${owner}/${repo}`;

  return (
    <nav
      aria-label="Wasteland sections"
      className="flex items-center gap-1 border-b border-white/[0.06] px-4"
    >
      {TABS.map(tab => {
        const href = tab.segment ? `${base}/${tab.segment}` : base;
        const active = isActive(pathname, base, tab.segment);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.segment || 'upstream'}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group relative inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors',
              active ? 'text-white/90' : 'text-white/40 hover:text-white/70'
            )}
          >
            <Icon className="size-3.5" />
            {tab.label}
            <span
              aria-hidden
              className={cn(
                'absolute inset-x-2 -bottom-px h-px transition-colors',
                active ? 'bg-primary' : 'bg-transparent group-hover:bg-white/10'
              )}
            />
          </Link>
        );
      })}
    </nav>
  );
}

function isActive(pathname: string | null, base: string, segment: TabDef['segment']): boolean {
  if (!pathname) return false;
  if (!segment) {
    return pathname === base;
  }
  const target = `${base}/${segment}`;
  return pathname === target || pathname.startsWith(`${target}/`);
}
