import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { BACKUP_COLLECTIONS, type SshBackup } from '@/lib/ssh/backup-payload';
import { type SshBackupPlan } from '@/lib/ssh/backup-merge';

const COLLECTION_COPY = {
  hosts: 'ssh.backup.counts.hosts',
  keys: 'ssh.backup.counts.keys',
  knownHosts: 'ssh.knownHosts.title',
  snippets: 'ssh.backup.counts.snippets',
  forwards: 'ssh.forwards.title',
} as const;
export function SshBackupSummary({ backup, plan }: { backup: SshBackup; plan?: SshBackupPlan }) {
  const { t } = useTranslation();
  return (
    <View className="gap-4">
      <View className="gap-3 rounded-xl border border-border bg-card p-4">
        <Text className="font-semibold">{t('ssh.backup.previewTitle')}</Text>
        {BACKUP_COLLECTIONS.map(collection => (
          <View key={collection} className="flex-row items-center justify-between gap-4">
            <Text className="flex-1 text-sm text-muted-foreground">
              {t(COLLECTION_COPY[collection])}
            </Text>
            <Text className="text-sm tabular-nums">{backup[collection].length}</Text>
          </View>
        ))}
      </View>
      {plan ? (
        <View className="gap-2">
          <Text className="font-medium">{t('ssh.backup.mergeStrategy')}</Text>
          <Text className="text-sm text-muted-foreground">{t('ssh.backup.mergeDescription')}</Text>
          {plan.conflicts.length > 0 ? (
            <View className="gap-2 rounded-xl border border-border p-4">
              <Text className="font-medium">{t('ssh.backup.conflicts')}</Text>
              {plan.conflicts.map((conflict, index) => (
                <View key={`${conflict.collection}-${index}`} className="gap-0.5">
                  <Text className="text-sm" numberOfLines={2}>
                    {conflict.label}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {t(COLLECTION_COPY[conflict.collection])}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
