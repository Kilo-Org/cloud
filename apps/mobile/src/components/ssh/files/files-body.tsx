import { FlashList } from '@shopify/flash-list';
import { type SftpEntry } from '../../../../modules/kilo-ssh/src';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { FileRow } from '@/components/ssh/files/file-row';
import { Button } from '@/components/ui/button';
import { FolderOpen } from '@/components/ui/icons';
import { RefreshControl } from '@/components/ui/refresh-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { transferErrorMessage } from '@/lib/ssh/files/error-copy';
import { type SftpBrowserPhase } from '@/lib/ssh/files/use-sftp-browser';
import { type SshSession } from '@/lib/ssh/session/types';

const SKELETON_ROWS = [0, 1, 2, 3, 4];

type FilesBodyProps = Readonly<{
  session: SshSession | null;
  /** The session's connection; null while the chain is not open. */
  connectionId: string | null;
  phase: SftpBrowserPhase;
  entries: readonly SftpEntry[];
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onRetry: () => void;
  onUpload: () => void;
  onOpen: (entry: SftpEntry) => void;
  onLongPress: (entry: SftpEntry) => void;
  onBackToHosts: () => void;
}>;

/** The list and the states around it: waiting, loading, empty, error, rows. */
export function FilesBody({
  session,
  connectionId,
  phase,
  entries,
  loading,
  refreshing,
  onRefresh,
  onRetry,
  onUpload,
  onOpen,
  onLongPress,
  onBackToHosts,
}: FilesBodyProps) {
  const { t } = useTranslation();

  if (session === null) {
    return (
      <EmptyState
        icon={FolderOpen}
        title={t('ssh.session.closedTitle')}
        description={t('ssh.session.closedDescription')}
        action={
          <Button className={STATE_ACTION_CLASS} onPress={onBackToHosts}>
            <Text>{t('ssh.session.backToHosts')}</Text>
          </Button>
        }
      />
    );
  }

  if (connectionId === null) {
    return session.phase.kind === 'closed' ? (
      <EmptyState
        icon={FolderOpen}
        title={t('ssh.session.closedTitle')}
        description={t('ssh.session.closedDescription')}
        action={
          <Button variant="outline" className={STATE_ACTION_CLASS} onPress={onBackToHosts}>
            <Text>{t('ssh.session.backToHosts')}</Text>
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={FolderOpen}
        title={t('ssh.files.waitingTitle')}
        description={t('ssh.files.waitingDescription')}
      />
    );
  }

  if (phase.kind === 'error') {
    return (
      <EmptyState
        icon={FolderOpen}
        title={t('ssh.files.errorTitle')}
        description={transferErrorMessage(t, phase.code)}
        action={
          <Button variant="outline" className={STATE_ACTION_CLASS} onPress={onRetry}>
            <Text>{t('common.retry')}</Text>
          </Button>
        }
      />
    );
  }

  if (phase.kind === 'opening' || (loading && entries.length === 0)) {
    return (
      <View className="gap-2 px-4 pt-2">
        {SKELETON_ROWS.map(row => (
          <Skeleton key={row} className="h-[58px] rounded-xl" />
        ))}
      </View>
    );
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        placement="top"
        icon={FolderOpen}
        title={t('ssh.files.emptyTitle')}
        description={t('ssh.files.emptyDescription')}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        action={
          <Button className={STATE_ACTION_CLASS} onPress={onUpload}>
            <Text>{t('ssh.files.upload')}</Text>
          </Button>
        }
      />
    );
  }

  return (
    <FlashList
      data={entries}
      keyExtractor={entry => entry.name}
      contentContainerClassName="gap-2 px-4 py-2"
      showsVerticalScrollIndicator={false}
      refreshing={refreshing}
      onRefresh={onRefresh}
      renderItem={({ item }) => (
        <FileRow
          entry={item}
          onPress={() => {
            onOpen(item);
          }}
          onLongPress={() => {
            onLongPress(item);
          }}
        />
      )}
    />
  );
}
