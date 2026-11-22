import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { type NativeAvailability } from '@/lib/chat/native-model-client';
import { type LocalModelStatus, useLocalModels } from '@/lib/chat/local-models';
import { toolArgumentDisplayName, toolDisplayName } from '@/lib/chat/tool-display-name';
import { useOfferedTools } from '@/lib/chat/use-offered-tools';
import { useOrganization } from '@/lib/organization-context';

import { BackendProviderChoice, type ProviderSelection } from './backend-provider-choices';
import { ModelDownloadControl } from './model-download-control';

const REASON_KEYS = {
  apple: {
    apple_intelligence_disabled: 'modelChat.localModels.reasons.appleIntelligenceDisabled',
    device_not_eligible: 'modelChat.localModels.reasons.deviceNotEligible',
    model_not_ready: 'modelChat.localModels.reasons.modelNotReady',
    check_failed: 'modelChat.localModels.reasons.checkFailed',
    unsupported_os: 'modelChat.localModels.reasons.unsupportedOs',
  },
  android: {
    unsupported_os: 'modelChat.localModels.reasons.androidUnsupportedOs',
    model_unavailable: 'modelChat.localModels.reasons.androidModelUnavailable',
    aicore_incompatible: 'modelChat.localModels.reasons.aicoreUpdateRequired',
    system_update_required: 'modelChat.localModels.reasons.aicoreUpdateRequired',
    check_failed: 'modelChat.localModels.reasons.checkFailed',
  },
} as const satisfies Record<LocalModelStatus['provider'], Record<string, string>>;

/** A model the system can still fetch is explained by its status, whatever reason rides along. */
const PENDING_STATUS_KEYS = {
  downloadable: 'modelChat.localModels.reasons.downloadable',
  downloading: 'modelChat.localModels.reasons.downloading',
} as const satisfies Record<'downloadable' | 'downloading', string>;

function reasonKeyOf(
  availability: NativeAvailability,
  provider: LocalModelStatus['provider']
): string | undefined {
  const { status, reason } = availability;
  if (status === 'available') {
    return undefined;
  }
  if (status !== 'unavailable') {
    return PENDING_STATUS_KEYS[status];
  }
  const keys = REASON_KEYS[provider];
  const match = Object.entries(keys).find(([code]) => code === reason);
  return match?.[1] ?? 'modelChat.localModels.reasons.unknown';
}

function LocalModelRow({
  status,
  ...selection
}: Readonly<{ status: LocalModelStatus }> & ProviderSelection) {
  const { t } = useTranslation();
  const { availability, toolUse } = status;
  let statusKey: string | undefined = 'modelChat.localModels.notAvailable';
  if (availability === undefined) {
    statusKey = 'modelChat.localModels.checking';
  } else if (availability.status === 'available') {
    statusKey = 'modelChat.localModels.ready';
  } else if (availability.status !== 'unavailable') {
    // A model the system can still fetch is not "not available": its reason line says so.
    statusKey = undefined;
  }
  const reasonKey =
    availability === undefined ? undefined : reasonKeyOf(availability, status.provider);
  return (
    <View className="gap-1 rounded-xl border border-border p-4">
      <BackendProviderChoice
        {...selection}
        name={t(status.nameKey)}
        description={t('modelChat.localModels.systemPurpose')}
        modelId={availability?.status === 'available' ? status.targetId : undefined}
      />
      {statusKey !== undefined && <Text className="text-sm">{t(statusKey)}</Text>}
      {reasonKey !== undefined && (
        <Text className="text-sm text-muted-foreground">{t(reasonKey)}</Text>
      )}
      {toolUse.kind === 'some' && toolUse.tools.length > 0 && (
        <Text
          testID={`local-model-unusable-${status.provider}`}
          className="text-sm text-muted-foreground"
        >
          {t('modelChat.localModels.cannotUse', {
            items: toolUse.tools.map(toolDisplayName).join(t('common.listJoiner')),
          })}
        </Text>
      )}
      {toolUse.kind === 'some' && toolUse.arguments.length > 0 && (
        <Text
          testID={`local-model-unusable-arguments-${status.provider}`}
          className="text-sm text-muted-foreground"
        >
          {t('modelChat.localModels.cannotUseOptions', {
            items: toolUse.arguments
              .map(one => toolArgumentDisplayName(one.tool, one.argument))
              .join(t('common.listJoiner')),
          })}
        </Text>
      )}
      <ModelDownloadControl status={status} />
    </View>
  );
}

/**
 * The system providers this build registers, each with its availability, the
 * tools it cannot run and its download control.
 *
 * `statuses` is the seam a capture or a proof injects a status through: the real
 * store never reports an available Apple model on a machine without one, so the
 * row's own copy is measured on a device that refuses nothing. Without it the
 * registered providers answer.
 */
export function LocalModelSection({
  statuses,
  ...selection
}: Readonly<{ statuses?: readonly LocalModelStatus[] }> & ProviderSelection) {
  const { organizationId } = useOrganization();
  const offered = useOfferedTools(organizationId ?? undefined);
  const stored = useLocalModels(offered);
  const localModels = statuses ?? stored;
  if (localModels.length === 0) {
    return null;
  }
  return (
    <View className="gap-2">
      {localModels.map(status => (
        <LocalModelRow key={status.provider} status={status} {...selection} />
      ))}
    </View>
  );
}
