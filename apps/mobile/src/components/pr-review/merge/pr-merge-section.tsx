// S8 merge section. The orchestrator mounts this at the
// `{/* S8 merge section mounts here */}` slot inside `PrReviewOverview`.
// It owns:
//   - the bounded mergeability-polling effect (~3s × 10 → ~30s)
//   - the terminal / blocked / mergeable / auto-merge branching
//   - the open-sheet affordance (the orchestrator wires the route)
//
// The sheet content lives in `pr-merge-sheet.tsx`; the rendering
// sub-components live in `pr-merge-section-parts.tsx` to keep this file
// under the repo's 300-line limit.

import { type Href, useRouter } from 'expo-router';
import { GitMerge } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  type AllowedMergeMethod,
  defaultMergeMethodFor,
  getMergeabilityStatus,
  getMergeBlockedReasons,
  type PrMergeMethod,
  type PrOverviewDto,
} from '@/lib/pr-review/merge/merge-blocked-reasons';
import {
  useDisableAutoMergeMutation,
  useUpdateBranchMutation,
} from '@/lib/pr-review/merge/use-pr-merge-mutations';
import {
  AutoMergeEnabledBanner,
  BlockedPanel,
  MergeabilityCheckingRow,
  MergeabilityTimedOutRow,
  TerminalChip,
} from '@/components/pr-review/merge/pr-merge-section-parts';

type PrMergeSectionProps = Readonly<{
  owner: string;
  repo: string;
  overview: PrOverviewDto;
  /** Overview query refetch; used for both bounded polling and post-mutation refresh. */
  onRefetch: () => Promise<void>;
  isRefetching: boolean;
}>;

const MERGEABILITY_POLL_INTERVAL_MS = 3000;
const MERGEABILITY_POLL_MAX_TICKS = 10;

// Consume a rejecting promise from a timer/event handler. The mutation hooks
// surface failures via their `onError` toast and the query surfaces its own
// error state, so we only need to prevent an unhandled promise rejection here.
function ignoreRejection(promise: Promise<unknown>): void {
  void (async () => {
    try {
      await promise;
    } catch {
      /* handled by the hook's onError toast / query error state */
    }
  })();
}

function mergeSheetHref(args: {
  owner: string;
  repo: string;
  number: number;
  mode: 'merge' | 'enable-auto-merge';
  method: PrMergeMethod;
}): Href {
  const href: Href = {
    pathname: '/(app)/pr-review/[owner]/[repo]/[number]/merge',
    params: {
      owner: args.owner,
      repo: args.repo,
      number: String(args.number),
      mode: args.mode,
      method: args.method,
    },
  };
  return href;
}

export function PrMergeSection({
  owner,
  repo,
  overview,
  onRefetch,
  isRefetching,
}: PrMergeSectionProps) {
  const router = useRouter();
  const colors = useThemeColors();
  const status = getMergeabilityStatus(overview);
  const reasons = useMemo(
    () =>
      getMergeBlockedReasons({
        state: overview.state,
        draft: overview.draft,
        mergeable: overview.mergeable,
        mergeableState: overview.mergeableState,
        reviewDecision: overview.reviewDecision,
        allowUpdateBranch: overview.repo.allowUpdateBranch,
      }),
    [overview]
  );

  // Bounded polling for the brief window after GitHub queues a
  // mergeability re-check. Poll on a fixed interval up to N ticks, then
  // surface a retryable row. The timer is cleared on unmount AND on
  // every status transition away from 'unknown'.
  const tickRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [hasTimedOut, setHasTimedOut] = useState(false);

  useEffect(() => {
    if (status !== 'unknown') {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      tickRef.current = 0;
      setHasTimedOut(false);
      return;
    }
    if (intervalRef.current) {
      return;
    }
    tickRef.current = 0;
    setHasTimedOut(false);
    intervalRef.current = setInterval(() => {
      tickRef.current += 1;
      if (tickRef.current >= MERGEABILITY_POLL_MAX_TICKS) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        setHasTimedOut(true);
        return;
      }
      ignoreRejection(onRefetch());
    }, MERGEABILITY_POLL_INTERVAL_MS);
  }, [status, onRefetch]);

  useEffect(
    () => () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    },
    []
  );

  const prRef = useMemo(
    () => ({ owner, repo, number: overview.number }),
    [owner, repo, overview.number]
  );
  const updateBranch = useUpdateBranchMutation(prRef);
  const disableAutoMerge = useDisableAutoMergeMutation(prRef);

  // Terminal state.
  if (status === 'terminal') {
    return <TerminalChip state={overview.state} />;
  }

  // Unknown mergeability — poll until it resolves or the timer expires.
  if (status === 'unknown') {
    if (hasTimedOut) {
      return (
        <MergeabilityTimedOutRow
          onRefresh={() => {
            ignoreRejection(onRefetch());
          }}
          isRefreshing={isRefetching}
        />
      );
    }
    return <MergeabilityCheckingRow />;
  }

  // Auto-merge active.
  if (overview.autoMerge) {
    return (
      <View className="gap-3">
        <AutoMergeEnabledBanner
          method={overview.autoMerge.method}
          onDisable={() => {
            ignoreRejection(
              disableAutoMerge.mutateAsync({
                owner,
                repo,
                number: overview.number,
                prNodeId: overview.prNodeId,
              })
            );
          }}
          isDisabling={disableAutoMerge.isPending}
        />
        {status === 'mergeable' ? (
          <Button
            onPress={() => {
              router.push(
                mergeSheetHref({
                  owner,
                  repo,
                  number: overview.number,
                  mode: 'merge',
                  method: 'merge',
                })
              );
            }}
            accessibilityLabel="Merge now"
          >
            <View className="flex-row items-center gap-2">
              <GitMerge size={14} color={colors.primaryForeground} />
              <Text>Merge now</Text>
            </View>
          </Button>
        ) : null}
      </View>
    );
  }

  // Blocked.
  if (status === 'blocked') {
    return (
      <View className="gap-3">
        <BlockedPanel
          reasons={reasons}
          allowUpdateBranch={overview.repo.allowUpdateBranch}
          isUpdatePending={updateBranch.isPending}
          onUpdateBranch={() => {
            ignoreRejection(
              updateBranch.mutateAsync({
                owner,
                repo,
                number: overview.number,
                expectedHeadSha: overview.headSha,
              })
            );
          }}
        />
        {overview.repo.allowAutoMerge ? (
          <Button
            variant="outline"
            onPress={() => {
              const method: AllowedMergeMethod = defaultMergeMethodFor(overview.repo);
              const prMethod: PrMergeMethod = method;
              router.push(
                mergeSheetHref({
                  owner,
                  repo,
                  number: overview.number,
                  mode: 'enable-auto-merge',
                  method: prMethod,
                })
              );
            }}
            accessibilityLabel="Enable auto-merge"
          >
            <Text>Enable auto-merge</Text>
          </Button>
        ) : null}
      </View>
    );
  }

  // Mergeable — single "Merge" CTA.
  return (
    <View className="gap-2">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        Merge
      </Text>
      <Button
        onPress={() => {
          const m: PrMergeMethod = defaultMergeMethodFor(overview.repo);
          router.push(
            mergeSheetHref({ owner, repo, number: overview.number, mode: 'merge', method: m })
          );
        }}
        accessibilityLabel="Merge pull request"
      >
        <View className="flex-row items-center gap-2">
          <GitMerge size={14} color={colors.primaryForeground} />
          <Text>Merge</Text>
        </View>
      </Button>
    </View>
  );
}
