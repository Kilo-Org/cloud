/* eslint-disable max-lines -- The context sheet composes the usage ring, token totals, and per-model cost rows. */
import { useQuery } from '@tanstack/react-query';
import { type Href } from 'expo-router';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { sessionResumeUrl } from '@kilocode/app-shared/universal-links';
import { type ResolvedSession, type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { SheetHeader } from '@/components/sheet-header';
import { Card } from '@/components/ui/card';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Bot, ChevronDown, ChevronUp, Copy, FileDiff, History } from '@/components/ui/icons';
import { KvRow } from '@/components/ui/kv-row';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber, formatPercent } from '@/lib/format';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { resolveRunningOnLabel } from '@/lib/instance-target-label';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type SessionContextInfo } from '@/lib/session-context-info';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { useTRPC } from '@/lib/trpc';

import { type SessionAutoApproveState } from './session-auto-approve';
import { SessionAutoApproveRow } from './session-auto-approve-row';
import { SessionComputeSection } from './session-compute-section';
import { formatSessionTotalCost } from './session-list-helpers';
import { isPermissionDeniedError } from '@/lib/trpc-error';
import {
  computeChargesMicrodollars,
  isCloudAgentSessionId,
  sessionTotalMicrodollars,
} from '@/lib/session-compute-total';
import { useSessionComputeCharges } from '@/lib/hooks/use-session-compute';
import { ContextUsageRing } from './context-usage-ring';
import { useOptionalSessionManager } from './session-manager-context';
import {
  type ContextTone,
  formatCost,
  getArcFraction,
  getContextSheetContent,
  getContextTone,
} from './context-usage-display';
import {
  getModelsSectionCount,
  getOlderActivityCostUsd,
  getSessionCostBreakdown,
  getVisibleSessionCostModels,
  type SessionCostBreakdown,
  type SessionCostBreakdownModel,
} from './session-cost-breakdown';
import { friendlyModelName, resolveModelProviderName } from './session-model-display';
import { Row, TokenRow } from './session-detail-rows';
import { SessionPageSheet } from './session-page-sheet';
import { SessionSandboxSection } from './session-sandbox-section';
import { copySessionId, copySessionLink } from './session-row-actions';
import { type SessionConnectionDisplay } from './session-connection-indicator-state';
import { SessionTodoLinkRow } from '@/components/todos/session-todo-link';
import { SessionShareSection } from './session-share-section';

type SessionContextSheetProps = {
  visible: boolean;
  info: SessionContextInfo | undefined;
  sessionId: string;
  /** Message the copied link resumes at; null copies the session link without a position. */
  anchorMessageId: string | null;
  sessionTitle: string;
  activeSessionType: ResolvedSession['type'] | null;
  ownerConnectionId: string | null;
  modelDisplay: string;
  providerDisplay: string;
  totalCostMicrodollars: number | null;
  breakdownCostUsd: number;
  messages: StoredMessage[];
  modelOptions: SessionModelOption[];
  onClose: () => void;
  autoApproveState: SessionAutoApproveState;
  onAutoApproveChange: (enabled: boolean) => void;
  connectionDisplay: SessionConnectionDisplay;
  onRetryConnection: () => void;
  /** The control-plane session id; null when this session has no sandbox. */
  cloudAgentSessionId: string | null;
  /** See `SessionSandboxSection`: only a failed start offers a fresh start. */
  cloudStatusType: string | null;
  organizationId: string | undefined;
};

const SHEET_RING_SIZE = 96;
const SHEET_RING_STROKE = 8;

// The PR row pulls in expo-router, the browser helper, the badge, and its
// native analytics/skeleton modules, which the mounted sheet test's node
// environment cannot load. Lazy-loading the whole row keeps them out of this
// module's graph until a session with a manager and an associated PR renders
// it, the same reason the session rows import the router at press time.
const LazySessionContextPrRow = lazy(async () => {
  const { SessionContextPrRow } = await import('./session-context-pr-row');
  return { default: SessionContextPrRow };
});

// The preview row owns the sandbox's service scan, the preview-ticket mutation
// and the in-app browser hand-off. Lazy-loading it keeps those modules out of
// this sheet's graph until a session that can actually preview renders it, the
// same reason the PR row above is lazy.
const LazySessionPreviewRow = lazy(async () => {
  const { SessionPreviewRow } = await import('./session-preview-row');
  return { default: SessionPreviewRow };
});

