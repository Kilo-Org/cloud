import { type SftpEntry } from '@kilocode/react-native-ssh';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { FilesContentView } from '@/components/ssh/files/files-content';
import { FilesHeader } from '@/components/ssh/files/files-header';
import { type FileNameTarget, FilesSurfaces } from '@/components/ssh/files/files-surfaces';
import { useConfirmDialog } from '@/components/ui/dialog';
import { type MenuSheetOption } from '@/components/ui/menu-sheet';
import { collator } from '@/lib/intl-cache';
import { joinRemotePath, previewKindOf, sortEntries } from '@/lib/ssh/files/paths';
import { insertFixtureTransfers } from '@/lib/ssh/files/transfers';
import { useFileActions, useSessionTransfers } from '@/lib/ssh/files/use-file-actions';
import { useSftpBrowser } from '@/lib/ssh/files/use-sftp-browser';
import { SSH_HOSTS_ROUTE, sshSessionPath } from '@/lib/ssh/routes';
import { useSshSession } from '@/lib/ssh/session/use-sessions';

type SshFilesScreenProps = Readonly<{
  sessionId: string;
  /** A folder to open instead of the home directory. */
  initialPath?: string | null;
  /** Dev-only surface the design gate opens over the real screen. */
  dev?: 'transfers' | 'preview' | 'forwards' | null;
}>;

type DialogState = { mode: 'rename'; entry: SftpEntry } | { mode: 'create' };

/** The text the design gate opens in the preview sheet, with no server behind it. */
const FIXTURE_PREVIEW = {
  name: 'deploy.log',
  kind: 'text' as const,
  loading: false,
  code: null,
  uri: null,
  text: [
    'deploy@web-1:~$ ./deploy.sh',
    'Pulling image ghcr.io/kilo/web:2026.11.13',
    'Container web-1 started in 4.2s',
    'Health check passed after 3 attempts',
    'deploy@web-1:~$ ',
  ].join('\n'),
};

/**
 * The session's remote files: one SFTP channel on its connection, the directory
 * it shows, and the transfers this screen started.
 */
