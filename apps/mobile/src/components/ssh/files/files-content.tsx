import { type SftpEntry } from '../../../../modules/kilo-ssh/src';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { BreadcrumbBar } from '@/components/ssh/files/breadcrumb-bar';
import { FilesBody } from '@/components/ssh/files/files-body';
import { TransfersTray } from '@/components/ssh/files/transfers-tray';
import { ArrowUp } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/icon-button';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { shareLocalFile } from '@/lib/share-remote-file';
import { breadcrumbTrail, parentRemotePath } from '@/lib/ssh/files/paths';
import {
  cancelTransfer,
  clearFinishedTransfers,
  downloadedFileUri,
  retryTransfer,
  type SshTransfer,
} from '@/lib/ssh/files/transfers';
import { type SftpBrowserPhase } from '@/lib/ssh/files/use-sftp-browser';
import { type SshSession } from '@/lib/ssh/session/types';

type FilesContentViewProps = Readonly<{
  session: SshSession | null;
  connectionId: string | null;
  /** The directory on screen; null until the home directory resolved. */
  path: string | null;
  phase: SftpBrowserPhase;
  entries: readonly SftpEntry[];
  loading: boolean;
  refreshing: boolean;
  transfers: readonly SshTransfer[];
  onRefresh: () => void;
  onUpload: () => void;
  onOpen: (entry: SftpEntry) => void;
  onLongPress: (entry: SftpEntry) => void;
  onBackToHosts: () => void;
  onOpenPath: (path: string) => void;
}>;

/** The path bar, the list and the transfers tray between the header and the overlays. */
export function FilesContentView({
  session,
  connectionId,
  path,
  phase,
  entries,
  loading,
  refreshing,
  transfers,
  onRefresh,
  onUpload,
  onOpen,
  onLongPress,
  onBackToHosts,
  onOpenPath,
}: FilesContentViewProps) {
  const { t } = useTranslation();

  return (
    <>
      {path === null ? null : <PathBar path={path} onOpenPath={onOpenPath} />}

      <View className="flex-1">
        <FilesBody
          session={session}
          connectionId={connectionId}
          phase={phase}
          entries={entries}
          loading={loading}
          refreshing={refreshing}
          onRefresh={onRefresh}
          onRetry={onRefresh}
          onUpload={onUpload}
          onOpen={onOpen}
          onLongPress={onLongPress}
          onBackToHosts={onBackToHosts}
        />
      </View>

      <TransfersTray
        transfers={transfers}
        onCancel={cancelTransfer}
        onRetry={retryTransfer}
        onShare={transfer => {
          const uri = downloadedFileUri(transfer);
          if (uri !== null) {
            void (async () => {
              try {
                await shareLocalFile(uri);
              } catch {
                toast.error(t('ssh.files.shareFailed'));
              }
            })();
          }
        }}
        onClear={clearFinishedTransfers}
      />
    </>
  );
}

function PathBar({
  path,
  onOpenPath,
}: Readonly<{ path: string; onOpenPath: (path: string) => void }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <View className="flex-row items-center">
      {path === '/' ? null : (
        <IconButton
          accessibilityLabel={t('ssh.files.goUp')}
          onPress={() => {
            onOpenPath(parentRemotePath(path));
          }}
        >
          <ArrowUp size={18} color={colors.mutedForeground} />
        </IconButton>
      )}
      <View className="min-w-0 flex-1">
        <BreadcrumbBar trail={breadcrumbTrail(path)} onOpen={onOpenPath} />
      </View>
    </View>
  );
}