const TONE_TEXT_CLASS = {
  destructive: 'text-destructive',
  warning: 'text-warn',
  primary: 'text-foreground',
  neutral: 'text-foreground',
} satisfies Record<ContextTone, string>;

function toneTextClass(tone: ContextTone): string {
  return TONE_TEXT_CLASS[tone];
}

type RunningOnState = { kind: 'hidden' } | { kind: 'pending' } | { kind: 'label'; label: string };

type CopyFeedbackState = 'idle' | 'copied' | 'failed';

/** Catalog keys for a copy row's inline outcome, per outcome. */
type CopyRowMessages = { readonly copied: string; readonly failed: string };

function copyStatusLabel(
  state: CopyFeedbackState,
  t: (key: string) => string,
  messages: CopyRowMessages
): string | null {
  if (state === 'copied') {
    return t(messages.copied);
  }
  if (state === 'failed') {
    return t(messages.failed);
  }
  return null;
}

/**
 * Inline feedback for a copy row inside the sheet. sonner toasts render in the
 * app root, behind this Modal's window, so the row shows the outcome itself
 * instead of relying on the toast. Closing the sheet clears the feedback and
 * invalidates pending results so a reopen starts from the call to action even
 * if an earlier copy finishes late.
 */
function useCopyRowFeedback(
  copy: () => Promise<boolean>,
  messages: CopyRowMessages,
  visible: boolean
) {
  const { t } = useTranslation();
  const [state, setState] = useState<CopyFeedbackState>('idle');
  const generation = useRef(0);
  useEffect(() => {
    if (!visible) {
      setState('idle');
    }
    return () => {
      generation.current += 1;
    };
  }, [visible]);
  return {
    state,
    status: copyStatusLabel(state, t, messages),
    handlePress: () => {
      void (async () => {
        const current = generation.current;
        const success = await copy();
        if (current === generation.current) {
          setState(success ? 'copied' : 'failed');
        }
      })();
    },
  };
}

