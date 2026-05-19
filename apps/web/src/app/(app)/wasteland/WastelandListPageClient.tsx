'use client';

import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import { PageContainer } from '@/components/layouts/PageContainer';
import { Button } from '@/components/Button';
import { SetPageTitle } from '@/components/SetPageTitle';
import { GastownBackdrop } from '@/components/gastown/GastownBackdrop';
import { WastelandBetaBadge } from '@/components/wasteland/WastelandBetaBadge';
import { Plus, Skull } from 'lucide-react';
import { WastelandCard, WastelandListSkeleton } from './_components/WastelandListComponents';
import { parseDolthubUpstream } from '@/lib/wasteland/upstream';

// Prefer the M2.2 owner/repo URL when the wasteland has an upstream; fall back
// to the legacy UUID URL (which the legacy page now redirects from when
// possible — see /wasteland/by-id/[wastelandId]/page.tsx).
function linkForWasteland(wasteland: { wasteland_id: string; dolthub_upstream: string | null }) {
  const upstream = parseDolthubUpstream(wasteland.dolthub_upstream);
  if (upstream) return `/wasteland/${upstream.owner}/${upstream.repo}`;
  return `/wasteland/${wasteland.wasteland_id}`;
}

export function WastelandListPageClient() {
  const router = useRouter();
  const trpc = useWastelandTRPC();

  const wastelandsQuery = useQuery({
    ...trpc.wasteland.listWastelands.queryOptions({}),
    refetchInterval: 30_000,
  });

  const wastelands = wastelandsQuery.data ?? [];

  return (
    <PageContainer>
      <GastownBackdrop contentClassName="p-5 md:p-7">
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <SetPageTitle title="Wastelands">
                <WastelandBetaBadge />
              </SetPageTitle>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/60">
                A hosted bounty board backed by DoltHub. Post wanted items, claim work, and track
                completions across your projects.
              </p>
            </div>

            <Button
              variant="primary"
              size="md"
              onClick={() => router.push('/wasteland/new')}
              className="gap-2 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
            >
              <Plus className="size-5" />
              New Wasteland
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Wastelands</div>
              <div className="mt-0.5 text-lg font-semibold text-white/85">
                {wastelandsQuery.isLoading ? '…' : wastelands.length}
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Backed by</div>
              <div className="mt-1 text-sm text-white/70">DoltHub</div>
            </div>
            <div className="hidden rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 sm:block">
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Scope</div>
              <div className="mt-1 text-sm text-white/70">Personal</div>
            </div>
          </div>
        </div>
      </GastownBackdrop>

      {wastelandsQuery.isLoading && <WastelandListSkeleton />}

      {wastelandsQuery.data && wastelands.length === 0 && (
        <GastownBackdrop>
          <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
            <Skull className="mb-4 size-12 text-white/40" />
            <h3 className="text-lg font-semibold text-white/85">No wastelands yet</h3>
            <p className="mt-2 max-w-md text-sm text-white/55">
              Create a wasteland to set up a hosted bounty board. Connect it to DoltHub to track
              wanted items, claims, and completions.
            </p>
            <Button
              variant="primary"
              size="md"
              onClick={() => router.push('/wasteland/new')}
              className="mt-5 gap-2 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
            >
              <Plus className="size-5" />
              Create your first wasteland
            </Button>
          </div>
        </GastownBackdrop>
      )}

      {wastelands.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {wastelands.map(wasteland => (
            <WastelandCard
              key={wasteland.wasteland_id}
              wasteland={wasteland}
              onClick={() => router.push(linkForWasteland(wasteland))}
            />
          ))}
        </div>
      )}
    </PageContainer>
  );
}
