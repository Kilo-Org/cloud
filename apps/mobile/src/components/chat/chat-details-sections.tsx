import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { formatCost } from '@/components/agents/context-usage-display';
import { Row } from '@/components/agents/session-detail-rows';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { targetSupportsTools } from '@/lib/chat/backend-capabilities';
import { type StoredChatBackend } from '@/lib/chat/backend-store';
import { chatTargetKind, decodeBackendTarget } from '@/lib/chat/backend-target';
import { formatNumber } from '@/lib/format';

import { type ChatModelUsage, type ModelCost } from './chat-details-state';
import { type McpSettings } from './mcp-settings-sheet';
import { modelCapabilityKey } from './model-tools-hint';

/** Who answers a target, as the sheet names it. A deleted backend has no name left. */
export function backendLabel(
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

export function modelCostLabel(cost: ModelCost, t: (key: string) => string): string {
  if (cost.kind === 'onDevice') {
    return t('modelChat.details.noCost');
  }
  if (cost.kind === 'unknown') {
    return t('modelChat.details.costUnknown');
  }
  return formatCost(cost.usd);
}

/** A target the backends no longer resolve sends no tools, so it has none to show. */
function supportsTools(model: string): boolean {
  try {
    return targetSupportsTools(model);
  } catch {
    return false;
  }
}

export function ModelsSection({
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

export function ToolsSection({
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