export function SessionContextSheet({
  visible,
  info,
  sessionId,
  anchorMessageId,
  sessionTitle,
  activeSessionType,
  ownerConnectionId,
  modelDisplay,
  providerDisplay,
  totalCostMicrodollars,
  breakdownCostUsd,
  messages,
  modelOptions,
  onClose,
  autoApproveState,
  onAutoApproveChange,
  connectionDisplay,
  onRetryConnection,
  cloudAgentSessionId,
  cloudStatusType,
  organizationId,
}: Readonly<SessionContextSheetProps>) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const manager = useOptionalSessionManager();
  const runningOn = useRunningOnLabel(activeSessionType, ownerConnectionId, visible);
  const idCopy = useCopyRowFeedback(
    async () => {
      const copied = await copySessionId(sessionId);
      return copied;
    },
    { copied: 'agents.sessionRow.idCopied', failed: 'agents.sessionRow.couldNotCopyId' },
    visible
  );
  const linkCopy = useCopyRowFeedback(
    async () => {
      const copied = await copySessionLink(sessionId, anchorMessageId);
      return copied;
    },
    { copied: 'agentChat.chatLink.linkCopied', failed: 'agentChat.chatLink.couldNotCopyLink' },
    visible
  );
  let connectionLabel = t('agentChat.sessionConnection.connecting');
  if (connectionDisplay === 'connected') {
    connectionLabel = t('common.connected');
  } else if (connectionDisplay === 'lost') {
    connectionLabel = t('agentChat.sessionConnection.connectionLost');
  } else if (connectionDisplay === 'reconnecting') {
    connectionLabel = t('agentChat.sessionConnection.reconnecting');
  } else if (connectionDisplay === 'scheduled') {
    // i18n-dup-ok: 'common.scheduled' is the sentence-case connection label and the spoken a11y word; 'sessionRow.scheduled' is the full-caps mono row badge, and each locale cases the badge form itself — the same split as glanceable.needsInput beside sessionRow.needsInput.
    connectionLabel = t('common.scheduled');
  }
  const content = getContextSheetContent(info, totalCostMicrodollars);
  const tone = getContextTone(info?.percentage);
  const arcFraction = getArcFraction(info?.percentage);
  const breakdown = useMemo<SessionCostBreakdown>(
    () => getSessionCostBreakdown(messages, breakdownCostUsd),
    [messages, breakdownCostUsd]
  );
  // Render-only filter: totals/subagent residual still use the full breakdown.
  const visibleModels = useMemo(
    () => getVisibleSessionCostModels(breakdown.models),
    [breakdown.models]
  );
  const olderActivityCostUsd = getOlderActivityCostUsd(totalCostMicrodollars, breakdownCostUsd);
  const modelsSectionCount = getModelsSectionCount(
    breakdown.models,
    breakdown.subagentCostUsd,
    olderActivityCostUsd
  );
  // The session total is the model cost plus what the sandbox cost. The read is
  // shared with the session page's pill, which owns its poll timer and stays
  // mounted behind the sheet, so the sheet only reads the cache entry it keeps
  // fresh. A session with no compute scope (or another payer) answers nothing
  // and the model cost stands alone.
  const computeCharges = useSessionComputeCharges({
    cloudAgentSessionId,
    organizationId,
    poll: false,
  });
  const totalCostText =
    formatSessionTotalCost(
      sessionTotalMicrodollars(
        totalCostMicrodollars,
        computeChargesMicrodollars(computeCharges.data)
      )
    ) ?? content.cost;

  return (
    <SessionPageSheet visible={visible} onClose={onClose} dismissible>
      <SheetHeader
        title={t('agentChat.contextUsage.title')}
        onDone={onClose}
        topInset="ios-page-sheet"
      />

      {/* First row of the sheet body, outside the ScrollView so it stays
          visible while the context details scroll. */}
      <View className="px-4 pt-2">
        <RowGroup>
          <SessionAutoApproveRow state={autoApproveState} onValueChange={onAutoApproveChange} />
        </RowGroup>
      </View>

      {/* Always-visible, outside the ScrollView so the connection reading stays
          on screen while the details scroll. */}
      <View className="px-4 pb-2 pt-2" testID="session-context-sheet-connection">
        <RowGroup>
          <KvRow
            label={t('agentChat.sessionConnection.label')}
            value={connectionLabel}
            valueFace="text"
            trailing={
              connectionDisplay === 'lost' ? (
                <Pressable
                  onPress={onRetryConnection}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('agentChat.sessionConnection.retryConnection')}
                  className={cn(
                    ROW_TARGET_CLASS,
                    'min-w-14 items-center justify-center active:opacity-70'
                  )}
                  testID="session-context-sheet-connection-retry"
                >
                  <Text className="text-sm font-medium text-primary">{t('common.retry')}</Text>
                </Pressable>
              ) : undefined
            }
          />
        </RowGroup>
      </View>

      {/* Rows below are exposed individually to screen readers; collapsing
          them behind a single ScrollView accessibilityLabel would shadow the
          natural read order. */}
      <ScrollView className="flex-1" contentContainerClassName={cn(SCREEN_BODY_CLASS, 'pb-6')}>
        <Card>
          {/* The ring sits beside its value, not above it. Stacked, the ring
              held the sheet's first text a ring-height down the scroll content,
              which the design gate reads as empty space under the title: the
              ring draws nothing the accessibility tree reports. Side by side,
              the ring fills the row and the value centres on the ring's own
              middle, so the pair reads as one figure and neither half floats
              off its partner's centre. */}
          <View className="flex-row items-center justify-center gap-3">
            <ContextUsageRing
              size={SHEET_RING_SIZE}
              strokeWidth={SHEET_RING_STROKE}
              arcFraction={arcFraction}
              tone={tone}
              testID="session-context-sheet-ring"
            />
            <View className="min-h-8 justify-center">
              {content.percentage ? (
                <Text variant="figure" className={toneTextClass(tone)}>
                  {content.percentage}
                </Text>
              ) : (
                <Text variant="muted" className="text-base">
                  {content.windowUnavailableLabel}
                </Text>
              )}
            </View>
          </View>

          <Row label={t('agentChat.contextUsage.used')}>
            <Text className="text-base font-medium text-foreground tabular-nums">
              {content.usedTokens ?? '-'}
              {content.usedTokens !== null ? (
                <Text className="text-sm text-muted-foreground">
                  {' '}
                  {content.capacityKnown && content.windowTokens
                    ? t('agentChat.contextUsage.ofWindowTokens', { window: content.windowTokens })
                    : t('agentChat.contextUsage.tokens', {
                        count: content.usedTokensCount ?? 0,
                      })}
                </Text>
              ) : null}
            </Text>
          </Row>

          {content.capacityKnown || autoApproveState !== 'unavailable' ? (
            <Row label={t('common.remaining')}>
              <Text className="text-base font-medium text-foreground tabular-nums">
                {content.remainingTokens ?? '-'}
                {content.capacityKnown ? (
                  <Text className="text-sm text-muted-foreground">
                    {' '}
                    {t('agentChat.contextUsage.tokensWithPercentage', {
                      percentage: content.remainingPercentage ?? '',
                    })}
                  </Text>
                ) : null}
              </Text>
            </Row>
          ) : null}

          <Row label={t('common.model')}>
            <Text className="text-base font-medium text-foreground">{modelDisplay || '-'}</Text>
          </Row>

          <Row label={t('agentChat.contextUsage.provider')}>
            <Text className="text-base font-medium text-foreground">{providerDisplay || '-'}</Text>
          </Row>

          {/* Identity group: which session this sheet describes, its id, and
              where it runs. The sheet surface covers the session page behind
              it, so without the title row nothing on screen names the
              session the id below belongs to. */}
          <Row label={t('agentChat.session.title')}>
            <Text className="text-base font-medium text-foreground" numberOfLines={1}>
              {sessionTitle}
            </Text>
          </Row>
        </Card>

        <SessionTodoLinkRow sessionId={sessionId} />

        <RowGroup>
          {/* The pill is independent of goal and PR status: the sheet shows the
              associated PR in every state (open/draft/merged/closed) whenever
              the session has one, unlike the session page which gates on an
              active goal and an active PR. */}
          {manager ? (
            <Suspense fallback={null}>
              <LazySessionContextPrRow manager={manager} sessionId={sessionId} onClose={onClose} />
            </Suspense>
          ) : null}

          <SessionChangesRow sessionId={sessionId} onClose={onClose} />

          <CopyRow
            testID="session-context-sheet-copy-id"
            label={t('agents.sessionRow.copyId')}
            value={sessionId}
            state={idCopy.state}
            status={idCopy.status}
            onPress={idCopy.handlePress}
          />

          {/* The link row sits under the id row: both copy this session's
              value, and the sheet keeps the destination (resume URL) visible
              beside its call to action. */}
          <CopyRow
            testID="session-context-sheet-copy-link"
            label={t('common.copyLink')}
            value={sessionResumeUrl({ sessionId, anchorMessageId })}
            state={linkCopy.state}
            status={linkCopy.status}
            onPress={linkCopy.handlePress}
          />

          {runningOn.kind !== 'hidden' ? (
            <KvRow
              label={t('agentChat.instancePicker.runOn')}
              value={runningOn.kind === 'label' ? runningOn.label : t('common.loading')}
              valueFace="text"
            />
          ) : null}
        </RowGroup>

        <SessionShareSection sessionId={sessionId} visible={visible} />

        <SessionSandboxSection
          cloudAgentSessionId={cloudAgentSessionId}
          organizationId={organizationId}
          startFailed={cloudStatusType === 'error'}
        />

        {/* The row paints the combined total, so its gate is that total, not
            the model-only figure: a read-only session with no model cost can
            still owe a workspace's positive sandbox compute, and hiding the
            row would hide its figure and its sharing note together. */}
        <Card>
          {totalCostText !== null || autoApproveState !== 'unavailable' ? (
            <KvRow
              label={t('agentChat.contextUsage.totalCost')}
              value={totalCostText ?? '-'}
              valueFace="numeric"
            />
          ) : null}
          {/* The web session information dialog adds the whole workspace's
              recorded compute to its total and names that sharing under the
              Compute figure. This total is the same one the header pill
              paints, so it carries the same note rather than reading as this
              chat's own sandbox spend. */}
          {computeCharges.data?.scope === 'workspace' ? (
            <Text variant="caption" testID="session-context-sheet-shared-compute">
              {t('cloudAgent.compute.sharedWorkspace')}
            </Text>
          ) : null}
          <Text variant="caption">{t('agentChat.contextUsage.usageReflectsLatest')}</Text>
        </Card>

        <Section label={t('agentChat.contextUsage.tokenUsage')}>
          <RowGroup>
            <TokenRow label={t('agentChat.messageDetails.input')} value={breakdown.totals.input} />
            <TokenRow
              label={t('agentChat.messageDetails.output')}
              value={breakdown.totals.output}
            />
            <TokenRow
              label={t('agentChat.messageDetails.reasoning')}
              value={breakdown.totals.reasoning}
            />
            <TokenRow
              label={t('agentChat.messageDetails.cacheRead')}
              value={breakdown.totals.cacheRead}
            />
            <TokenRow
              label={t('agentChat.messageDetails.cacheWrite')}
              value={breakdown.totals.cacheWrite}
            />
            <TokenRow label={t('agentChat.messageDetails.total')} value={breakdown.totals.total} />
            <KvRow
              label={t('agentChat.contextUsage.cacheRate')}
              value={
                breakdown.totals.cacheRatePct === null
                  ? '-'
                  : formatPercent(breakdown.totals.cacheRatePct, i18n.language)
              }
              valueFace="numeric"
            />
          </RowGroup>
        </Section>

        {modelsSectionCount > 0 ? (
          /* i18n-dup-ok: 'agentChat.contextUsage.modelsCount_other' is this counted message's plural other category — the bare key carries that copy by i18next convention, and every catalog inflects the family by its own count rules. */
          <Section
            label={t('agentChat.contextUsage.modelsCount', {
              count: modelsSectionCount,
              displayCount: formatNumber(modelsSectionCount, i18n.language),
            })}
            notice={<Text variant="caption">{t('agentChat.contextUsage.tokenTotalsNote')}</Text>}
          >
            <RowGroup>
              {visibleModels.map(model => (
                <ModelRow
                  key={`${model.providerID}:${model.modelID}`}
                  model={model}
                  modelOptions={modelOptions}
                />
              ))}
              {breakdown.subagentCostUsd > 0 ? (
                <SubagentRow costUsd={breakdown.subagentCostUsd} />
              ) : null}
              {olderActivityCostUsd > 0 ? (
                <OlderActivityRow costUsd={olderActivityCostUsd} />
              ) : null}
            </RowGroup>
          </Section>
        ) : null}

        <SessionComputeSection
          charges={computeCharges.data}
          isError={computeCharges.isError && !isPermissionDeniedError(computeCharges.error)}
          onRetry={() => void computeCharges.refetch()}
        />

        <SessionPreviewRowSlot
          cloudAgentSessionId={cloudAgentSessionId}
          organizationId={organizationId}
        />
      </ScrollView>

      <View style={{ height: insets.bottom }} className="bg-background" />
    </SessionPageSheet>
  );
}

