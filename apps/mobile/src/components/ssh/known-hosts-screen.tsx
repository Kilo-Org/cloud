import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { SshStorageError } from '@/components/ssh/ssh-storage-error';
import { useConfirmDialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { KeyRound, Trash2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { formatDate } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { hostPatternDisplay } from '@/lib/ssh/known-host-pattern';
import { type SshKnownHost } from '@/lib/ssh/known-hosts';
import { SSH_HOSTS_ROUTE } from '@/lib/ssh/routes';
import { useSshKnownHostMutations, useSshKnownHosts } from '@/lib/ssh/use-ssh';

const SKELETON_ROWS = [0, 1, 2];

type KnownHostRowProps = Readonly<{
  entry: SshKnownHost;
  disabled: boolean;
  onDelete: () => void;
}>;

function KnownHostRow({ entry, disabled, onDelete }: KnownHostRowProps) {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const added = formatDate(new Date(entry.addedAt), i18n.language);

  return (
    <View className="flex-row items-center gap-3 rounded-lg bg-secondary px-4 py-3">
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {hostPatternDisplay(entry.hostPattern)}
        </Text>
        <Text variant="mono" className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
          {entry.fingerprintSha256}
        </Text>
        <View className="mt-0.5 flex-row items-center gap-1.5">
          <Text className="text-xs text-muted-foreground">{entry.keyAlgorithm}</Text>
          <Text className="text-xs text-muted-foreground">·</Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {t('profile.passkeyAddedOn', { date: added })}
          </Text>
        </View>
      </View>
      <IconButton
        accessibilityLabel={t('ssh.knownHosts.deleteLabel', { pattern: entry.hostPattern })}
        disabled={disabled}
        onPress={onDelete}
      >
        <Trash2 size={16} color={colors.mutedForeground} />
      </IconButton>
    </View>
  );
}

/** The host keys the app trusts: what it will accept, and how to forget one. */
export function SshKnownHostsScreen() {
  const { t } = useTranslation();
  const knownHosts = useSshKnownHosts();
  const { remove } = useSshKnownHostMutations();
  const { confirm, dialog } = useConfirmDialog();

  function confirmDelete(entry: SshKnownHost) {
    confirm({
      title: t('ssh.knownHosts.deleteTitle', { pattern: entry.hostPattern }),
      message: t('ssh.knownHosts.deleteMessage'),
      confirmLabel: t('common.remove'),
      onConfirm: () => {
        remove.mutate(entry.id, {
          onError: () => {
            toast.error(t('ssh.knownHosts.deleteFailed'));
          },
        });
      },
    });
  }

  let body: ReactNode = null;
  if (knownHosts.isPending) {
    body = (
      <View className="gap-2 px-4 pt-4">
        {SKELETON_ROWS.map(row => (
          <Skeleton key={row} className="h-[86px] rounded-lg" />
        ))}
      </View>
    );
  } else if (knownHosts.isError) {
    body = (
      <SshStorageError
        error={knownHosts.error}
        onRetry={() => void knownHosts.refetch()}
        isRetrying={knownHosts.isFetching}
      />
    );
  } else if (knownHosts.data.length === 0) {
    body = (
      <EmptyState
        icon={KeyRound}
        title={t('ssh.knownHosts.emptyTitle')}
        description={t('ssh.knownHosts.emptyDescription')}
      />
    );
  } else {
    body = (
      <DetailScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-2 px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {knownHosts.data.map(entry => (
          <KnownHostRow
            key={entry.id}
            entry={entry}
            disabled={remove.isPending}
            onDelete={() => {
              confirmDelete(entry);
            }}
          />
        ))}
      </DetailScreenScrollView>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('ssh.knownHosts.title')} backFallback={SSH_HOSTS_ROUTE} />
      {body}
      {dialog}
    </View>
  );
}
