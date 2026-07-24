import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { type StoredMessage } from 'cloud-agent-sdk';

import { SheetHeader } from '@/components/sheet-header';
import { Text } from '@/components/ui/text';
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
  getSessionCostBreakdown,
  type SessionCostBreakdown,
  type SessionCostBreakdownModel,
} from './session-cost-breakdown';
import { friendlyModelName, resolveModelProviderName } from './session-model-display';

type SessionContextSheetProps = {
  visible: boolean;
  info: SessionContextInfo;
  modelDisplay: string;
  providerDisplay: string;
  totalCost: number;
  messages: StoredMessage[];
  modelOptions: SessionModelOption[];
  onClose: () => void;
};

const SHEET_RING_SIZE = 96;
const SHEET_RING_STROKE = 8;

const TONE_TEXT_CLASS: Record<ContextTone, string> = {
  destructive: 'text-destructive',
  warning: 'text-warn',
  primary: 'text-foreground',
  neutral: 'text-foreground',
};

function toneTextClass(tone: ContextTone): string {
  return TONE_TEXT_CLASS[tone];
}

export function SessionContextSheet({
  visible,
  info,
  modelDisplay,
  providerDisplay,
  totalCost,
  messages,
  modelOptions,
  onClose,
}: Readonly<SessionContextSheetProps>) {
  const insets = useSafeAreaInsets();
  const content = getContextSheetContent(info, totalCost);
  const tone = getContextTone(info.percentage);
  const arcFraction = getArcFraction(info.percentage);
  const breakdown = useMemo<SessionCostBreakdown>(
    () => getSessionCostBreakdown(messages, totalCost),
    [messages, totalCost]
  );
  const modelsSectionCount = breakdown.models.length + (breakdown.subagentCostUsd > 0 ? 1 : 0);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View className="flex-1 bg-background">
        <SheetHeader title="Context usage" onDone={onClose} doneLabel="Done" />

        {/* Rows below are exposed individually to screen readers; collapsing
            them behind a single ScrollView accessibilityLabel would shadow the
            natural read order. */}
        <ScrollView contentContainerClassName="px-6 pb-6 pt-2">
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
            <Row label="Used">
              <Text className="text-base font-medium text-foreground tabular-nums">
                {content.usedTokens}
                {content.capacityKnown && content.windowTokens ? (
                  <Text className="text-sm text-muted-foreground">
                    {' '}
                    of {content.windowTokens} tokens
                  </Text>
                ) : (
                  <Text className="text-sm text-muted-foreground"> tokens</Text>
                )}
              </Text>
            </Row>

            {content.capacityKnown ? (
              <Row label="Remaining">
                <Text className="text-base font-medium text-foreground tabular-nums">
                  {content.remainingTokens}
                  <Text className="text-sm text-muted-foreground">
                    {' '}
                    tokens ({content.remainingPercentage})
                  </Text>
                </Text>
              </Row>
            ) : null}

            <Row label="Model">
              <Text className="text-base font-medium text-foreground">{modelDisplay}</Text>
            </Row>

            <Row label="Provider">
              <Text className="text-base font-medium text-foreground">{providerDisplay}</Text>
            </Row>

            <Row label="Total cost">
              <Text className="text-base font-medium text-foreground tabular-nums">
                {content.cost}
              </Text>
            </Row>

            <Text className="text-xs text-muted-foreground">
              Usage reflects the latest completed assistant response.
            </Text>
          </View>

          <View className="mt-8 gap-4">
            <Text className="text-sm font-semibold text-foreground">Token usage</Text>
            <View className="gap-3">
              <TokenRow label="Input" value={breakdown.totals.input} />
              <TokenRow label="Output" value={breakdown.totals.output} />
              <TokenRow label="Reasoning" value={breakdown.totals.reasoning} />
              <TokenRow label="Cache read" value={breakdown.totals.cacheRead} />
              <TokenRow label="Cache write" value={breakdown.totals.cacheWrite} />
              <TokenRow label="Total" value={breakdown.totals.total} />
              <Row label="Cache rate">
                <Text className="text-base font-medium text-foreground tabular-nums">
                  {breakdown.totals.cacheRatePct === null
                    ? '-'
                    : `${breakdown.totals.cacheRatePct.toFixed(1)}%`}
                </Text>
              </Row>
            </View>
          </View>

          {modelsSectionCount > 0 ? (
            <View className="mt-8 gap-3">
              <Text className="text-sm font-semibold text-foreground">
                Models ({modelsSectionCount})
              </Text>
              <View className="gap-2">
                {breakdown.models.map(model => (
                  <ModelRow
                    key={`${model.providerID}:${model.modelID}`}
                    model={model}
                    modelOptions={modelOptions}
                  />
                ))}
                {breakdown.subagentCostUsd > 0 ? (
                  <SubagentRow costUsd={breakdown.subagentCostUsd} />
                ) : null}
              </View>
              <Text className="mt-1 text-xs text-muted-foreground">
                Token totals cover this session only and exclude subagent/child-session tokens.
              </Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={{ height: insets.bottom }} className="bg-background" />
      </View>
    </Modal>
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
  const name = friendlyModelName(model.providerID, model.modelID, modelOptions);
  const provider = resolveModelProviderName(model.providerID, model.modelID, modelOptions);
  return (
    <View className="overflow-hidden rounded-md border border-border">
      <Pressable
        onPress={() => {
          setExpanded(value => !value);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${name}, ${provider}, ${model.steps} step${model.steps === 1 ? '' : 's'}, ${formatCost(model.costUsd)}`}
        accessibilityState={{ expanded }}
        className="flex-row items-center gap-2 px-3 py-3 active:opacity-70"
      >
        {expanded ? (
          <ChevronDown size={16} color={colors.mutedForeground} />
        ) : (
          <ChevronRight size={16} color={colors.mutedForeground} />
        )}
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {name}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {provider} · {model.steps} step{model.steps === 1 ? '' : 's'}
          </Text>
        </View>
        <Text className="text-sm font-medium text-foreground tabular-nums">
          {formatCost(model.costUsd)}
        </Text>
      </Pressable>
      {expanded ? (
        <View className="gap-2 border-t border-border px-3 py-3">
          <TokenRow label="Input" value={model.tokens.input} />
          <TokenRow label="Output" value={model.tokens.output} />
          <TokenRow label="Reasoning" value={model.tokens.reasoning} />
          <TokenRow label="Cache read" value={model.tokens.cacheRead} />
          <TokenRow label="Cache write" value={model.tokens.cacheWrite} />
          <TokenRow label="Total" value={model.tokens.total} />
        </View>
      ) : null}
    </View>
  );
}

function SubagentRow({ costUsd }: Readonly<{ costUsd: number }>) {
  return (
    <View className="flex-row items-center justify-between rounded-md border border-border px-3 py-3">
      <View className="gap-0.5">
        <Text className="text-sm font-medium text-foreground">Subagents</Text>
        <Text className="text-xs text-muted-foreground">Residual cost from child sessions</Text>
      </View>
      <Text className="text-sm font-medium text-foreground tabular-nums">
        {formatCost(costUsd)}
      </Text>
    </View>
  );
}
