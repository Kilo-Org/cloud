import { hitRatio } from '@kilocode/harness-sdk';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { ContextUsageRing } from '@/components/agents/context-usage-ring';
import {
  type ContextTone,
  formatCost,
  getArcFraction,
  getContextSheetContent,
  getContextTone,
} from '@/components/agents/context-usage-display';
import { Row, TokenRow } from '@/components/agents/session-detail-rows';
import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { SheetHeader } from '@/components/sheet-header';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { useTargetSupportsImages } from '@/lib/chat/backend-capabilities';
import { type StoredChatBackend } from '@/lib/chat/backend-store';
import { chatTargetKind } from '@/lib/chat/backend-target';
import { totalUsage } from '@/lib/chat/chat-usage';
import { type ChatRecord } from '@/lib/chat/store';
import { formatDate, formatPercent } from '@/lib/format';
import { thinkingEffortLabel } from '@/lib/hooks/use-available-models';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { cn } from '@/lib/utils';

import { backendLabel, modelCostLabel, ModelsSection, ToolsSection } from './chat-details-sections';
import {
  chatContextInfo,
  type ChatCost,
  chatCost,
  chatModelUsages,
  modelNameOf,
} from './chat-details-state';
import { type McpSettings } from './mcp-settings-sheet';

type ChatDetailsSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** The target the chat is on now. */
  model: string;
  record: ChatRecord;
  modelOptions: readonly SessionModelOption[];
  backends: readonly StoredChatBackend[];
  mcp: McpSettings;
};

const SHEET_RING_SIZE = 96;
const SHEET_RING_STROKE = 8;

const TONE_TEXT_CLASS = {
  destructive: 'text-destructive',
  warning: 'text-warn',
  primary: 'text-foreground',
  neutral: 'text-foreground',
} satisfies Record<ContextTone, string>;

const DATE_TIME = { dateStyle: 'medium', timeStyle: 'short' } as const;

function chatCostLabel(cost: ChatCost, t: (key: string) => string): string {
  if (cost.kind === 'none') {
    return '-';
  }
  if (cost.kind === 'known') {
    return formatCost(cost.usd);
  }
  return modelCostLabel(cost, t);
}

function chatCostNote(cost: ChatCost, t: (key: string) => string): string | null {
  if (cost.kind === 'unknown') {
    return t('modelChat.details.costUnknownNote');
  }
  if (cost.kind !== 'known') {
    return null;
  }
  if (cost.partial) {
    return t('modelChat.details.costPartialNote');
  }
  return cost.estimated ? t('modelChat.details.costEstimatedNote') : null;
}

/**
 * What a Quick Chat has used and what it runs with: the window the last call
 * filled, the tokens and the cost of every answer, the model, the backend and
 * the tools. It is the context sheet the remote sessions have, read from the
 * chat's own count rather than from a server's.
 */