function useRunningOnLabel(
  activeSessionType: ResolvedSession['type'] | null,
  ownerConnectionId: string | null,
  visible: boolean
): RunningOnState {
  const trpc = useTRPC();
  const isRemote = activeSessionType === 'remote';
  const { data, isPending } = useQuery(
    trpc.activeSessions.listInstances.queryOptions(undefined, {
      enabled: isRemote && visible,
      staleTime: 30_000,
    })
  );
  const label = resolveRunningOnLabel({
    activeSessionType,
    ownerConnectionId,
    instances: data?.instances ?? [],
  });
  if (label !== null) {
    return { kind: 'label', label };
  }
  // A live CLI target resolves from the connected-instances list; keep the
  // row's space while that first lookup is in flight so the rows below it do
  // not jump when the label arrives.
  return isRemote && isPending ? { kind: 'pending' } : { kind: 'hidden' };
}

/**
 * The preview entry, for a session the control plane can serve a preview for
 * (`workspace_` ids). An older session would only get a 404 back, so its row is
 * absent rather than disabled, and the lazy module is never loaded for it.
 */
function SessionPreviewRowSlot({
  cloudAgentSessionId,
  organizationId,
}: Readonly<{
  cloudAgentSessionId: string | null | undefined;
  organizationId: string | undefined;
}>) {
  if (!isCloudAgentSessionId(cloudAgentSessionId)) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <LazySessionPreviewRow
        cloudAgentSessionId={cloudAgentSessionId}
        organizationId={organizationId}
      />
    </Suspense>
  );
}

