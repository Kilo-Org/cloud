import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { ScreenHeader } from '@/components/screen-header';
import { SshBackupLoading } from '@/components/ssh/backup-loading';
import {
  SshBackupConflicts,
  SshBackupOutcome,
  SshBackupSummary,
} from '@/components/ssh/backup-summary';
import { SshStorageError } from '@/components/ssh/ssh-storage-error';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Download, FileText, Lock } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { SSH_HOSTS_ROUTE } from '@/lib/ssh/routes';
import { useSshBackupImport } from '@/lib/ssh/use-backup-import';

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
  const state = useSshBackupImport(dev);
  const { existing, shownPlan, shownFailure } = state;
  const fileFailure = shownFailure === 'file' || shownFailure === 'invalid_export';
  const fieldFailure = shownFailure === 'wrong_passphrase';
  const operationFailure = shownFailure !== null && !fileFailure && !fieldFailure;
  let body: ReactNode = null;
  if (existing.isPending || dev === 'loading') {
    body = <SshBackupLoading exporting={false} />;
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
        <View className="gap-1.5">
          <Button
            variant="outline"
            className={STATE_ACTION_CLASS}
            disabled={state.busy}
            onPress={() => void state.pickFile()}
          >
            <FileText size={16} color={colors.foreground} />
            <Text>{t('ssh.import.chooseFile')}</Text>
          </Button>
          <AccessibleStatus
            tone={fileFailure ? 'error' : 'status'}
            className="min-h-10 text-sm"
            message={
              fileFailure
                ? t(ERROR_COPY[shownFailure])
                : (state.shownFilename ?? t('ssh.backup.noFile'))
            }
          />
        </View>
        {shownPlan === null ? (
          <View className="gap-4">
            <FormField
              label={t('ssh.session.passphrase')}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              disabled={state.busy}
              error={fieldFailure ? t('ssh.backup.wrongPassphrase') : undefined}
              reserveErrorMessages={[t('ssh.backup.wrongPassphrase')]}
              onChangeText={state.handlePassphraseChange}
            />
            <Button
              className={STATE_ACTION_CLASS}
              disabled={
                state.busy ||
                state.shownFilename === null ||
                !state.hasPassphrase ||
                shownFailure === 'invalid_export'
              }
              onPress={() => void state.preview()}
            >
              <View className="h-5 w-5 items-center justify-center">
                {state.busy ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <Lock size={16} color={colors.primaryForeground} />
                )}
              </View>
              <Text>{t('ssh.backup.unlock')}</Text>
            </Button>
          </View>
        ) : (
          <View className="gap-5">
            <SshBackupOutcome plan={shownPlan} />
            {state.nothingNew ? (
              <Text className="text-sm text-muted-foreground">{t('ssh.backup.nothingNew')}</Text>
            ) : null}
            <Button
              className={STATE_ACTION_CLASS}
              disabled={state.busy || state.nothingNew}
              onPress={() => void state.importBackup()}
            >
              <View className="h-5 w-5 items-center justify-center">
                {state.busy ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <Download size={16} color={colors.primaryForeground} />
                )}
              </View>
              <Text>{t('ssh.backup.apply')}</Text>
            </Button>
            <SshBackupSummary backup={shownPlan.incoming} />
            <SshBackupConflicts plan={shownPlan} />
          </View>
        )}
        <View className="min-h-12">
          <AccessibleStatus
            message={operationFailure ? t(ERROR_COPY[shownFailure]) : null}
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