export function SshFilesScreen({ sessionId, initialPath = null, dev = null }: SshFilesScreenProps) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const session = useSshSession(sessionId);
  const connectionId = session?.nativeSessionId ?? null;
  const browser = useSftpBrowser(connectionId);
  const { confirm, dialog } = useConfirmDialog();
  const sessionTransfers = useSessionTransfers(sessionId);

  const [menuEntry, setMenuEntry] = useState<SftpEntry | null>(null);
  const [uploadSource, setUploadSource] = useState(false);
  const [forwardsOpen, setForwardsOpen] = useState(false);
  const [nameDialog, setNameDialog] = useState<DialogState | null>(null);
  const openedInitial = useRef(false);
  const previewFixtureShown = useRef(false);

  const entries = useMemo(
    () =>
      sortEntries(browser.entries, collator(i18n.language, { numeric: true, sensitivity: 'base' })),
    [browser.entries, i18n.language]
  );
  const currentPath = browser.path;
  const actions = useFileActions({
    sessionId,
    sftpId: browser.sftpId,
    path: currentPath,
    entries,
    onNavigate: browser.open,
    onChanged: browser.refresh,
    confirm,
  });

  // A link can name the folder to open; it is applied once, after the channel
  // resolved its home directory.
  useEffect(() => {
    if (initialPath === null || openedInitial.current || currentPath === null) {
      return;
    }
    openedInitial.current = true;
    if (currentPath !== initialPath) {
      browser.open(initialPath);
    }
  }, [initialPath, currentPath, browser]);

  useEffect(() => {
    if (dev === 'transfers') {
      insertFixtureTransfers(sessionId);
    }
    if (dev === 'forwards') {
      setForwardsOpen(true);
    }
  }, [dev, sessionId]);

  // The gate photographs a preview without a server behind it.
  useEffect(() => {
    if (dev !== 'preview' || previewFixtureShown.current) {
      return;
    }
    previewFixtureShown.current = true;
    actions.showPreview(FIXTURE_PREVIEW);
  }, [dev, actions]);

  function entryActions(entry: SftpEntry) {
    const options: MenuSheetOption[] = [];
    const run: (() => void)[] = [];
    if (entry.kind === 'directory') {
      options.push({ label: t('ssh.files.openFolder') });
      run.push(() => {
        browser.open(joinRemotePath(currentPath ?? '/', entry.name));
      });
    } else {
      if (previewKindOf(entry) !== null) {
        options.push({ label: t('ssh.files.preview') });
        run.push(() => {
          void actions.openPreview(entry);
        });
      }
      options.push({ label: t('ssh.files.share') });
      run.push(() => {
        actions.shareFile(entry.name);
      });
    }
    options.push({ label: t('common.rename') });
    run.push(() => {
      setNameDialog({ mode: 'rename', entry });
    });
    options.push({ label: t('common.delete'), destructive: true });
    run.push(() => {
      actions.confirmDelete(entry);
    });
    return { options, run };
  }

  const menu = menuEntry === null ? null : entryActions(menuEntry);

  return (
    <View className="flex-1 bg-background">
      <FilesHeader
        title={session?.label ?? t('ssh.files.title')}
        subtitle={currentPath ?? session?.target}
        backFallback={sshSessionPath(sessionId)}
        sessionReady={session !== null}
        folderReady={currentPath !== null}
        onForwards={() => {
          setForwardsOpen(true);
        }}
        onNewFolder={() => {
          setNameDialog({ mode: 'create' });
        }}
        onUpload={() => {
          setUploadSource(true);
        }}
      />

      <FilesContentView
        session={session}
        connectionId={connectionId}
        path={currentPath}
        phase={browser.phase}
        entries={entries}
        loading={browser.loading}
        refreshing={browser.refreshing}
        transfers={sessionTransfers}
        onRefresh={() => {
          browser.refresh();
        }}
        onUpload={() => {
          setUploadSource(true);
        }}
        onOpen={entry => {
          actions.openEntry(entry);
        }}
        onLongPress={setMenuEntry}
        onBackToHosts={() => {
          router.replace(SSH_HOSTS_ROUTE);
        }}
        onOpenPath={path => {
          browser.open(path);
        }}
      />

      <FilesSurfaces
        menuTitle={menuEntry?.name}
        menuOptions={menu?.options ?? []}
        menuVisible={menuEntry !== null}
        onMenuClose={() => {
          setMenuEntry(null);
        }}
        onMenuSelect={index => {
          const action = menu?.run[index];
          setMenuEntry(null);
          action?.();
        }}
        uploadVisible={uploadSource}
        onUploadClose={() => {
          setUploadSource(false);
        }}
        onPick={source => {
          setUploadSource(false);
          void actions.pick(source);
        }}
        nameDialog={nameTargetOf(nameDialog)}
        busy={actions.busy}
        onNameCancel={() => {
          setNameDialog(null);
        }}
        onNameSubmit={name => {
          const target = nameDialog;
          setNameDialog(null);
          if (target === null) {
            return;
          }
          if (target.mode === 'rename') {
            void actions.renameEntry(target.entry, name);
          } else {
            void actions.createFolder(name);
          }
        }}
        preview={actions.preview}
        onPreviewClose={() => {
          actions.closePreview();
        }}
        onPreviewShare={() => {
          if (actions.preview !== null) {
            actions.shareFile(actions.preview.name);
          }
        }}
        onPreviewRetry={() => {
          actions.retryPreview();
        }}
        forwards={
          session === null
            ? null
            : {
                visible: forwardsOpen,
                hostId: session.hostId,
                sessionId,
                nativeSessionId: connectionId,
              }
        }
        onForwardsClose={() => {
          setForwardsOpen(false);
        }}
        dialog={dialog}
      />
    </View>
  );
}

function nameTargetOf(dialog: DialogState | null): FileNameTarget | null {
  if (dialog === null) {
    return null;
  }
  return dialog.mode === 'rename'
    ? { mode: 'rename', entryName: dialog.entry.name }
    : { mode: 'create' };
}
