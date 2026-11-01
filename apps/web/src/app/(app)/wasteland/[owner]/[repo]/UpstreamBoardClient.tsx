'use client';

import { useSearchParams } from 'next/navigation';
import { WantedBoardClient } from '@/app/(app)/wasteland/by-id/[wastelandId]/wanted/WantedBoardClient';
import { repoPathWithQuery } from '@/lib/wasteland/repo-links';
import { useWastelandRepo } from './_components/WastelandRepoContext';

/**
 * The default landing page for /wasteland/[owner]/[repo]. Shows the
 * upstream wanted board in read-only mode with a one-row hand-off
 * affordance ("Take to my workshop") that deep-links into the fork view.
 *
 * Reads the resolved `wastelandId` out of `WastelandRepoContext`, which
 * the layout populates after `wasteland.resolveOwnerRepo`. The current
 * query string (for example the `wastelandId` of a selected wasteland)
 * is part of the base path, so the hand-off keeps it.
 */
export function UpstreamBoardClient() {
  const repo = useWastelandRepo();
  const searchParams = useSearchParams();
  const basePath = repoPathWithQuery(repo.owner, repo.repo, searchParams.toString());

  return (
    <div className="flex h-full flex-col">
      {/* Upstream context strip — establishes that this view is the
          shared truth, not the user's personal workspace. Per the plan
          copy. Sentence case + Inter, mono only on the slug. */}
      <div className="flex flex-col gap-1 border-b border-white/[0.06] bg-white/[0.015] px-6 py-3">
        <p className="text-sm font-medium text-white/85">
          Upstream{' '}
          <span className="font-mono text-white/65">
            {repo.owner}/{repo.repo}
          </span>
        </p>
        <p className="text-xs text-white/45">
          The shared truth — what everyone with access to this wasteland sees.
        </p>
      </div>

      <div className="flex-1 overflow-hidden">
        <WantedBoardClient
          wastelandId={repo.wastelandId}
          mode="upstream"
          workshopBasePath={basePath}
          headerTitle="Upstream"
        />
      </div>
    </div>
  );
}
