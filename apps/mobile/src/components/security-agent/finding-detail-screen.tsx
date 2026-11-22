import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { Ban } from '@/components/ui/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ScreenHeader } from '@/components/screen-header';
import { FindingAnalysisPanel } from '@/components/security-agent/finding-analysis-panel';
import { FindingDetailsPanel } from '@/components/security-agent/finding-details-panel';
import { FindingRemediationPanel } from '@/components/security-agent/finding-remediation-panel';
import {
  type FindingDetailUndelivered,
  FindingDetailUndeliveredBody,
} from '@/components/security-agent/finding-detail-undelivered-body';
import { PanelErrorBoundary } from '@/components/security-agent/panel-error-boundary';
import { SecurityCommandRetryCard } from '@/components/security-agent/security-command-retry-card';
import { SettingsRecoveryStatus } from '@/components/security-agent/settings-recovery-status';
import { IconButton } from '@/components/ui/icon-button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { TabScreenScrollView } from '@/components/tab-screen';
import {
  useSecurityAgentCapability,
  useTrackSecurityAgentInteraction,
} from '@/lib/hooks/use-security-agent';
import {
  securityDismissFailureCopy,
  useSecurityDismissDraft,
} from '@/lib/hooks/use-security-dismiss-draft';
import {
  useRetrySecurityFinding,
  useSecurityAnalysis,
  useSecurityFinding,
} from '@/lib/hooks/use-security-findings';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { isReadPausedBeforeData } from '@/lib/query/read-failure-variant';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { findingDetailBackTarget, findingDetailHasLocalHistory } from '@/lib/finding-detail-back';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { isSecurityTrialRefusalCopyKey } from '@/lib/security-agent-ledger';
import { useBillingAction, useCanManageBilling } from '@/lib/trial-refusal';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useSideInsetStyle } from '@/lib/screen-insets';

type FindingTab = 'details' | 'analysis' | 'remediation';

