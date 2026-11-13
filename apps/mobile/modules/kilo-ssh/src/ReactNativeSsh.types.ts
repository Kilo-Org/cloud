/**
 * An OpenSSH-encoded Ed25519 key pair produced by the Rust core.
 *
 * Field names follow the JavaScript conventions of the binding; the Rust record
 * uses `private_key_openssh`, `public_key_openssh` and `fingerprint_sha256`.
 */
export type GeneratedKey = {
  privateKeyOpenssh: string;
  publicKeyOpenssh: string;
  fingerprintSha256: string;
};

/**
 * Stable failure categories of the Rust core. A rejected call carries one of
 * these as its `code`, so callers branch on the category instead of text.
 */
export const SSH_ERROR_CODES = [
  'Network',
  'Timeout',
  'HostKeyRejected',
  'AuthFailed',
  'AuthCancelled',
  'UnsupportedAlgorithm',
  'KeyParse',
  'WrongPassphrase',
  'InvalidExport',
  'ChannelClosed',
  'Protocol',
  'KeyGeneration',
  'NotFound',
  'PermissionDenied',
  'Cancelled',
  'Forwarding',
  'LocalIo',
] as const;

export type SshErrorCode = (typeof SSH_ERROR_CODES)[number];

/** How a session proves who it is. */
export type SshAuth =
  | { type: 'password'; password: string }
  | { type: 'key'; privateKeyOpenssh: string; passphrase?: string }
  | { type: 'keyboardInteractive' };

export type ConnectOptions = {
  /**
   * The JavaScript session this connection belongs to. The native registry
   * keeps it, so a runtime that starts after a reload adopts the row its screen
   * names instead of minting a second id for one connection. Omit it for a
   * connection with no row of its own, such as a jump hop.
   */
  appSessionId?: string;
  host: string;
  /** Defaults to 22. */
  port?: number;
  username: string;
  auth: SshAuth;
  /**
   * Budget for reaching an authenticated session. Prompts answered through
   * `addSshListener` do not count against it. Defaults to 15000.
   */
  connectTimeoutMs?: number;
  /** Defaults to 15; `0` disables keepalives. */
  keepaliveIntervalS?: number;
};

export type ExecOutput = {
  stdout: string;
  stderr: string;
  /** `null` when the server reported no exit status. */
  exitStatus: number | null;
};

export type ParsedKey = {
  algorithm: string;
  publicKeyOpenssh: string;
  fingerprintSha256: string;
  /** Whether the imported key material was encrypted with a passphrase. */
  encrypted: boolean;
};

export type ShellOptions = {
  /** Defaults to `xterm-256color`. */
  term?: string;
  /** Defaults to 80. */
  cols?: number;
  /** Defaults to 24. */
  rows?: number;
};

/** The server's host key, awaiting a decision from `answerHostKey`. */
export type HostKeyRequest = {
  sessionId: string;
  requestId: string;
  host: string;
  port: number;
  algorithm: string;
  publicKeyBase64: string;
  fingerprintSha256: string;
};

export type KeyboardInteractivePrompt = {
  text: string;
  /** Whether the answer may be displayed as it is typed. */
  echo: boolean;
};

/** Prompts awaiting answers from `answerPrompts`. */
export type KeyboardInteractiveRequest = {
  sessionId: string;
  requestId: string;
  name: string;
  instructions: string;
  prompts: KeyboardInteractivePrompt[];
};

export type DisconnectNotice = {
  sessionId: string;
  reason: string;
};

/**
 * A live session as the native registry holds it. A JavaScript runtime that
 * starts while the sockets are already open reads these to rebuild its view.
 */
export type SessionInfo = {
  sessionId: string;
  /** The JavaScript session that opened it, or '' for a connection with no row. */
  appSessionId: string;
  host: string;
  port: number;
  username: string;
  /** Shell ids whose byte sources are still registered with the terminal. */
  shellIds: string[];
  sftpIds: string[];
  forwardIds: string[];
};

