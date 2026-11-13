import type { SftpEntry, TransferOptions } from './ReactNativeSsh.types';
import ReactNativeSsh from './ReactNativeSshModule';
import { guard, SshError } from './errors';

/** Opens the SFTP subsystem on a new channel of the session. */
export function openSftp(sessionId: string): Promise<string> {
  return guard(() => ReactNativeSsh.openSftp(sessionId));
}

/** Ends the SFTP channel. Other channels of the session stay up. */
export function closeSftp(sftpId: string): Promise<void> {
  return guard(() => ReactNativeSsh.closeSftp(sftpId));
}

export function listDirectory(sftpId: string, path: string): Promise<SftpEntry[]> {
  return guard(() => ReactNativeSsh.sftpList(sftpId, path));
}

export function statPath(sftpId: string, path: string): Promise<SftpEntry> {
  return guard(() => ReactNativeSsh.sftpStat(sftpId, path));
}

/** Resolves symbolic links and `~` into an absolute server path. */
export function realpath(sftpId: string, path: string): Promise<string> {
  return guard(() => ReactNativeSsh.sftpRealpath(sftpId, path));
}

export function makeDirectory(sftpId: string, path: string): Promise<void> {
  return guard(() => ReactNativeSsh.sftpMkdir(sftpId, path));
}

export function renamePath(sftpId: string, from: string, to: string): Promise<void> {
  return guard(() => ReactNativeSsh.sftpRename(sftpId, from, to));
}

export function removeFile(sftpId: string, path: string): Promise<void> {
  return guard(() => ReactNativeSsh.sftpRemoveFile(sftpId, path));
}

export function removeDirectory(sftpId: string, path: string): Promise<void> {
  return guard(() => ReactNativeSsh.sftpRemoveDir(sftpId, path));
}

/**
 * Copies a remote file to `localFileUrl`, a `file://` URL in the app sandbox.
 * Resolves with the number of bytes written once the file is complete: an
 * interrupted transfer leaves nothing at `localFileUrl`.
 */
export function download(
  sftpId: string,
  remotePath: string,
  localFileUrl: string,
  options: TransferOptions = {}
): Promise<number> {
  return transfer(
    transferId => ReactNativeSsh.sftpDownload(sftpId, remotePath, localFileUrl, transferId),
    options
  );
}

/**
 * Copies a `file://` URL from the app sandbox to `remotePath`. Resolves with
 * the number of bytes read once the server has the complete file.
 */
export function upload(
  sftpId: string,
  localFileUrl: string,
  remotePath: string,
  options: TransferOptions = {}
): Promise<number> {
  return transfer(
    transferId => ReactNativeSsh.sftpUpload(sftpId, localFileUrl, remotePath, transferId),
    options
  );
}

let transfers = 0;

async function transfer(
  start: (transferId: string) => Promise<number>,
  options: TransferOptions
): Promise<number> {
  const signal = options.signal;
  const transferId = `transfer-${(transfers += 1)}`;
  const subscription = options.onProgress ? listen(transferId, options.onProgress) : undefined;
  const abort = () => ReactNativeSsh.cancelTransfer(transferId);
  signal?.addEventListener('abort', abort);

  try {
    // A signal aborted before this point never fires `abort`, and the native
    // cancel token does not exist until the call below runs: starting here
    // would transfer the whole file and resolve.
    if (signal?.aborted) {
      throw new SshError('Cancelled', 'The transfer was cancelled');
    }

    return await guard(() => start(transferId));
  } finally {
    subscription?.remove();
    signal?.removeEventListener('abort', abort);
  }
}

function listen(transferId: string, onProgress: NonNullable<TransferOptions['onProgress']>) {
  return ReactNativeSsh.addListener('onTransferProgress', event => {
    if (event.transferId === transferId) {
      onProgress({ transferred: event.transferred, total: event.total });
    }
  });
}