const TABS = [
  { key: 'details', labelKey: 'common.details' },
  { key: 'analysis', labelKey: 'securityAgent.findingDetail.tabAnalysis' },
  { key: 'remediation', labelKey: 'securityAgent.findingDetail.tabRemediation' },
] as const satisfies readonly { key: FindingTab; labelKey: string }[];

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
  const pushOnce = useSinglePushRoute();
  const navigation = useNavigation();
  const colors = useThemeColors();
  const sideInsetStyle = useSideInsetStyle();
  const { t } = useTranslation();
  const [tab, setTab] = useState<FindingTab>('details');
  const findingQuery = useSecurityFinding(scope, findingId);
  // The analysis query polls while a run is active, and only the analysis and
  // remediation panels read it — the details tab never does.
  const analysisActive = tab === 'analysis' || tab === 'remediation';
  const analysisQuery = useSecurityAnalysis(scope, findingId, analysisActive);
  const connectivity = useCommittedConnectivityStatus();
  const findingRetry = useRetrySecurityFinding(scope, findingId);
  // Bumped once the boundary's recovery refetch settles, so the boundary
  // remounts with clean state over the recovered payload. Bumping it in the
  // same tick would mount the fresh boundary against the still-cached
  // crashing payload: it would throw again and pin the fallback through the
  // refetch.
  const [panelRetryCount, setPanelRetryCount] = useState(0);
  const retryAnalysisPanel = useCallback(() => {
    const settle = async () => {
      await analysisQuery.refetch();
      setPanelRetryCount(count => count + 1);
    };
    void settle();
  }, [analysisQuery]);
  const trackInteraction = useTrackSecurityAgentInteraction(scope);
  const capability = useSecurityAgentCapability(scope);
  const dismissDraft = useSecurityDismissDraft(scope, findingId);
  const { refresh: refreshDismissDraft } = dismissDraft;
  // One role answer decides both the sentence a stored refusal paints and the
  // step under it: the draft records which refusal it was, not which reader saw
  // it, so `useCanManageBilling` is handed to the copy resolver while the step
  // comes from the same predicate inside `useBillingAction`. A draft written for
  // a member therefore reads the billing sentence with the step when a billing
  // role opens it, and the reverse keeps the ask-an-owner sentence with no step.
  const canManageBilling = useCanManageBilling(scope);
  const billingAction = useBillingAction(scope);

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
  // no local history, so `router.back()` is a no-op and back replaces itself
  // with the scope's findings list, a sibling route in the root stack. The
  // signal is the nested Stack's own state index, not `router.canGoBack()`
  // (which is recursive and also reports parent history).
  const handleBack = () => {
    const target = findingDetailBackTarget(
      findingDetailHasLocalHistory(navigation.getState()),
      scope
    );
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

  // React Query resets a failed query to pending when its retry starts, so a
  // condition on `isError` alone tears the failure surface down — and the
  // progress of the retry the user just asked for — for as long as the request
  // runs. Hold the surface for the retry of the same finding; another finding's
  // id never matches, so opening it starts clean. A not-found or forbidden
  // answer keeps its own state instead of retrying into a generic failure.
  const loadFailed = findingQuery.isError && !findingQuery.data && !notFound;
  const [failedFindingId, setFailedFindingId] = useState<string | null>(null);
  useEffect(() => {
    if (loadFailed) {
      setFailedFindingId(findingId);
    }
  }, [loadFailed, findingId]);
  const showLoadFailure = !findingQuery.data && (loadFailed || failedFindingId === findingId);

  // No payload on screen is one state, not four flags: a removed or refused
  // finding, a first read the online manager paused, a failed read the retry
  // surface holds, and a read still running. The paused face comes before the
  // failure hold: a deliberate retry that fails while the connection is still
  // down stamps that hold, and the plain `refetch` the failure face offers only
  // re-pauses the read — so the hold must not keep the paused face, whose retry
  // is the one that can run while the online manager is offline, off the screen.
  let undelivered: FindingDetailUndelivered | null = null;
  if (notFound) {
    undelivered = { kind: 'not-found' };
  } else if (isReadPausedBeforeData({ ...findingQuery, connectivity })) {
    undelivered = {
      kind: 'paused',
      isRetrying: findingRetry.isRetrying,
      onRetry: () => void findingRetry.retry(),
    };
  } else if (showLoadFailure) {
    undelivered = {
      kind: 'failed',
      isRetrying: findingQuery.isFetching,
      onRetry: () => void findingQuery.refetch(),
    };
  }
  // The loading frame keeps the header's placeholder bar while its read runs;
  // every other face above holds the line blank.
  const subtitleRunning = findingQuery.isFetching && !notFound;
  if (undelivered) {
    return (
      <FindingDetailUndeliveredBody
        state={undelivered}
        showSubtitlePlaceholder={subtitleRunning}
        onBack={handleBack}
      />
    );
  }
  const finding = findingQuery.data;
  if (!finding) {
    return (
      <FindingDetailUndeliveredBody
        state={{ kind: 'loading' }}
        showSubtitlePlaceholder={subtitleRunning}
        onBack={handleBack}
      />
    );
  }
  const canDismiss = finding.status === 'open' && capability.canManage;

  // A pre-accept dismissal failure (no command id) leaves a durable draft; the
  // retry card restores it until the user retries or discards it.
  const draft = dismissDraft.draft;
  // The segmented control's options: the three views under the labels the
  // catalogs already carry for them.
  const viewOptions = TABS.map(({ key, labelKey }) => ({ value: key, label: t(labelKey) }));

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('securityAgent.findingDetail.title')}
        subtitle={finding.repo_full_name}
        reserveSubtitle
        showBackButton
        onBack={handleBack}
        // The dismiss is one icon target, the shape every other header action
        // in the app takes (the dashboard's findings and settings, the
        // findings list's filter): a labelled button here outweighed the
        // title it sits beside.
        headerRightWidth={48}
        headerRight={
          canDismiss ? (
            <IconButton
              onPress={() => {
                pushOnce(getSecurityAgentPath(scope, `dismiss/${findingId}`));
              }}
              accessibilityLabel={t('securityAgent.dismiss.title')}
            >
              <Ban size={20} color={colors.foreground} />
            </IconButton>
          ) : undefined
        }
      />
      {/* The status rows and the view switch sit beside the side insets that
          the header and the panels' scroll views clear. */}
      <View style={sideInsetStyle}>
        {findingQuery.isError ? (
          <View className="px-4 pb-2">
            <SettingsRecoveryStatus
              message={t('securityAgent.dismiss.couldNotLoad')}
              isRetrying={findingQuery.isFetching}
              onRetry={() => void findingQuery.refetch()}
            />
          </View>
        ) : null}
        {draft?.lastError != null ? (
          <View className="px-4 pb-2">
            <SecurityCommandRetryCard
              lastError={securityDismissFailureCopy(draft, canManageBilling)}
              retryable={draft.retryable === true}
              action={isSecurityTrialRefusalCopyKey(draft.lastErrorKey) ? billingAction : undefined}
              onRetry={() => {
                pushOnce(getSecurityAgentPath(scope, `dismiss/${findingId}`));
              }}
              onDiscard={() => {
                dismissDraft.clear();
              }}
            />
          </View>
        ) : null}
        {/* The three views are the app's one view switch: the shared segmented
            control, which owns the track, the selected pill, the 48pt floor and
            the selection tick. Each view swaps the body below it, so the strip
            reads as tabs. Its accessible name is the screen's own, so a reader
            hears the finding's views, not an unnamed tab list. */}
        <View className="px-4 pb-2 pt-1">
          <SegmentedControl
            options={viewOptions}
            value={tab}
            semantics="tabs"
            accessibilityLabel={t('securityAgent.findingDetail.title')}
            onChange={setTab}
          />
        </View>
      </View>
      {tab === 'details' && (
        <TabScreenScrollView className="flex-1" contentContainerClassName={SCREEN_BODY_CLASS}>
          <FindingDetailsPanel finding={finding} scope={scope} />
        </TabScreenScrollView>
      )}
      {tab === 'analysis' && (
        <PanelErrorBoundary
          key={`analysis-${panelRetryCount}`}
          onRetry={retryAnalysisPanel}
          fallbackMessage={t('securityAgent.analysis.couldNotLoad')}
        >
          <FindingAnalysisPanel
            scope={scope}
            findingId={findingId}
            analysis={analysisQuery.data}
            isLoading={analysisQuery.isLoading}
            isError={analysisQuery.isError}
            isPending={analysisQuery.isPending}
            fetchStatus={analysisQuery.fetchStatus}
            connectivity={connectivity}
            onRetry={() => void analysisQuery.refetch()}
          />
        </PanelErrorBoundary>
      )}
      {tab === 'remediation' && (
        <PanelErrorBoundary
          key={`remediation-${panelRetryCount}`}
          onRetry={retryAnalysisPanel}
          fallbackMessage={t('securityAgent.remediation.couldNotLoad')}
        >
          <FindingRemediationPanel
            scope={scope}
            findingId={findingId}
            analysis={analysisQuery.data}
            isLoading={analysisQuery.isLoading}
            isError={analysisQuery.isError}
            isPending={analysisQuery.isPending}
            fetchStatus={analysisQuery.fetchStatus}
            connectivity={connectivity}
            onRetry={() => void analysisQuery.refetch()}
          />
        </PanelErrorBoundary>
      )}
    </View>
  );
}