/** A forward that is still listening on a live session. */
export type ForwardInfo = {
  forwardId: string;
  sessionId: string;
  direction: 'local' | 'remote';
  bindHost: string;
  bindPort: number;
  /** The port the listener actually bound. */
  port: number;
};

/**
 * Where a localized notification body puts the session count. The sentence is
 * translated once with this token in place of the number and the native side
 * substitutes its own registry count, so the text never depends on a number a
 * destroyed JavaScript runtime once reported.
 */
export const BACKGROUND_SESSION_COUNT_TOKEN = '{count}';

/** The texts the background session notification renders. */
export type BackgroundSessionTexts = {
  channelName: string;
  title: string;
  /** The translated body with {@link BACKGROUND_SESSION_COUNT_TOKEN} where the count goes. */
  bodyTemplate: string;
  disconnectAllLabel: string;
};

/** The notification posted when a command finishes in the background. */
export type IdleNotificationTexts = {
  title: string;
  body?: string;
};

export type SessionsChangedNotice = {
  count: number;
};

export type CommandFinishedNotice = {
  shellId: string;
};

/** What a directory entry points at, from the server's `lstat`. */
export type EntryKind = 'file' | 'directory' | 'symlink' | 'other';

export type SftpEntry = {
  name: string;
  kind: EntryKind;
  size: number;
  /** Seconds since the Unix epoch; `null` when the server reported no time. */
  modifiedUnix: number | null;
  /** POSIX mode bits; `null` when the server reported none. */
  permissions: number | null;
};

export type TransferProgress = {
  transferred: number;
  /** `null` when the source did not report its size. */
  total: number | null;
};

export type TransferProgressEvent = TransferProgress & { transferId: string };

export type TransferOptions = {
  /** Called at most ten times a second while bytes move. */
  onProgress?: (progress: TransferProgress) => void;
  /** Cancels the transfer; the promise rejects with code `Cancelled`. */
  signal?: AbortSignal;
};

export type ForwardErrorNotice = {
  sessionId: string;
  message: string;
};

export type SshEvents = {
  onHostKey: (request: HostKeyRequest) => void;
  onKeyboardInteractive: (request: KeyboardInteractiveRequest) => void;
  onDisconnect: (notice: DisconnectNotice) => void;
  onSessionsChanged: (notice: SessionsChangedNotice) => void;
  onCommandFinished: (notice: CommandFinishedNotice) => void;
  /** The `Disconnect all` action of the session notification was tapped. */
  onDisconnectAll: () => void;
  onTransferProgress: (event: TransferProgressEvent) => void;
  onForwardError: (notice: ForwardErrorNotice) => void;
};

/** The record shapes the native module exchanges; the public API maps to them. */
export type NativeAuth =
  | { type: 'password'; password: string }
  | { type: 'key'; privateKeyOpenssh: string; passphrase: string | null }
  | { type: 'keyboardInteractive' };

export type NativeConnectConfig = {
  /**
   * The JavaScript session this connection belongs to. The registry keeps it, so
   * a runtime that starts after a reload adopts the row the open screen names
   * instead of minting a second id for one connection.
   */
  appSessionId: string;
  host: string;
  port: number;
  username: string;
  auth: NativeAuth;
  connectTimeoutMs: number;
  keepaliveIntervalS: number;
};

export type NativeExecOutput = {
  stdout: string;
  stderr: string;
  exitStatus: number | null;
};

export type NativeShellOptions = {
  term: string;
  cols: number;
  rows: number;
};

export type NativeParsedKey = ParsedKey;

export type NativeForwardConfig = {
  bindHost: string;
  bindPort: number;
  destHost: string;
  destPort: number;
};

export type NativeForwardStart = {
  forwardId: string;
  /** The port the forward listens on. */
  port: number;
};
