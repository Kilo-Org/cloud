import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { Ban, ShieldOff } from '@/components/ui/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { FindingAnalysisPanel } from '@/components/security-agent/finding-analysis-panel';
import { FindingDetailsPanel } from '@/components/security-agent/finding-details-panel';
import { FindingRemediationPanel } from '@/components/security-agent/finding-remediation-panel';
import { SecurityCommandRetryCard } from '@/components/security-agent/security-command-retry-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView, useTabBarBottomPadding } from '@/components/tab-screen';
import {
  useSecurityAgentCapability,
  useTrackSecurityAgentInteraction,
} from '@/lib/hooks/use-security-agent';
import { useSecurityDismissDraft } from '@/lib/hooks/use-security-dismiss-draft';
import { useSecurityAnalysis, useSecurityFinding } from '@/lib/hooks/use-security-findings';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { findingDetailBackTarget, findingDetailHasLocalHistory } from '@/lib/finding-detail-back';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { cn } from '@/lib/utils';

type FindingTab = 'details' | 'analysis' | 'remediation';

const TABS: { key: FindingTab; label: string }[] = [
  { key: 'details', label: 'Details' },
  { key: 'analysis', label: 'Analysis' },
  { key: 'remediation', label: 'Remediation' },
];

// Server-verified security_agent_ui_interaction enum values (schemas.ts:28-31)
// — one per tab, matching web's handleTabChange in FindingDetailDialog.tsx.
const TAB_INTERACTIONS = {
  details: 'finding_triage_viewed',
  analysis: 'finding_analysis_viewed',
  remediation: 'finding_remediation_viewed',
} satisfies Record<
  FindingTab,
  'finding_triage_viewed' | 'finding_analysis_viewed' | 'finding_remediation_viewed'
>;

type FindingDetailScreenProps = {
  scope: string;
  findingId: string;
};

