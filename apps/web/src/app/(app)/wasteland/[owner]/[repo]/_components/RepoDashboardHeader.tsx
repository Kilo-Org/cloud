'use client';

import { usePathname } from 'next/navigation';
import { WastelandBetaBadge } from '@/components/wasteland/WastelandBetaBadge';
import { SyncForkButton } from '@/components/wasteland/SyncForkButton';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useWastelandPageHeader } from '@/app/(app)/wasteland/by-id/[wastelandId]/WastelandPageHeaderContext';
import { useWastelandRepo } from './WastelandRepoContext';
import { RepoNavTabs } from './RepoNavTabs';

type RepoDashboardHeaderProps = {
  owner: string;
  repo: string;
};

/**
 * Top of the per-wasteland shell. Renders the `<owner>/<repo>` mono
 * title, the per-page header section (via the existing
 * `WastelandPageHeader` context), the persistent fork-sync CTA, and
 * the section nav tabs.
 *
 * Pages contribute their own title/count/actions via
 * `useSetWastelandPageHeader` — same hook the legacy `[wastelandId]/`
 * tree uses, so the rendering pattern is shared.
 */
export function RepoDashboardHeader({ owner, repo }: RepoDashboardHeaderProps) {
  const pathname = usePathname();
  const pageHeader = useWastelandPageHeader();
  const repoIdentity = useWastelandRepo();
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
          <WastelandBetaBadge />
          {subtitle && <p className="text-xs text-white/35">{subtitle}</p>}
        </div>

        {/* Page-specific section — title + count + CTAs. Takes the
            available width so its inline actions sit left-of the
            persistent CTAs. */}
        {pageHeader?.actions && (
          <div className="flex flex-1 items-center justify-end gap-2 pl-3">
            <div className="flex items-center gap-2">{pageHeader.actions}</div>
          </div>
        )}

        {/* Persistent CTAs that apply to every owner/repo sub-page.
            When no page header is mounted, push these to the right. */}
        <div
          className={
            pageHeader?.actions ? 'flex items-center gap-2' : 'ml-auto flex items-center gap-2'
          }
        >
          <SyncForkButton wastelandId={repoIdentity.wastelandId} />
        </div>
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
