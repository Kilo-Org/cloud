import { NativeModule, registerWebModule } from 'expo';

import type {
  GeneratedKey,
  NativeConnectConfig,
  NativeExecOutput,
  NativeForwardConfig,
  NativeForwardStart,
  NativeShellOptions,
  ParsedKey,
  SftpEntry,
  SshEvents,
} from './ReactNativeSsh.types';

const unavailable = '@kilocode/react-native-ssh has no web implementation';

function unsupported(): never {
  throw new Error(unavailable);
}

class ReactNativeSshModule extends NativeModule<SshEvents> {
  coreVersion(): string {
    throw new Error(unavailable);
  }

  generateEd25519Key(_comment: string): Promise<GeneratedKey> {
    return Promise.reject(new Error(unavailable));
  }

  parsePrivateKey(_pem: string, _passphrase: string | null): ParsedKey {
    return unsupported();
  }

  encryptExport(_plaintextJson: string, _passphrase: string): Promise<string> {
    return Promise.reject(new Error(unavailable));
  }

  decryptExport(_armored: string, _passphrase: string): Promise<string> {
    return Promise.reject(new Error(unavailable));
  }

  connect(_config: NativeConnectConfig): Promise<string> {
    return Promise.reject(new Error(unavailable));
  }

  connectVia(_jumpSessionId: string, _config: NativeConnectConfig): Promise<string> {
    return Promise.reject(new Error(unavailable));
  }

  exec(_sessionId: string, _command: string): Promise<NativeExecOutput> {
    return Promise.reject(new Error(unavailable));
  }

  disconnect(_sessionId: string): Promise<void> {
    return Promise.reject(new Error(unavailable));
  }

  openShell(_sessionId: string, _options: NativeShellOptions): Promise<string> {
    return Promise.reject(new Error(unavailable));
  }

  closeShell(_shellId: string): void {
    unsupported();
  }

  configureBackgroundSessions(
    _channelName: string,
    _title: string,
    _disconnectAllLabel: string
  ): number {
    return 0;
  }

  updateSessionsBody(_body: string): void {}

  notifyWhenIdle(
    _shellId: string,
    _quietMs: number,
    _title: string,
    _body: string | null
  ): boolean {
    return false;
  }

  answerHostKey(_requestId: string, _accept: boolean): boolean {
    return unsupported();
  }

  answerPrompts(_requestId: string, _answers: string[] | null): boolean {
    return unsupported();
  }

  isRetryableCode(_code: string): boolean {
    return unsupported();
  }

  openSftp(_sessionId: string): Promise<string> {
    return Promise.reject(new Error(unavailable));
  }

  closeSftp(_sftpId: string): Promise<void> {
    return Promise.reject(new Error(unavailable));
  }

  sftpList(_sftpId: string, _path: string): Promise<SftpEntry[]> {
    return Promise.reject(new Error(unavailable));
  }

  sftpStat(_sftpId: string, _path: string): Promise<SftpEntry> {
    return Promise.reject(new Error(unavailable));
  }

  sftpRealpath(_sftpId: string, _path: string): Promise<string> {
    return Promise.reject(new Error(unavailable));
  }

  sftpMkdir(_sftpId: string, _path: string): Promise<void> {
    return Promise.reject(new Error(unavailable));
  }

  sftpRename(_sftpId: string, _from: string, _to: string): Promise<void> {
    return Promise.reject(new Error(unavailable));
  }

  sftpRemoveFile(_sftpId: string, _path: string): Promise<void> {
    return Promise.reject(new Error(unavailable));
  }

  sftpRemoveDir(_sftpId: string, _path: string): Promise<void> {
    return Promise.reject(new Error(unavailable));
  }

  sftpDownload(
    _sftpId: string,
    _remotePath: string,
    _localPath: string,
    _transferId: string
  ): Promise<number> {
    return Promise.reject(new Error(unavailable));
  }

  sftpUpload(
    _sftpId: string,
    _localPath: string,
    _remotePath: string,
    _transferId: string
  ): Promise<number> {
    return Promise.reject(new Error(unavailable));
  }

  cancelTransfer(_transferId: string): void {
    unsupported();
  }

  startLocalForward(_sessionId: string, _config: NativeForwardConfig): Promise<NativeForwardStart> {
    return Promise.reject(new Error(unavailable));
  }

  startRemoteForward(
    _sessionId: string,
    _config: NativeForwardConfig
  ): Promise<NativeForwardStart> {
    return Promise.reject(new Error(unavailable));
  }

  stopForward(_forwardId: string): Promise<void> {
    return Promise.reject(new Error(unavailable));
  }
}

export default registerWebModule(ReactNativeSshModule, 'ReactNativeSsh');
