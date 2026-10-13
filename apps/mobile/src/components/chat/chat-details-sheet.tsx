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
import { useTargetSupportsImages, targetSupportsTools } from '@/lib/chat/backend-capabilities';
import { type StoredChatBackend } from '@/lib/chat/backend-store';
import { chatTargetKind, decodeBackendTarget } from '@/lib/chat/backend-target';
import { totalUsage } from '@/lib/chat/chat-usage';
import { type ChatRecord } from '@/lib/chat/store';
import { formatDate, formatNumber, formatPercent } from '@/lib/format';
import { thinkingEffortLabel } from '@/lib/hooks/use-available-models';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { cn } from '@/lib/utils';

import {
  type ChatCost,
  chatContextInfo,
  chatCost,
  type ChatModelUsage,
  chatModelUsages,
  type ModelCost,
  modelNameOf,
} from './chat-details-state';
import { type McpSettings } from './mcp-settings-sheet';
import { modelCapabilityKey } from './model-tools-hint';

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

/** Who answers a target, as the sheet names it. A deleted backend has no name left. */
function backendLabel(
  model: string,
  backends: readonly StoredChatBackend[],
  t: (key: string) => string
): string {
  const kind = chatTargetKind(model);
  if (kind === 'kilo') {
    return t('consent.kilo');
  }
  if (kind === 'local') {
    return t('consent.onDevice');
  }
  try {
    const target = decodeBackendTarget(model);
    return backends.find(one => one.id === target?.backendId)?.name ?? t('common.unknown');
  } catch {
    return t('common.unknown');
  }
}

function modelCostLabel(cost: ModelCost, t: (key: string) => string): string {
  if (cost.kind === 'onDevice') {
    return t('modelChat.details.noCost');
  }
  if (cost.kind === 'unknown') {
    return t('modelChat.details.costUnknown');
  }
  return formatCost(cost.usd);
}

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

/** A target the backends no longer resolve sends no tools, so it has none to show. */
function supportsTools(model: string): boolean {
  try {
    return targetSupportsTools(model);
  } catch {
    return false;
  }
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

function ModelsSection({
  usages,
  backends,
}: Readonly<{ usages: readonly ChatModelUsage[]; backends: readonly StoredChatBackend[] }>) {
  const { t } = useTranslation();
  return (
    <View className="mt-8 gap-3">
      {/* i18n-dup-ok: 'agentChat.contextUsage.modelsCount_other' is this counted message's plural other category — the bare key carries that copy by i18next convention, and every catalog inflects the family by its own count rules. */}
      <Text className="text-sm font-semibold text-foreground">
        {t('agentChat.contextUsage.modelsCount', {
          count: usages.length,
          displayCount: formatNumber(usages.length, i18n.language),
        })}
      </Text>
      <View className="gap-2">
        {usages.map(one => (
          <View
            key={one.model}
            className="flex-row items-center justify-between gap-3 rounded-md border border-border px-3 py-3"
          >
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                {one.name}
              </Text>
              <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                {backendLabel(one.model, backends, t)}
              </Text>
            </View>
            <Text className="text-sm font-medium text-foreground tabular-nums">
              {modelCostLabel(one.cost, t)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function ToolsSection({
  model,
  imagesSupported,
  mcp,
}: Readonly<{ model: string; imagesSupported: boolean; mcp: McpSettings }>) {
  const { t } = useTranslation();
  const tools = supportsTools(model);
  return (
    <View className="mt-8 gap-4">
      <Text className="text-sm font-semibold text-foreground">{t('profiles.agents.tools')}</Text>
      {tools ? (
        <>
          <Row label={t('modelChat.mcp.title')}>
            <Text className="text-base font-medium text-foreground">
              {t(mcp.view.statusKey, { count: mcp.view.toolCount })}
            </Text>
          </Row>
          <Row label={t('modelChat.mcp.settingsToolsTitle')}>
            <Text className="text-base font-medium text-foreground">
              {t(mcp.settingsTools.statusKey)}
            </Text>
          </Row>
          <Row label={t('modelChat.details.remoteServersOn')}>
            <Text className="text-base font-medium text-foreground tabular-nums">
              {formatNumber(mcp.servers.filter(server => server.enabled).length, i18n.language)}
            </Text>
          </Row>
        </>
      ) : (
        <Text className="text-sm text-muted-foreground">
          {t(modelCapabilityKey(false, imagesSupported))}
        </Text>
      )}
    </View>
  );
}
