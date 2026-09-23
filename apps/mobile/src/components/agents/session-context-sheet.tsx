/* eslint-disable max-lines -- The context sheet composes the usage ring, token totals, and per-model cost rows. */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from '@/components/ui/icons';
import { sessionResumeUrl } from '@kilocode/app-shared/universal-links';
import { type ResolvedSession, type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { SheetHeader } from '@/components/sheet-header';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber, formatPercent } from '@/lib/format';
import { resolveRunningOnLabel } from '@/lib/instance-target-label';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type SessionContextInfo } from '@/lib/session-context-info';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { useTRPC } from '@/lib/trpc';

import { type SessionAutoApproveState } from './session-auto-approve';
import { SessionAutoApproveRow } from './session-auto-approve-row';
import { ContextUsageRing } from './context-usage-ring';
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
import { copySessionId, copySessionLink } from './session-row-actions';
import { type SessionConnectionDisplay } from './session-connection-indicator-state';

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
};

const SHEET_RING_SIZE = 96;
const SHEET_RING_STROKE = 8;

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
}: Readonly<SessionContextSheetProps>) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
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

  return (
    <SessionPageSheet visible={visible} onClose={onClose}>
      <SheetHeader
        title={t('agentChat.contextUsage.title')}
        onDone={onClose}
        topInset="ios-page-sheet"
      />

      {/* First row of the sheet body, outside the ScrollView so it stays
          visible while the context details scroll. */}
      <View className="px-6 pb-2 pt-2">
        <SessionAutoApproveRow state={autoApproveState} onValueChange={onAutoApproveChange} />
      </View>

      {/* Always-visible, outside the ScrollView so the connection reading stays
          on screen while the details scroll. */}
      <View
        className="flex-row items-center justify-between gap-3 px-6 pb-2 pt-1"
        testID="session-context-sheet-connection"
      >
        <Text className="text-xs uppercase tracking-wide text-muted-foreground">
          {t('agentChat.sessionConnection.label')}
        </Text>
        <View className="flex-row items-center gap-2">
          <Text className="text-sm font-medium text-foreground">{connectionLabel}</Text>
          {connectionDisplay === 'lost' ? (
            <Pressable
              onPress={onRetryConnection}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('agentChat.sessionConnection.retryConnection')}
              className="active:opacity-70"
              testID="session-context-sheet-connection-retry"
            >
              <Text className="text-sm font-medium text-primary">{t('common.retry')}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Rows below are exposed individually to screen readers; collapsing
          them behind a single ScrollView accessibilityLabel would shadow the
          natural read order. */}
      <ScrollView className="flex-1" contentContainerClassName="px-6 pb-6 pt-2">
        <View className="items-center gap-3 pt-2">
          <ContextUsageRing
            size={SHEET_RING_SIZE}
            strokeWidth={SHEET_RING_STROKE}
            arcFraction={arcFraction}
            tone={tone}
            testID="session-context-sheet-ring"
          />
          <View className="min-h-[32px] justify-center">
            {content.percentage ? (
              <Text className={cn('text-2xl font-semibold tabular-nums', toneTextClass(tone))}>
                {content.percentage}
              </Text>
            ) : (
              <Text className="text-base text-muted-foreground">
                {content.windowUnavailableLabel}
              </Text>
            )}
          </View>
        </View>

        <View className="mt-6 gap-4">
          <Row label={t('agentChat.contextUsage.used')}>
            <Text className="text-base font-medium text-foreground tabular-nums">
              {content.usedTokens}
              {content.capacityKnown && content.windowTokens ? (
                <Text className="text-sm text-muted-foreground">
                  {' '}
                  {t('agentChat.contextUsage.ofWindowTokens', { window: content.windowTokens })}
                </Text>
              ) : (
                <Text className="text-sm text-muted-foreground">
                  {' '}
                  {t('agentChat.contextUsage.tokens')}
                </Text>
              )}
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
            <Row label={t('agentChat.instancePicker.runOn')}>
              <Text className="text-base font-medium text-foreground">
                {runningOn.kind === 'label' ? runningOn.label : t('common.loading')}
              </Text>
            </Row>
          ) : null}

          {content.cost !== null || autoApproveState !== 'unavailable' ? (
            <Row label={t('agentChat.contextUsage.totalCost')}>
              <Text className="text-base font-medium text-foreground tabular-nums">
                {content.cost ?? '-'}
              </Text>
            </Row>
          ) : null}

          <Text className="text-xs text-muted-foreground">
            {t('agentChat.contextUsage.usageReflectsLatest')}
          </Text>
        </View>

        <View className="mt-8 gap-4">
          <Text className="text-sm font-semibold text-foreground">
            {t('agentChat.contextUsage.tokenUsage')}
          </Text>
          <View className="gap-3">
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
            <Row label={t('agentChat.contextUsage.cacheRate')}>
              <Text className="text-base font-medium text-foreground tabular-nums">
                {breakdown.totals.cacheRatePct === null
                  ? '-'
                  : formatPercent(breakdown.totals.cacheRatePct, i18n.language)}
              </Text>
            </Row>
          </View>
        </View>

        {modelsSectionCount > 0 ? (
          <View className="mt-8 gap-3">
            {/* i18n-dup-ok: 'agentChat.contextUsage.modelsCount_other' is this counted message's plural other category — the bare key carries that copy by i18next convention, and every catalog inflects the family by its own count rules. */}
            <Text className="text-sm font-semibold text-foreground">
              {t('agentChat.contextUsage.modelsCount', {
                count: modelsSectionCount,
                displayCount: formatNumber(modelsSectionCount, i18n.language),
              })}
            </Text>
            <View className="gap-2">
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
            </View>
            <Text className="mt-1 text-xs text-muted-foreground">
              {t('agentChat.contextUsage.tokenTotalsNote')}
            </Text>
          </View>
        ) : null}
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
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="gap-1 active:opacity-70"
      testID={testID}
    >
      {/* The row keeps its call-to-action name in every state; the copy
          outcome renders beside it, so one capture of the sheet shows both the
          row the scenario names and the feedback it demands. The child texts
          are the accessible name in reading order. */}
      <View className="flex-row items-center justify-between">
        <Text className="text-xs uppercase tracking-wide text-muted-foreground">{label}</Text>
        {status ? (
          <Text
            className={cn(
              'text-xs uppercase tracking-wide',
              state === 'failed' ? 'text-destructive' : 'text-foreground'
            )}
          >
            {status}
          </Text>
        ) : null}
      </View>
      <Text variant="mono" className="text-xs text-foreground">
        {value}
      </Text>
    </Pressable>
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
    <View className="overflow-hidden rounded-md border border-border">
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
        className="flex-row items-center gap-2 px-3 py-3 active:opacity-70"
      >
        {expanded ? (
          <ChevronDown size={16} color={colors.mutedForeground} />
        ) : (
          <DirectionalChevronRight size={16} color={colors.mutedForeground} />
        )}
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {name}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {provider} · {stepsLabel}
          </Text>
        </View>
        <Text className="text-sm font-medium text-foreground tabular-nums">
          {formatCost(model.costUsd)}
        </Text>
      </Pressable>
      {expanded ? (
        <View className="gap-2 border-t border-border px-3 py-3">
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
    <View className="flex-row items-center justify-between rounded-md border border-border px-3 py-3">
      <View className="gap-0.5">
        <Text className="text-sm font-medium text-foreground">
          {t('agentChat.contextUsage.subagents')}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {t('agentChat.contextUsage.subagentsDescription')}
        </Text>
      </View>
      <Text className="text-sm font-medium text-foreground tabular-nums">
        {formatCost(costUsd)}
      </Text>
    </View>
  );
}

function OlderActivityRow({ costUsd }: Readonly<{ costUsd: number }>) {
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center justify-between rounded-md border border-border px-3 py-3">
      <View className="gap-0.5">
        <Text className="text-sm font-medium text-foreground">
          {t('agentChat.contextUsage.olderActivity')}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {t('agentChat.contextUsage.olderActivityDescription')}
        </Text>
      </View>
      <Text className="text-sm font-medium text-foreground tabular-nums">
        {formatCost(costUsd)}
      </Text>
    </View>
  );
}
