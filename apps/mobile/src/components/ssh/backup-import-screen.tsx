import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useRouter } from 'expo-router';
import { type ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { ScreenHeader } from '@/components/screen-header';
import { SshBackupSummary } from '@/components/ssh/backup-summary';
import { SshStorageError } from '@/components/ssh/ssh-storage-error';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Button } from '@/components/ui/button';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { FileText } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { trackSshImport } from '@/lib/ssh/analytics';
import { openSshBackup, type SshBackupFailure, sshBackupFailure } from '@/lib/ssh/backup-file';
import { mergeSshBackup, planSshBackupMerge, type SshBackupPlan } from '@/lib/ssh/backup-merge';
import { BACKUP_COLLECTIONS } from '@/lib/ssh/backup-payload';
import { SSH_HOSTS_ROUTE } from '@/lib/ssh/routes';
import { sshDatabase } from '@/lib/ssh/store';
import { useSshBackup } from '@/lib/ssh/use-backup';
import { useSshInvalidation } from '@/lib/ssh/use-ssh';

const ERROR_COPY = {
  wrong_passphrase: 'ssh.backup.wrongPassphrase',
  invalid_export: 'ssh.backup.invalidExport',
  file: 'ssh.backup.fileError',
  storage: 'ssh.backup.storageError',
  unavailable: 'ssh.backup.unavailable',
} as const;

export function SshBackupImportScreen({ dev }: { dev?: string }) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const router = useRouter();
  const existing = useSshBackup();
  const invalidate = useSshInvalidation();
  const passphrase = useRef('');
  const armored = useRef<string | null>(null);
  const [hasPassphrase, setHasPassphrase] = useState(false);
  const [filename, setFilename] = useState<string | null>(null);
  const [plan, setPlan] = useState<SshBackupPlan | null>(null);
  const [failure, setFailure] = useState<SshBackupFailure | null>(null);
  const [busy, setBusy] = useState(false);
  let fixturePlan: SshBackupPlan | null = null;
  if (dev === 'preview' && existing.data !== undefined) {
    fixturePlan = planSshBackupMerge(existing.data, {
      ...existing.data,
      hosts: [],
      keys: [],
      knownHosts: [],
      snippets: [],
      forwards: [],
    });
  } else if (dev === 'conflicts' && existing.data !== undefined) {
    fixturePlan = planSshBackupMerge(existing.data, existing.data);
  }
  const shownPlan = plan ?? fixturePlan;
  let fixtureFailure: SshBackupFailure | null = null;
  if (dev === 'error') {
    fixtureFailure = 'wrong_passphrase';
  } else if (dev === 'invalid') {
    fixtureFailure = 'invalid_export';
  }
  const shownFailure = failure ?? fixtureFailure;
  const nothingNew =
    shownPlan !== null &&
    BACKUP_COLLECTIONS.every(collection => shownPlan.additions[collection].length === 0);

  async function pickFile() {
    setBusy(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });
      if (result.canceled) {
        trackSshImport('cancelled', null);
        return;
      }
      const asset = result.assets[0];
      if (asset === undefined) {
        return;
      }
      const file = new File(asset.uri);
      try {
        armored.current = await file.text();
      } finally {
        if (file.exists) {
          file.delete();
        }
      }
      setFilename(asset.name);
      if (plan !== null) {
        passphrase.current = '';
        setHasPassphrase(false);
      }
      setPlan(null);
      setFailure(null);
    } catch {
      armored.current = null;
      setFilename(null);
      setPlan(null);
      setFailure('file');
      trackSshImport('failed', 'local_io');
    } finally {
      setBusy(false);
    }
  }

  async function preview() {
    if (armored.current === null || existing.data === undefined || busy) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const backup = await openSshBackup(armored.current, passphrase.current);
      setPlan(planSshBackupMerge(backup, existing.data));
    } catch (error) {
      setFailure(sshBackupFailure(error));
      trackSshImport('failed', sshBackupFailure(error));
    } finally {
      setBusy(false);
    }
  }

  async function importBackup() {
    if (shownPlan === null || busy) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      mergeSshBackup(await sshDatabase(), shownPlan.incoming);
      trackSshImport('completed', null);
      await invalidate();
      toast.success(t('ssh.backup.imported'));
      router.replace(SSH_HOSTS_ROUTE);
    } catch {
      setFailure('storage');
      trackSshImport('failed', 'local_io');
    } finally {
      setBusy(false);
    }
  }

  let body: ReactNode = null;
  if (existing.isPending || dev === 'loading') {
    body = (
      <View className="gap-4 p-4">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-12 rounded-md" />
      </View>
    );
  } else if (existing.isError) {
    body = (
      <SshStorageError
        error={existing.error}
        onRetry={() => void existing.refetch()}
        isRetrying={existing.isFetching}
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
        <Text className="text-sm text-muted-foreground">{t('ssh.backup.importDescription')}</Text>
        <Button
          variant="outline"
          className={STATE_ACTION_CLASS}
          disabled={busy}
          onPress={() => void pickFile()}
        >
          <FileText size={16} color={colors.foreground} />
          <Text>{t('ssh.import.chooseFile')}</Text>
        </Button>
        <Text className="min-h-5 text-sm text-muted-foreground" numberOfLines={2}>
          {filename ?? ' '}
        </Text>
        {shownPlan === null ? (
          <View className="gap-4">
            <View className="gap-1.5">
              <FormFieldLabel label={t('ssh.session.passphrase')} />
              <Input
                accessibilityLabel={t('ssh.session.passphrase')}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                onChangeText={value => {
                  passphrase.current = value;
                  setHasPassphrase(value.length > 0);
                }}
              />
            </View>
            <Button
              className={STATE_ACTION_CLASS}
              disabled={busy || filename === null || !hasPassphrase || failure === 'invalid_export'}
              onPress={() => void preview()}
            >
              <View className="h-5 w-5 items-center justify-center">
                {busy ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <FileText size={16} color={colors.primaryForeground} />
                )}
              </View>
              <Text>{t('ssh.backup.unlock')}</Text>
            </Button>
          </View>
        ) : (
          <View className="gap-5">
            <SshBackupSummary backup={shownPlan.incoming} plan={shownPlan} />
            {nothingNew ? (
              <Text className="text-sm text-muted-foreground">{t('ssh.backup.nothingNew')}</Text>
            ) : null}
            <Button
              className={STATE_ACTION_CLASS}
              disabled={busy || nothingNew}
              onPress={() => void importBackup()}
            >
              <View className="h-5 w-5 items-center justify-center">
                {busy ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <FileText size={16} color={colors.primaryForeground} />
                )}
              </View>
              <Text>{t('ssh.backup.apply')}</Text>
            </Button>
          </View>
        )}
        <View className="min-h-16">
          <AccessibleStatus
            message={shownFailure === null ? null : t(ERROR_COPY[shownFailure])}
            className="text-sm"
          />
        </View>
      </DetailScreenScrollView>
    );
  }
  return (
    <View className="flex-1 bg-background" testID="ssh-backup-import">
      <ScreenHeader title={t('ssh.backup.importTitle')} backFallback={SSH_HOSTS_ROUTE} />
      {body}
    </View>
  );
}