export function ChatDetailsSheet({
  visible,
  onClose,
  model,
  record,
  modelOptions,
  backends,
  mcp,
}: Readonly<ChatDetailsSheetProps>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const imagesSupported = useTargetSupportsImages(model);
  const info = chatContextInfo(model, record.prompted, modelOptions);
  const content = getContextSheetContent(info, null);
  const tone = getContextTone(info?.percentage);
  const usages = chatModelUsages(record.usage, modelOptions);
  const cost = chatCost(usages.map(one => one.cost));
  const costNote = chatCostNote(cost, t);
  const total = totalUsage(record.usage);
  const onDevice =
    usages.length === 0
      ? chatTargetKind(model) === 'local'
      : usages.some(one => chatTargetKind(one.model) === 'local');
  const onDeviceOnly =
    usages.length === 0 ? onDevice : usages.every(one => chatTargetKind(one.model) === 'local');
  const variants = modelOptions.find(one => one.id === model)?.variants ?? [];

  return (
    <SessionPageSheet visible={visible} onClose={onClose}>
      <SheetHeader
        title={t('modelChat.details.title')}
        onDone={onClose}
        topInset="ios-page-sheet"
      />
      <ScrollView className="flex-1" contentContainerClassName="px-6 pb-6 pt-2">
        <View className="items-center gap-3 pt-2">
          <ContextUsageRing
            size={SHEET_RING_SIZE}
            strokeWidth={SHEET_RING_STROKE}
            arcFraction={getArcFraction(info?.percentage)}
            tone={tone}
            testID="chat-details-ring"
          />
          <View className="min-h-[32px] justify-center">
            {content.percentage ? (
              <Text className={cn('text-2xl font-semibold tabular-nums', TONE_TEXT_CLASS[tone])}>
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
              <Text className="text-sm text-muted-foreground">
                {' '}
                {content.capacityKnown && content.windowTokens
                  ? t('agentChat.contextUsage.ofWindowTokens', { window: content.windowTokens })
                  : t('agentChat.contextUsage.tokens')}
              </Text>
            </Text>
          </Row>

          {content.capacityKnown ? (
            <Row label={t('common.remaining')}>
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

          <Row label={t('common.model')}>
            <Text className="text-base font-medium text-foreground">
              {model === '' ? '-' : modelNameOf(model, modelOptions)}
            </Text>
          </Row>

          <Row label={t('modelChat.details.backend')}>
            <Text className="text-base font-medium text-foreground">
              {backendLabel(model, backends, t)}
            </Text>
          </Row>

          {variants.length > 0 ? (
            <Row label={t('agentChat.modelSelector.thinkingEffort')}>
              <Text className="text-base font-medium text-foreground">
                {record.effort === null
                  ? t('modelChat.details.effortDefault')
                  : thinkingEffortLabel(record.effort)}
              </Text>
            </Row>
          ) : null}

          <Row label={t('agentChat.contextUsage.totalCost')}>
            <Text
              className="text-base font-medium text-foreground tabular-nums"
              testID="chat-details-cost"
            >
              {chatCostLabel(cost, t)}
            </Text>
            {costNote === null ? null : (
              <Text className="text-xs text-muted-foreground">{costNote}</Text>
            )}
          </Row>

          <Text className="text-xs text-muted-foreground">
            {t('agentChat.contextUsage.usageReflectsLatest')}
          </Text>
        </View>

        <View className="mt-8 gap-4">
          <Text className="text-sm font-semibold text-foreground">
            {t('agentChat.contextUsage.tokenUsage')}
          </Text>
          <View className="gap-3">
            <TokenRow label={t('agentChat.messageDetails.input')} value={total.inputTokens} />
            <TokenRow label={t('agentChat.messageDetails.output')} value={total.outputTokens} />
            {onDeviceOnly ? null : (
              <>
                <TokenRow
                  label={t('agentChat.messageDetails.cacheRead')}
                  value={total.cacheReadTokens}
                />
                <TokenRow
                  label={t('agentChat.messageDetails.cacheWrite')}
                  value={total.cacheWriteTokens}
                />
              </>
            )}
            <TokenRow
              label={t('agentChat.messageDetails.total')}
              value={
                total.inputTokens +
                total.outputTokens +
                total.cacheReadTokens +
                total.cacheWriteTokens
              }
            />
            {onDeviceOnly ? null : (
              <Row label={t('agentChat.contextUsage.cacheRate')}>
                <Text className="text-base font-medium text-foreground tabular-nums">
                  {total.cacheReadTokens + total.inputTokens === 0
                    ? '-'
                    : formatPercent(hitRatio(total) * 100, i18n.language)}
                </Text>
              </Row>
            )}
          </View>
          {onDevice ? (
            <Text className="text-xs text-muted-foreground" testID="chat-details-local-note">
              {t('modelChat.details.localNote')}
            </Text>
          ) : null}
          {record.createdAt === null && usages.length > 0 ? (
            <Text className="text-xs text-muted-foreground">
              {t('modelChat.details.countedSinceNote')}
            </Text>
          ) : null}
        </View>

        {usages.length > 0 ? <ModelsSection usages={usages} backends={backends} /> : null}

        <ToolsSection model={model} imagesSupported={imagesSupported} mcp={mcp} />

        <View className="mt-8 gap-4">
          {record.createdAt === null ? null : (
            <Row label={t('codeReviewer.reviewDetail.created')}>
              <Text className="text-base font-medium text-foreground">
                {formatDate(new Date(record.createdAt), i18n.language, DATE_TIME)}
              </Text>
            </Row>
          )}
          {record.updatedAt === null ? null : (
            <Row label={t('common.updated')}>
              <Text className="text-base font-medium text-foreground">
                {formatDate(new Date(record.updatedAt), i18n.language, DATE_TIME)}
              </Text>
            </Row>
          )}
        </View>
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
    </SessionPageSheet>
  );
}
