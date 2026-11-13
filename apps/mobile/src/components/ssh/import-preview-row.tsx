import { type TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { hostTarget } from '@/components/ssh/host-target';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Text } from '@/components/ui/text';
import { type SshConfigHostDraft, type SshConfigWarning } from '@/lib/ssh/config-import';

/** What the preview says about one warning it found in a host's block. */
function warningMessage(t: TFunction, warning: SshConfigWarning): string {
  if (warning.kind === 'jumpHostMissing') {
    return t('ssh.import.warnJumpMissing', { target: warning.target });
  }
  if (warning.kind === 'jumpHostCycle') {
    return t('ssh.import.warnJumpCycle', { target: warning.target });
  }
  if (warning.kind === 'jumpHostMultiHop') {
    return t('ssh.import.warnJumpMultiHop');
  }
  if (warning.kind === 'forwardUnsupported') {
    return t('ssh.import.warnForward');
  }
  return t('ssh.import.warnNeedsKey');
}

type ImportPreviewRowProps = Readonly<{
  draft: SshConfigHostDraft;
  checked: boolean;
  onToggle: () => void;
}>;

/** One host the import will create: what it is, and what needs attention. */
export function ImportPreviewRow({ draft, checked, onToggle }: ImportPreviewRowProps) {
  const { t } = useTranslation();
  const target = hostTarget(draft);
  const needsKey = draft.warnings.some(warning => warning.kind === 'needsKey');

  return (
    <View className="gap-1">
      <ChoiceRow
        multi
        selected={checked}
        onPress={onToggle}
        accessibleName={target}
        className="items-start"
      >
        <View className="min-w-0 flex-1 gap-1 pe-3">
          <View className="flex-row items-center gap-2">
            <Text className="shrink text-sm font-medium text-foreground" numberOfLines={1}>
              {draft.alias}
            </Text>
            {needsKey ? (
              <View className="rounded-full bg-warn px-2 py-0.5">
                <Text className="text-[10px] font-semibold uppercase leading-[normal] text-warn-foreground">
                  {t('ssh.import.needsKey')}
                </Text>
              </View>
            ) : null}
          </View>
          <Text variant="mono" className="text-xs text-muted-foreground" numberOfLines={1}>
            {target}
          </Text>
          {draft.warnings.map((warning, index) => (
            <Text key={`${warning.kind}-${String(index)}`} className="text-xs text-muted-foreground">
              {warningMessage(t, warning)}
            </Text>
          ))}
        </View>
      </ChoiceRow>
    </View>
  );
}
