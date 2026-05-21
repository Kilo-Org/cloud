'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import { PageContainer } from '@/components/layouts/PageContainer';
import { Button } from '@/components/Button';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { GastownBackdrop } from '@/components/gastown/GastownBackdrop';
import { Plus, Factory, Trash2, Skull } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import {
  WastelandCard,
  WastelandListSkeleton,
} from '@/app/(app)/wasteland/_components/WastelandListComponents';
import { parseDolthubUpstream } from '@/lib/wasteland/upstream';

/**
 * Wastelands live on the personal gastown overview rather than as a
 * top-level nav item. The mental model the product wants to surface is
 * "wasteland is a thing your town connects to," so the list of
 * wastelands sits underneath the towns list on this page. Org
 * gastown overviews deliberately omit this section — wastelands are
 * personal-scoped only.
 */
function linkForWasteland(wasteland: { wasteland_id: string; dolthub_upstream: string | null }) {
  const upstream = parseDolthubUpstream(wasteland.dolthub_upstream);
  if (upstream) return `/wasteland/${upstream.owner}/${upstream.repo}`;
  // Fall back to the id-based redirect page when the wasteland has no
  // parseable upstream — that page resolves the upstream server-side and
  // forwards to /wasteland/{owner}/{repo} when it can. The bare
  // `/wasteland/{id}` URL would otherwise hit the [owner]/[repo] route
  // with the id as the owner segment, which 404s.
  return `/wasteland/by-id/${wasteland.wasteland_id}`;
}

export function TownListPageClient() {
  const router = useRouter();
  const trpc = useGastownTRPC();
  const wastelandTrpc = useWastelandTRPC();

  const queryClient = useQueryClient();
  const townsQuery = useQuery(trpc.gastown.listTowns.queryOptions());
  const wastelandsQuery = useQuery({
    ...wastelandTrpc.wasteland.listWastelands.queryOptions({}),
    refetchInterval: 30_000,
  });
  const didAutoRedirect = useRef(false);

  // Auto-redirect new users with no towns to the onboarding wizard (once per page load)
  useEffect(() => {
    if (!didAutoRedirect.current && townsQuery.data && townsQuery.data.length === 0) {
      didAutoRedirect.current = true;
      router.replace('/gastown/onboarding');
    }
  }, [townsQuery.data, router]);

  const deleteTown = useMutation(
    trpc.gastown.deleteTown.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listTowns.queryKey() });
        toast.success('Town deleted');
      },
      onError: err => {
        toast.error(err.message);
      },
    })
  );

  return (
    <PageContainer>
      <GastownBackdrop contentClassName="p-5 md:p-7">
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <SetPageTitle title="Gas Town" />
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/60">
                A chat-first orchestration console for towns, rigs, beads, and agents. Built for
                radical transparency: every object is clickable; every outcome is attributable.
              </p>
            </div>

            <Button
              variant="primary"
              size="md"
              onClick={() => router.push('/gastown/onboarding')}
              className="gap-2 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
            >
              <Plus className="size-5" />
              New Town
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Towns</div>
              <div className="mt-0.5 text-lg font-semibold text-white/85">
                {townsQuery.isLoading ? '…' : (townsQuery.data ?? []).length}
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Mode</div>
              <div className="mt-1 inline-flex items-center gap-2 text-sm text-white/70">
                <span className="size-2 rounded-full bg-emerald-400" />
                Live
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Core</div>
              <div className="mt-1 text-sm text-white/70">MEOW · GUPP · NDI</div>
            </div>
            <div className="hidden rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 sm:block">
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Promise</div>
              <div className="mt-1 text-sm text-white/70">Discover, don’t track</div>
            </div>
          </div>
        </div>
      </GastownBackdrop>

      {townsQuery.isLoading && (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="border-white/10 bg-white/[0.03]">
              <CardContent className="p-4">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="mt-2 h-4 w-32" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {townsQuery.data && townsQuery.data.length === 0 && (
        <GastownBackdrop>
          <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
            <Factory className="mb-4 size-12 text-white/40" />
            <h3 className="text-lg font-semibold text-white/85">No towns yet</h3>
            <p className="mt-2 max-w-md text-sm text-white/55">
              Create a town to spawn the Mayor and begin delegating work. Your town becomes the
              command center for every rig.
            </p>
            <Button
              variant="primary"
              size="md"
              onClick={() => router.push('/gastown/onboarding')}
              className="mt-5 gap-2 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
            >
              <Plus className="size-5" />
              Create your first town
            </Button>
          </div>
        </GastownBackdrop>
      )}

      {townsQuery.data && townsQuery.data.length > 0 && (
        <div className="space-y-3">
          {townsQuery.data.map(town => (
            <Card
              key={town.id}
              className="cursor-pointer border-white/10 bg-white/[0.03] transition-[border-color,background-color,transform] hover:bg-white/[0.05]"
              onClick={() => void router.push(`/gastown/${town.id}`)}
            >
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <h3 className="text-lg font-medium text-white/90">{town.name}</h3>
                  <p className="text-sm text-white/50">
                    Created {formatDistanceToNow(new Date(town.created_at), { addSuffix: true })}
                  </p>
                </div>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    if (
                      confirm(`Delete town "${town.name}"? This will also delete all its rigs.`)
                    ) {
                      deleteTown.mutate({ townId: town.id });
                    }
                  }}
                  className="rounded p-1.5 text-white/35 transition-colors hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 className="size-4" />
                </button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── Wastelands section ─────────────────────────────────────────
          Sits underneath the towns list to reinforce "your town connects
          to a wasteland." Identical visual rhythm to the towns list:
          header bar with a `New Wasteland` action, skeleton during load,
          empty-state copy that mentions the relationship to towns. */}
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-white/85">Wastelands</h2>
            <p className="mt-0.5 text-xs text-white/45">
              Hosted bounty boards your towns can connect to. Backed by DoltHub.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => router.push('/wasteland/new')}
            className="shrink-0 gap-1.5 border-white/10 bg-white/[0.04] text-white/80 hover:bg-white/[0.08]"
          >
            <Plus className="size-3.5" />
            New Wasteland
          </Button>
        </div>

        {wastelandsQuery.isLoading && <WastelandListSkeleton />}

        {wastelandsQuery.data && wastelandsQuery.data.length === 0 && (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-5 py-6">
            <div className="flex flex-col items-center gap-3 text-center">
              <Skull className="size-8 text-white/35" />
              <div>
                <p className="text-sm font-medium text-white/80">No wastelands yet</p>
                <p className="mt-1 max-w-md text-xs text-white/50">
                  Create one to start posting wanted items, then connect a town to it from the
                  town&apos;s settings.
                </p>
              </div>
            </div>
          </div>
        )}

        {wastelandsQuery.data && wastelandsQuery.data.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {wastelandsQuery.data.map(wasteland => (
              <WastelandCard
                key={wasteland.wasteland_id}
                wasteland={wasteland}
                onClick={() => router.push(linkForWasteland(wasteland))}
              />
            ))}
          </div>
        )}
      </section>
    </PageContainer>
  );
}
