import { type TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ImportPreviewRow } from '@/components/ssh/import-preview-row';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import {
  type SshConfigPlan,
  type SshConfigSkippedHost,
} from '@/lib/ssh/config-import';

function skipMessage(t: TFunction, skipped: SshConfigSkippedHost): string {
  return skipped.reason === 'noUsername'
    ? t('ssh.import.skippedNoUsername', { alias: skipped.alias })
    : t('ssh.import.skippedInvalidPort', { alias: skipped.alias });
}

type SshConfigImportPreviewProps = Readonly<{
  plan: SshConfigPlan;
  /** The aliases the person unchecked. */
  unchecked: ReadonlySet<string>;
  onToggle: (alias: string) => void;
  importing: boolean;
  canImport: boolean;
  onImport: () => void;
}>;

/** What the config describes, one row per host, with the import itself last. */
export function SshConfigImportPreview({
  plan,
  unchecked,
  onToggle,
  importing,
  canImport,
  onImport,
}: SshConfigImportPreviewProps) {
  const { t } = useTranslation();

  return (
    <View className="gap-4">
      <View className="gap-2">
        {plan.hosts.map(draft => (
          <ImportPreviewRow
            key={draft.alias}
            draft={draft}
            checked={!unchecked.has(draft.alias)}
            onToggle={() => {
              onToggle(draft.alias);
            }}
          />
        ))}
        {plan.hosts.length === 0 ? (
          <Text className="text-sm text-muted-foreground">{t('ssh.import.nothingDescription')}</Text>
        ) : null}
      </View>

      {plan.skipped.length > 0 ? (
        <View className="gap-1">
          <Text className="text-xs font-semibold uppercase text-muted-foreground">
            {t('ssh.import.notImported')}
          </Text>
          {plan.skipped.map(skipped => (
            <Text key={skipped.alias} className="text-xs text-muted-foreground">
              {skipMessage(t, skipped)}
            </Text>
          ))}
        </View>
      ) : null}

      <Button
        className={STATE_ACTION_CLASS}
        loading={importing}
        disabled={importing || !canImport}
        onPress={onImport}
      >
        <Text>{t('ssh.import.apply')}</Text>
      </Button>
    </View>
  );
}
