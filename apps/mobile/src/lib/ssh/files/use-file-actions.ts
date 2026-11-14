import { type SftpEntry } from '../../../../modules/kilo-ssh/src';
import { File } from 'expo-file-system';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { type ConfirmDialogRequest } from '@/components/ui/dialog';
import { shareLocalFile } from '@/lib/share-remote-file';

import { type FilePreview } from '@/components/ssh/files/file-preview-sheet';
import { trackSshSftpTransfer } from '../analytics';
import { nativeErrorCode, sshPackage } from '../native';
import { joinRemotePath, previewKindOf } from './paths';
import { allocatePreviewCache, type PreviewCacheFile, sweepPreviewCache } from './preview-cache';
import {
  downloadedFileUri,
  type SshTransfer,
  startDownload,
  startUpload,
  subscribeTransfers,
  transfersForSession,
  transfersSnapshot,
} from './transfers';
import { pickDocuments, pickPhotos } from './uploads';

type FileActionsInput = Readonly<{
  sessionId: string;
  /** The open SFTP channel, or null before it resolved. */
  sftpId: string | null;
  path: string | null;
  entries: readonly SftpEntry[];
  onNavigate: (path: string) => void;
  onChanged: () => void;
  confirm: (request: ConfirmDialogRequest) => void;
}>;

/**
 * Everything the file list does to the remote directory: preview, share,
 * rename, delete, upload, and the transfers those operations start. The screen
 * owns only what it renders.
 */