export function FindingDetailScreen({ scope, findingId }: Readonly<FindingDetailScreenProps>) {
  const router = useRouter();
  const navigation = useNavigation();
  const colors = useThemeColors();
  const paddingBottom = useTabBarBottomPadding();
  const [tab, setTab] = useState<FindingTab>('details');
  const findingQuery = useSecurityFinding(scope, findingId);
  const analysisQuery = useSecurityAnalysis(scope, findingId);
  const trackInteraction = useTrackSecurityAgentInteraction(scope);
  const capability = useSecurityAgentCapability(scope);
  const dismissDraft = useSecurityDismissDraft(scope, findingId);
  const { refresh: refreshDismissDraft } = dismissDraft;

  // The detail screen stays mounted while the dismiss sheet is open, so
  // re-read the draft on focus: a fresh failure must show the retry card and
  // an accepted dismissal must drop it.
  useFocusEffect(
    useCallback(() => {
      refreshDismissDraft();
    }, [refreshDismissDraft])
  );

  // The back control always renders. With local history it pops normally
  // (findings-list -> finding returns to the list). A push/deep-link open has
  // no local history, so `router.back()` is a no-op and back replaces the
  // whole profile-tab subtree with its root instead. The signal is the nested
  // Stack's own state index, not `router.canGoBack()` (which is recursive and
  // also reports parent history).
  const handleBack = () => {
    const target = findingDetailBackTarget(findingDetailHasLocalHistory(navigation.getState()));
    if (target.kind === 'pop') {
      router.back();
    } else {
      router.replace(target.href);
    }
  };

  // Ref indirection keeps the tracking effects independent of the mutation
  // object's identity (a new object every render), so they only re-fire on
  // an actual findingId/tab change, not on every re-render.
  const trackRef = useRef(trackInteraction.mutate);
  trackRef.current = trackInteraction.mutate;

  const findingLoaded = Boolean(findingQuery.data);
  const trackedFindingIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!findingLoaded || trackedFindingIdRef.current === findingId) {
      return;
    }
    trackedFindingIdRef.current = findingId;
    trackRef.current({ interaction: 'finding_detail_opened' });
  }, [findingLoaded, findingId]);

  useEffect(() => {
    if (!findingLoaded) {
      return;
    }
    trackRef.current({ interaction: TAB_INTERACTIONS[tab] });
  }, [findingLoaded, findingId, tab]);

  const errorCode = findingQuery.error?.data?.code;
  const notFound = findingQuery.isError && (errorCode === 'NOT_FOUND' || errorCode === 'FORBIDDEN');

  if (notFound) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Finding" showBackButton onBack={handleBack} />
        <View className="flex-1" style={{ paddingBottom }}>
          <EmptyState
            icon={ShieldOff}
            className="flex-1"
            title="Finding not found"
            description="This finding may have been removed, or you no longer have access to it."
          />
        </View>
      </View>
    );
  }

  if (findingQuery.isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Finding" showBackButton onBack={handleBack} />
        <View className="flex-1 items-center justify-center" style={{ paddingBottom }}>
          <QueryError
            message="Could not load this finding"
            onRetry={() => void findingQuery.refetch()}
          />
        </View>
      </View>
    );
  }

  if (findingQuery.isLoading || !findingQuery.data) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Finding" showBackButton onBack={handleBack} />
        <View className="flex-1 gap-3 px-6 pt-4">
          <Skeleton className="h-6 w-2/3 rounded" />
          <Skeleton className="h-4 w-1/3 rounded" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </View>
      </View>
    );
  }

  const finding = findingQuery.data;
  const canDismiss = finding.status === 'open' && capability.canManage;

  // A pre-accept dismissal failure (no command id) leaves a durable draft; the
  // retry card restores it until the user retries or discards it.
  const dismissFailure = dismissDraft.draft?.lastError ?? null;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Finding"
        eyebrow={finding.repo_full_name}
        showBackButton
        onBack={handleBack}
        headerRight={
          canDismiss ? (
            <Pressable
              onPress={() => {
                router.push(getSecurityAgentPath(scope, `dismiss/${findingId}`));
              }}
              accessibilityRole="button"
              accessibilityLabel="Dismiss finding"
              className="size-11 items-center justify-center active:opacity-70"
            >
              <Ban size={20} color={colors.mutedForeground} />
            </Pressable>
          ) : undefined
        }
      />
      {dismissFailure !== null && dismissDraft.draft ? (
        <View className="px-6 pb-2">
          <SecurityCommandRetryCard
            lastError={dismissFailure}
            retryable={dismissDraft.draft.retryable === true}
            onRetry={() => {
              router.push(getSecurityAgentPath(scope, `dismiss/${findingId}`));
            }}
            onDiscard={() => {
              dismissDraft.clear();
            }}
          />
        </View>
      ) : null}
      <View className="flex-row gap-2 px-6 pb-2 pt-1">
        {TABS.map(({ key, label }) => {
          const selected = tab === key;
          return (
            <Pressable
              key={key}
              className={cn(
                'min-h-11 flex-1 items-center justify-center rounded-lg py-2 active:opacity-80',
                selected ? 'bg-primary' : 'bg-secondary'
              )}
              onPress={() => {
                setTab(key);
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  selected ? 'text-primary-foreground' : 'text-foreground'
                )}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="gap-4 pt-2">
        {tab === 'details' && <FindingDetailsPanel finding={finding} scope={scope} />}
        {tab === 'analysis' && (
          <FindingAnalysisPanel
            scope={scope}
            findingId={findingId}
            analysis={analysisQuery.data}
            isLoading={analysisQuery.isLoading}
            isError={analysisQuery.isError}
            onRetry={() => void analysisQuery.refetch()}
          />
        )}
        {tab === 'remediation' && (
          <FindingRemediationPanel
            scope={scope}
            findingId={findingId}
            analysis={analysisQuery.data}
            isLoading={analysisQuery.isLoading}
            isError={analysisQuery.isError}
            onRetry={() => void analysisQuery.refetch()}
          />
        )}
      </TabScreenScrollView>
    </View>
  );
}
