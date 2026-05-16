'use client';

import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Globe, Lock } from 'lucide-react';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import { Badge } from '@/components/ui/badge';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useWastelandPageHeader } from '@/app/(app)/wasteland/by-id/[wastelandId]/WastelandPageHeaderContext';
import { useOptionalWastelandRepo } from './WastelandRepoContext';
import { RepoNavTabs } from './RepoNavTabs';

type RepoDashboardHeaderProps = {
  owner: string;
  repo: string;
};

/**
 * Top of the per-wasteland shell. Renders the `<owner>/<repo>` mono
 * title, an optional visibility badge, the per-page header section (via
 * the existing `WastelandPageHeader` context), and the section nav tabs.
 *
 * Pages contribute their own title/count/actions via
 * `useSetWastelandPageHeader` — same hook the legacy `[wastelandId]/`
 * tree uses, so the rendering pattern is shared.
 */
export function RepoDashboardHeader({ owner, repo }: RepoDashboardHeaderProps) {
  const repoIdentity = useOptionalWastelandRepo();
  const trpc = useWastelandTRPC();
  const pathname = usePathname();

  // Visibility badge needs a `wastelandId`. Without one (the not-connected
  // shell) we just skip the badge — the title alone reads fine.
  const wastelandQuery = useQuery({
    ...trpc.wasteland.getWasteland.queryOptions(
      { wastelandId: repoIdentity?.wastelandId ?? '' },
      { enabled: !!repoIdentity?.wastelandId }
    ),
  });
  const visibility = wastelandQuery.data?.visibility;

  const pageHeader = useWastelandPageHeader();
  const subtitle = subtitleForPath(pathname, owner, repo);

  return (
    <div className="border-b border-white/[0.06]">
      <div className="flex items-center gap-3 px-4 py-3">
        <SidebarTrigger className="-ml-1" />

        <div className="flex min-w-0 items-baseline gap-2">
          <h1
            className="truncate font-mono text-base font-medium text-white/90"
            // Mono face per design tokens — repo identifiers read as code.
            title={`${owner}/${repo}`}
          >
            <span className="text-white/55">{owner}</span>
            <span className="text-white/30">/</span>
            <span>{repo}</span>
          </h1>
          {visibility && (
            <Badge variant="outline" className="gap-1 border-white/10 text-white/50">
              {visibility === 'public' ? <Globe className="size-3" /> : <Lock className="size-3" />}
              {visibility}
            </Badge>
          )}
          {subtitle && <p className="text-xs text-white/35">{subtitle}</p>}
        </div>

        {/* Page-specific section — title + count + CTAs, right-aligned via flex-1. */}
        {pageHeader && (
          <div className="flex flex-1 items-center justify-end gap-2 pl-3">
            {pageHeader.actions && (
              <div className="flex items-center gap-2">{pageHeader.actions}</div>
            )}
          </div>
        )}
      </div>

      <RepoNavTabs owner={owner} repo={repo} />
    </div>
  );
}

function subtitleForPath(pathname: string | null, owner: string, repo: string): string | null {
  if (!pathname) return null;
  const base = `/wasteland/${owner}/${repo}`;
  if (pathname === base) return 'Upstream — read-only';
  if (pathname === `${base}/fork` || pathname.startsWith(`${base}/fork/`)) return 'Your fork';
  if (pathname === `${base}/pulls` || pathname.startsWith(`${base}/pulls/`)) return 'Pull requests';
  if (pathname === `${base}/settings` || pathname.startsWith(`${base}/settings/`))
    return 'Settings';
  return null;
}