export function useFileActions({
  sessionId,
  sftpId,
  path,
  entries,
  onNavigate,
  onChanged,
  confirm,
}: FileActionsInput) {
  const { t } = useTranslation();
  const previewRequest = useRef(0);
  const previewCache = useRef<PreviewCacheFile | null>(null);

  function dropPreviewCache() {
    previewCache.current?.release();
    previewCache.current = null;
  }

  useEffect(() => {
    sweepPreviewCache();
  }, []);

  useEffect(
    () => () => {
      previewRequest.current += 1;
    },
    [sftpId]
  );

  useEffect(
    () => () => {
      previewCache.current?.release();
      previewCache.current = null;
    },
    []
  );
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingShare, setPendingShare] = useState<string | null>(null);
  const [pendingRetry, setPendingRetry] = useState<string | null>(null);
  const transfers = useSessionTransfers(sessionId);

  const remotePathOf = (entry: Pick<SftpEntry, 'name'>): string =>
    joinRemotePath(path ?? '/', entry.name);

  // A share downloads into the tray first: the row shows the progress, and the
  // system sheet opens once the bytes are on the device.
  useEffect(() => {
    if (pendingShare === null) {
      return;
    }
    const transfer = transfersForSession(transfers, sessionId).find(
      candidate => candidate.id === pendingShare
    );
    if (transfer === undefined || transfer.status === 'active') {
      return;
    }
    setPendingShare(null);
    const uri = downloadedFileUri(transfer);
    if (transfer.status !== 'done' || uri === null) {
      return;
    }
    void (async () => {
      try {
        await shareLocalFile(uri);
      } catch {
        toast.error(t('ssh.files.shareFailed'));
      }
    })();
  }, [pendingShare, transfers, sessionId, t]);

  function openEntry(entry: SftpEntry) {
    if (entry.kind === 'directory') {
      onNavigate(remotePathOf(entry));
      return;
    }
    void openPreview(entry);
  }

  async function openPreview(entry: SftpEntry) {
    previewRequest.current += 1;
    const request = previewRequest.current;
    const kind = previewKindOf(entry);
    if (kind === null || sftpId === null) {
      setPendingRetry(null);
      return;
    }
    dropPreviewCache();
    const base = {
      name: entry.name,
      kind,
      loading: true,
      code: null,
      uri: null,
      text: null,
    } satisfies FilePreview;
    setPreview(base);
    setPendingRetry(remotePathOf(entry));
    let cache: PreviewCacheFile | null = null;
    let downloaded = false;
    try {
      const ssh = await sshPackage();
      if (request !== previewRequest.current) {
        return;
      }
      const allocated = allocatePreviewCache(entry.name);
      cache = allocated;
      previewCache.current = allocated;
      await ssh.download(sftpId, remotePathOf(entry), allocated.uri);
      downloaded = true;
      trackSshSftpTransfer('download', 'completed', null);
      if (request !== previewRequest.current) {
        allocated.release();
        return;
      }
      if (kind === 'image') {
        setPreview({ ...base, loading: false, uri: allocated.uri });
        return;
      }
      const text = await new File(allocated.uri).text();
      if (request === previewRequest.current) {
        setPreview({ ...base, loading: false, text });
      } else {
        allocated.release();
      }
    } catch (error) {
      const nativeCode = nativeErrorCode(error);
      const code = nativeCode ?? 'Protocol';
      if (!downloaded) {
        trackSshSftpTransfer('download', 'failed', nativeCode);
      }
      cache?.release();
      if (request === previewRequest.current) {
        setPreview({ ...base, loading: false, code });
      }
    }
  }

  function retryPreview() {
    const remotePath = pendingRetry;
    const entry = entries.find(candidate => remotePath === remotePathOf(candidate));
    setPreview(null);
    if (entry === undefined) {
      dropPreviewCache();
      return;
    }
    void openPreview(entry);
  }

  function shareFile(name: string) {
    if (sftpId === null) {
      return;
    }
    setPendingShare(
      startDownload({ sessionId, sftpId, remotePath: joinRemotePath(path ?? '/', name), name })
    );
  }

  function uploadPicked(assets: readonly { uri: string; name: string }[]) {
    if (sftpId === null) {
      return;
    }
    for (const asset of assets) {
      startUpload({
        sessionId,
        sftpId,
        localUri: asset.uri,
        remotePath: joinRemotePath(path ?? '/', asset.name),
        name: asset.name,
      });
    }
  }

  async function pick(source: 'files' | 'photos') {
    try {
      const picked = source === 'files' ? await pickDocuments() : await pickPhotos();
      if (picked !== null) {
        uploadPicked(picked);
      }
    } catch {
      toast.error(t('ssh.files.pickFailed'));
    }
  }

  async function apply(action: () => Promise<void>, failureCopy: string): Promise<void> {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch {
      toast.error(failureCopy);
    } finally {
      setBusy(false);
    }
  }

  async function renameEntry(entry: SftpEntry, name: string): Promise<void> {
    if (sftpId === null) {
      return;
    }
    await apply(async () => {
      const ssh = await sshPackage();
      await ssh.renamePath(sftpId, remotePathOf(entry), joinRemotePath(path ?? '/', name));
    }, t('ssh.files.renameFailed'));
  }

  async function createFolder(name: string): Promise<void> {
    if (sftpId === null) {
      return;
    }
    await apply(async () => {
      const ssh = await sshPackage();
      await ssh.makeDirectory(sftpId, joinRemotePath(path ?? '/', name));
    }, t('ssh.files.createFolderFailed'));
  }

  function confirmDelete(entry: SftpEntry) {
    if (sftpId === null) {
      return;
    }
    const directory = entry.kind === 'directory';
    confirm({
      title: t('ssh.files.deleteTitle', { name: entry.name }),
      message: directory ? t('ssh.files.deleteFolderMessage') : t('ssh.files.deleteFileMessage'),
      confirmLabel: t('common.delete'),
      onConfirm: () => {
        void apply(async () => {
          const ssh = await sshPackage();
          const removed = directory
            ? ssh.removeDirectory(sftpId, remotePathOf(entry))
            : ssh.removeFile(sftpId, remotePathOf(entry));
          await removed;
        }, t('ssh.files.deleteFailed'));
      },
    });
  }

  return {
    preview,
    busy,
    closePreview: () => {
      previewRequest.current += 1;
      dropPreviewCache();
      setPreview(null);
    },
    retryPreview,
    /** Dev fixtures only: a preview the gate photographs without a server. */
    showPreview: (next: FilePreview) => {
      previewRequest.current += 1;
      dropPreviewCache();
      setPreview(next);
    },
    openEntry,
    openPreview,
    shareFile,
    pick,
    renameEntry,
    createFolder,
    confirmDelete,
  };
}

/** The transfers of this session, newest first. */
export function useSessionTransfers(sessionId: string): readonly SshTransfer[] {
  const all = useSyncExternalStore(subscribeTransfers, transfersSnapshot, transfersSnapshot);
  return transfersForSession(all, sessionId);
}
