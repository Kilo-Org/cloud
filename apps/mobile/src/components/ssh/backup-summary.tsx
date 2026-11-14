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

export function SshBackupSummary({ backup }: { backup: SshBackup }) {
  const { t } = useTranslation();
  return (
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
  );
}

export function SshBackupOutcome({ plan }: { plan: SshBackupPlan }) {
  const { t } = useTranslation();
  let added = 0;
  for (const collection of BACKUP_COLLECTIONS) {
    added += plan.additions[collection].length;
  }
  const outcomes = [
    { label: 'profiles.importConfigAdded', count: added },
    { label: 'ssh.backup.toSkip', count: plan.conflicts.length },
  ];
  return (
    <View className="gap-3 rounded-xl border border-border bg-card p-4">
      <Text className="font-semibold">{t('ssh.backup.outcomeTitle')}</Text>
      {outcomes.map(outcome => (
        <View key={outcome.label} className="flex-row items-center justify-between gap-4">
          <Text className="flex-1 text-sm text-muted-foreground">{t(outcome.label)}</Text>
          <Text className="text-sm tabular-nums">{outcome.count}</Text>
        </View>
      ))}
    </View>
  );
}

export function SshBackupConflicts({ plan }: { plan: SshBackupPlan }) {
  const { t } = useTranslation();
  return (
    <View className="gap-4">
      <View className="gap-2">
        <Text className="font-medium">{t('ssh.backup.mergeStrategy')}</Text>
        <Text className="text-sm text-muted-foreground">{t('ssh.backup.mergeDescription')}</Text>
      </View>
      {plan.conflicts.length > 0 ? (
        <View className="gap-3 rounded-xl border border-border bg-card p-4">
          <Text className="font-semibold">{t('ssh.backup.conflicts')}</Text>
          {BACKUP_COLLECTIONS.map(collection => {
            const conflicts = plan.conflicts.filter(conflict => conflict.collection === collection);
            if (conflicts.length === 0) {
              return null;
            }
            return (
              <View key={collection} className="gap-2">
                <Text className="text-xs text-muted-foreground">
                  {t(COLLECTION_COPY[collection])}
                </Text>
                {conflicts.map((conflict, index) => (
                  <Text key={`${collection}-${index}`} className="text-sm" numberOfLines={2}>
                    {conflict.label}
                  </Text>
                ))}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