function CopyRow({
  testID,
  label,
  value,
  state,
  status,
  onPress,
}: Readonly<{
  testID: string;
  label: string;
  value: string;
  state: CopyFeedbackState;
  status: string | null;
  onPress: () => void;
}>) {
  // The row keeps its call-to-action name in every state; the copy outcome
  // renders beside it, so one capture of the sheet shows both the row the
  // scenario names and the feedback it demands.
  //
  // The value is an identifier or a resume URL: it keeps the mono face and
  // wraps over as many lines as it needs, because the row is the only place
  // the whole value is readable — an ellipsis would hide the tail that
  // identifies a session id or a link, and the copies are the row's action.
  // `ConfigureRow` types its subtitle as a plain string painted in the caption
  // face, so the value line fills the row's subtitle node slot instead.
  return (
    <ConfigureRow
      testID={testID}
      icon={Copy}
      title={label}
      subtitlePlaceholder={
        <Text variant="mono" className="mt-0.5 text-xs text-foreground">
          {value}
        </Text>
      }
      variant="action"
      onPress={onPress}
      trailing={
        status ? (
          <Text
            variant="caption"
            className={state === 'failed' ? 'text-destructive' : 'text-foreground'}
          >
            {status}
          </Text>
        ) : undefined
      }
    />
  );
}

