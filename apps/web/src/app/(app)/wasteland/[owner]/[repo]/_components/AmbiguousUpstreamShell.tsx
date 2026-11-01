'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ArrowRight, Layers } from 'lucide-react';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { pathWithSelection } from '@/lib/wasteland/repo-links';

type AmbiguousCandidate = {
  wastelandId: string;
  name: string;
};

type AmbiguousUpstreamShellProps = {
  owner: string;
  repo: string;
  candidates: AmbiguousCandidate[];
};

/**
 * Rendered when `wasteland.resolveOwnerRepo` reports that several
 * wastelands this user can reach point at the same `<owner>/<repo>`
 * upstream — for example a shared upstream, or a user who registered
 * two wastelands for one slug.
 *
 * The resolver answers with the candidates the caller can reach, so the
 * address alone does not name a single wasteland. Instead of showing a
 * dashboard for one of them, we list every candidate; each entry links
 * to the section the caller is on (`path`) with `wastelandId` added and
 * the rest of the query kept, so the choice does not drop `wantedId` on
 * the fork view or a filter on a nested list. The parent shell turns that
 * into the chosen wasteland's view of the same section.
 */
export function AmbiguousUpstreamShell({ owner, repo, candidates }: AmbiguousUpstreamShellProps) {
  const path = usePathname();
  const query = useSearchParams().toString();

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-3">
        <SidebarTrigger className="-ml-1" />
        <h1 className="font-mono text-base font-medium text-white/90">
          <span className="text-white/55">{owner}</span>
          <span className="text-white/30">/</span>
          <span>{repo}</span>
        </h1>
      </header>

      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-md space-y-6 rounded-xl border border-white/10 bg-white/[0.02] p-6">
          <div className="space-y-1.5">
            <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-white/90">
              <Layers className="size-4 text-white/55" />
              Several wastelands use this upstream
            </h2>
            <p className="text-sm text-white/55">
              More than one wasteland you can access points at{' '}
              <span className="font-mono text-white/75">
                {owner}/{repo}
              </span>
              . Pick the one you want to open.
            </p>
          </div>

          <ul className="flex flex-col gap-2">
            {candidates.map(candidate => (
              <li key={candidate.wastelandId}>
                <Link
                  href={pathWithSelection(path, query, candidate.wastelandId)}
                  className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm text-white/80 transition-colors hover:border-white/20 hover:bg-white/[0.05] hover:text-white"
                >
                  <span className="truncate font-medium">{candidate.name}</span>
                  <ArrowRight className="size-4 shrink-0 text-white/40" />
                </Link>
              </li>
            ))}
          </ul>

          <p className="text-xs text-white/35">
            Opening one keeps this address and adds the choice to it, so the link can be shared.
            Detach an upstream from a wasteland in its settings if it no longer belongs here.
          </p>
        </div>
      </div>
    </div>
  );
}
