/* eslint-disable max-lines -- The context sheet composes the usage ring, token totals, and per-model cost rows. */
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from '@/components/ui/icons';
import { type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { SheetHeader } from '@/components/sheet-header';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type SessionContextInfo } from '@/lib/session-context-info';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { ContextUsageRing } from './context-usage-ring';
import {
  type ContextTone,
  formatCost,
  formatExactTokens,
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
import { SessionPageSheet } from './session-page-sheet';

type SessionContextSheetProps = {
  visible: boolean;
  info: SessionContextInfo;
  modelDisplay: string;
  providerDisplay: string;
  totalCostMicrodollars: number | null;
  breakdownCostUsd: number;
  messages: StoredMessage[];
  modelOptions: SessionModelOption[];
  onClose: () => void;
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

export function SessionContextSheet({
  visible,
  info,
  modelDisplay,
  providerDisplay,
  totalCostMicrodollars,
  breakdownCostUsd,
  messages,
  modelOptions,
  onClose,
}: Readonly<SessionContextSheetProps>) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const content = getContextSheetContent(info, totalCostMicrodollars);
  const tone = getContextTone(info.percentage);
  const arcFraction = getArcFraction(info.percentage);
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
      <SheetHeader title={t('agentChat.contextUsage.title')} onDone={onClose} />

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

          {content.capacityKnown ? (
            <Row label={t('agentChat.contextUsage.remaining')}>
              <Text className="text-base font-medium text-foreground tabular-nums">
                {content.remainingTokens}
                <Text className="text-sm text-muted-foreground">
                  {' '}
                  {t('agentChat.contextUsage.tokensWithPercentage', {
                    percentage: content.remainingPercentage ?? '',
                  })}
                </Text>
              </Text>
            </Row>
          ) : null}

          <Row label={t('agentChat.messageDetails.model')}>
            <Text className="text-base font-medium text-foreground">{modelDisplay}</Text>
          </Row>

          <Row label={t('agentChat.contextUsage.provider')}>
            <Text className="text-base font-medium text-foreground">{providerDisplay}</Text>
          </Row>

          {content.cost !== null ? (
            <Row label={t('agentChat.contextUsage.totalCost')}>
              <Text className="text-base font-medium text-foreground tabular-nums">
                {content.cost}
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

function Row({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <View className="gap-1">
      <Text className="text-xs uppercase tracking-wide text-muted-foreground">{label}</Text>
      {children}
    </View>
  );
}

function TokenRow({ label, value }: Readonly<{ label: string; value: number }>) {
  return (
    <View className="flex-row items-center justify-between">
      <Text className="text-sm text-muted-foreground">{label}</Text>
      <Text className="text-sm font-medium text-foreground tabular-nums">
        {formatExactTokens(value)}
      </Text>
    </View>
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
