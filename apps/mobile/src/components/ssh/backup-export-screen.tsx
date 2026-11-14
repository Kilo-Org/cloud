import { useRouter } from 'expo-router';
import { type ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { SshBackupLoading } from '@/components/ssh/backup-loading';
import { SshBackupSummary } from '@/components/ssh/backup-summary';
import { SshStorageError } from '@/components/ssh/ssh-storage-error';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Lock, Server } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { trackSshExport } from '@/lib/ssh/analytics';
import { shareSshBackup, sshBackupFailure } from '@/lib/ssh/backup-file';
import { BACKUP_COLLECTIONS } from '@/lib/ssh/backup-payload';
import { SSH_HOST_NEW_ROUTE, SSH_HOSTS_ROUTE } from '@/lib/ssh/routes';
import { useSshBackup } from '@/lib/ssh/use-backup';

export function SshBackupExportScreen({ dev }: { dev?: string }) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const router = useRouter();
  const backup = useSshBackup();
  const passphrase = useRef('');
  const confirmation = useRef('');
  const [length, setLength] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmationTouched, setConfirmationTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const data = backup.data;
  const empty =
    data !== undefined && BACKUP_COLLECTIONS.every(collection => data[collection].length === 0);

  async function exportBackup() {
    if (
      backup.data === undefined ||
      busy ||
      passphrase.current.length < 8 ||
      passphrase.current !== confirmation.current
    ) {
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      await shareSshBackup(backup.data, passphrase.current);
      trackSshExport('completed', null);
    } catch (error) {
      trackSshExport('failed', sshBackupFailure(error));
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  let strengthKey = 'ssh.backup.strengthShort';
  if (length >= 12) {
    strengthKey = 'ssh.backup.strengthLong';
  } else if (length >= 8) {
    strengthKey = 'ssh.backup.strengthGood';
  }
  let body: ReactNode = null;
  if (backup.isPending || dev === 'loading') {
    body = <SshBackupLoading exporting />;
  } else if (backup.isError || dev === 'error') {
    body = (
      <SshStorageError
        error={backup.error ?? new Error('Backup fixture storage unavailable')}
        onRetry={() => void backup.refetch()}
        isRetrying={backup.isFetching}
      />
    );
  } else if (empty || dev === 'empty') {
    body = (
      <EmptyState
        icon={Server}
        title={t('ssh.backup.empty')}
        action={
          <Button
            className={STATE_ACTION_CLASS}
            onPress={() => {
              router.push(SSH_HOST_NEW_ROUTE);
            }}
          >
            <Text>{t('ssh.hosts.addHost')}</Text>
          </Button>
        }
      />
    );
  } else {
    body = (
      <DetailScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-5 px-4 pt-4"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        <Text className="text-sm text-muted-foreground">{t('ssh.backup.exportDescription')}</Text>
        <SshBackupSummary backup={backup.data} />
        <View className="gap-1.5">
          <FormField
            label={t('ssh.session.passphrase')}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            disabled={busy}
            onChangeText={value => {
              passphrase.current = value;
              setLength(value.length);
              setConfirmed(value === confirmation.current);
            }}
          />
          <Text className="min-h-10 text-sm text-muted-foreground">{t(strengthKey)}</Text>
        </View>
        <FormField
          label={t('ssh.backup.confirmPassphrase')}
          error={confirmationTouched && !confirmed ? t('ssh.backup.mismatch') : undefined}
          reserveErrorMessages={[t('ssh.backup.mismatch')]}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          disabled={busy}
          onChangeText={value => {
            confirmation.current = value;
            setConfirmationTouched(value.length > 0);
            setConfirmed(value === passphrase.current);
          }}
        />
        <Button
          className={STATE_ACTION_CLASS}
          disabled={busy || length < 8 || !confirmed}
          onPress={() => void exportBackup()}
        >
          <View className="h-5 w-5 items-center justify-center">
            {busy ? (
              <ActivityIndicator size="small" />
            ) : (
              <Lock size={16} color={colors.primaryForeground} />
            )}
          </View>
          <Text>{t('ssh.backup.share')}</Text>
        </Button>
        <View className="min-h-12">
          <AccessibleStatus
            message={failed ? t('ssh.backup.unavailable') : null}
            className="text-sm"
          />
        </View>
      </DetailScreenScrollView>
    );
  }
  return (
    <View className="flex-1 bg-background" testID="ssh-backup-export">
      <ScreenHeader title={t('ssh.backup.exportTitle')} backFallback={SSH_HOSTS_ROUTE} />
      {body}
    </View>
  );
}
