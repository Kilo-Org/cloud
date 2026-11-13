import { NativeModule, requireNativeModule } from 'expo';

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

declare class ReactNativeSshModule extends NativeModule<SshEvents> {
  coreVersion(): string;
  generateEd25519Key(comment: string): Promise<GeneratedKey>;
  parsePrivateKey(pem: string, passphrase: string | null): ParsedKey;
  encryptExport(plaintextJson: string, passphrase: string): Promise<string>;
  decryptExport(armored: string, passphrase: string): Promise<string>;
  connect(config: NativeConnectConfig): Promise<string>;
  /** Connects through an authenticated session that carries the stream. */
  connectVia(jumpSessionId: string, config: NativeConnectConfig): Promise<string>;
  exec(sessionId: string, command: string): Promise<NativeExecOutput>;
  disconnect(sessionId: string): Promise<void>;
  /** Returns the id of a shell whose bytes go to a native `SshShellSource`. */
  openShell(sessionId: string, options: NativeShellOptions): Promise<string>;
  closeShell(shellId: string): void;
  configureBackgroundSessions(
    channelName: string,
    title: string,
    disconnectAllLabel: string
  ): number;
  updateSessionsBody(body: string): void;
  notifyWhenIdle(shellId: string, quietMs: number, title: string, body: string | null): boolean;
  answerHostKey(requestId: string, accept: boolean): boolean;
  answerPrompts(requestId: string, answers: string[] | null): boolean;
  isRetryableCode(code: string): boolean;

  openSftp(sessionId: string): Promise<string>;
  closeSftp(sftpId: string): Promise<void>;
  sftpList(sftpId: string, path: string): Promise<SftpEntry[]>;
  sftpStat(sftpId: string, path: string): Promise<SftpEntry>;
  sftpRealpath(sftpId: string, path: string): Promise<string>;
  sftpMkdir(sftpId: string, path: string): Promise<void>;
  sftpRename(sftpId: string, from: string, to: string): Promise<void>;
  sftpRemoveFile(sftpId: string, path: string): Promise<void>;
  sftpRemoveDir(sftpId: string, path: string): Promise<void>;
  /** Resolves with the transferred byte count. */
  sftpDownload(
    sftpId: string,
    remotePath: string,
    localPath: string,
    transferId: string
  ): Promise<number>;
  sftpUpload(
    sftpId: string,
    localPath: string,
    remotePath: string,
    transferId: string
  ): Promise<number>;
  cancelTransfer(transferId: string): void;

  startLocalForward(sessionId: string, config: NativeForwardConfig): Promise<NativeForwardStart>;
  startRemoteForward(sessionId: string, config: NativeForwardConfig): Promise<NativeForwardStart>;
  stopForward(forwardId: string): Promise<void>;
}

export default requireNativeModule<ReactNativeSshModule>('ReactNativeSsh');