/**
 * Opens the session's file changes. Like the PR row, the sheet dismisses
 * before the push so the route does not render behind it. The router is
 * imported at press time because the mounted sheet test cannot load
 * expo-router.
 */
function SessionChangesRow({
  sessionId,
  onClose,
}: Readonly<{ sessionId: string; onClose: () => void }>) {
  const { t } = useTranslation();
  const label = t('agentChat.sessionChanges.viewChanges');
  return (
    <ConfigureRow
      testID="session-context-sheet-view-changes"
      icon={FileDiff}
      title={label}
      variant="navigation"
      accessibilityLabel={label}
      onPress={() => {
        onClose();
        void (async () => {
          const { router } = await import('expo-router');
          router.push(`/(app)/session-changes/${sessionId}` as Href);
        })();
      }}
    />
  );
}

function ModelRow({
  model,
  modelOptions,
}: Readonly<{
  model: SessionCostBreakdownModel;
  modelOptions: SessionModelOption[];
}>) {
  const [expanded, setExpanded] = useState(false);
  const colors = useThemeColors();
  const { t } = useTranslation();
  const name = friendlyModelName(model.providerID, model.modelID, modelOptions);
  const provider = resolveModelProviderName(model.providerID, model.modelID, modelOptions);
  const stepsLabel = t('agentChat.contextUsage.stepsCount', {
    count: model.steps,
    steps: formatNumber(model.steps, i18n.language),
  });
  return (
    <View>
      <Pressable
        onPress={() => {
          setExpanded(value => !value);
        }}
        accessibilityRole="button"
        accessibilityLabel={t('agentChat.contextUsage.modelAccessibilityLabel', {
          name,
          provider,
          steps: stepsLabel,
          cost: formatCost(model.costUsd),
        })}
        accessibilityState={{ expanded }}
        className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 px-4 py-3 active:opacity-70')}
      >
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {name}
          </Text>
          <Text variant="caption" className="mt-0.5">
            {provider} · {stepsLabel}
          </Text>
        </View>
        <Text className="text-sm font-medium text-foreground tabular-nums">
          {formatCost(model.costUsd)}
        </Text>
        {/* A disclosure caret, not a navigation chevron: it names the state of
            the block under it and flips with it. */}
        {expanded ? (
          <ChevronUp size={14} color={colors.mutedForeground} />
        ) : (
          <ChevronDown size={14} color={colors.mutedForeground} />
        )}
      </Pressable>
      {expanded ? (
        <View className="pb-3">
          <TokenRow label={t('agentChat.messageDetails.input')} value={model.tokens.input} />
          <TokenRow label={t('agentChat.messageDetails.output')} value={model.tokens.output} />
          <TokenRow
            label={t('agentChat.messageDetails.reasoning')}
            value={model.tokens.reasoning}
          />
          <TokenRow
            label={t('agentChat.messageDetails.cacheRead')}
            value={model.tokens.cacheRead}
          />
          <TokenRow
            label={t('agentChat.messageDetails.cacheWrite')}
            value={model.tokens.cacheWrite}
          />
          <TokenRow label={t('agentChat.messageDetails.total')} value={model.tokens.total} />
        </View>
      ) : null}
    </View>
  );
}

function SubagentRow({ costUsd }: Readonly<{ costUsd: number }>) {
  const { t } = useTranslation();
  return (
    <ConfigureRow
      icon={Bot}
      title={t('agentChat.contextUsage.subagents')}
      subtitle={t('agentChat.contextUsage.subagentsDescription')}
      variant="action"
      trailing={
        <Text className="text-sm font-medium text-foreground tabular-nums">
          {formatCost(costUsd)}
        </Text>
      }
    />
  );
}

function OlderActivityRow({ costUsd }: Readonly<{ costUsd: number }>) {
  const { t } = useTranslation();
  return (
    <ConfigureRow
      icon={History}
      title={t('agentChat.contextUsage.olderActivity')}
      subtitle={t('agentChat.contextUsage.olderActivityDescription')}
      variant="action"
      trailing={
        <Text className="text-sm font-medium text-foreground tabular-nums">
          {formatCost(costUsd)}
        </Text>
      }
    />
  );
}
