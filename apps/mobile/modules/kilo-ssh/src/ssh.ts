import type { EventSubscription } from 'expo';

import type {
  BackgroundSessionTexts,
  ConnectOptions,
  ExecOutput,
  IdleNotificationTexts,
  NativeAuth,
  NativeConnectConfig,
  ParsedKey,
  ShellOptions,
  SshEvents,
} from './ReactNativeSsh.types';
import ReactNativeSsh from './ReactNativeSshModule';
import { guard, isRetryableError, SshError, translate } from './errors';

const DEFAULT_PORT = 22;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_KEEPALIVE_INTERVAL_S = 15;
const DEFAULT_TERM = 'xterm-256color';
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Connects and authenticates. Host-key and keyboard-interactive decisions
 * arrive through [`addSshListener`] while this promise is pending.
 */
export function connect(options: ConnectOptions): Promise<string> {
  return guard(() => ReactNativeSsh.connect(nativeConnectConfig(options)));
}

/**
 * Connects through `jumpSessionId`, an authenticated session whose network
 * reaches the target. Chaining bastions works the same way: each jump session
 * may itself have been opened through another one.
 */
export function connectVia(jumpSessionId: string, options: ConnectOptions): Promise<string> {
  return guard(() => ReactNativeSsh.connectVia(jumpSessionId, nativeConnectConfig(options)));
}

/** Runs one command against a fresh session channel. */
export async function exec(sessionId: string, command: string): Promise<ExecOutput> {
  const output = await guard(() => ReactNativeSsh.exec(sessionId, command));

  return {
    stdout: output.stdout,
    stderr: output.stderr,
    exitStatus: output.exitStatus,
  };
}

/** Ends the session. Shell channels opened on it close as well. */
export function disconnect(sessionId: string): Promise<void> {
  return guard(() => ReactNativeSsh.disconnect(sessionId));
}

/**
 * Opens a pty-backed shell. The returned id names a native byte source for the
 * terminal module; its bytes never cross into JavaScript.
 */
export function openShell(sessionId: string, options: ShellOptions = {}): Promise<string> {
  return guard(() =>
    ReactNativeSsh.openShell(sessionId, {
      term: options.term ?? DEFAULT_TERM,
      cols: options.cols ?? DEFAULT_COLS,
      rows: options.rows ?? DEFAULT_ROWS,
    })
  );
}

export function closeShell(shellId: string): void {
  ReactNativeSsh.closeShell(shellId);
}

/**
 * Sets the texts of the notification that stays up while sessions are open. The
 * body carries the count token and the native side fills it from its own
 * session registry, so the notification stays right even while no JavaScript
 * runtime is attached. Android runs a foreground service for as long as a
 * session is open; iOS has no background keepalive, so this only stores the
 * texts there.
 */
export function configureBackgroundSessions(texts: BackgroundSessionTexts): void {
  ReactNativeSsh.configureBackgroundSessions(
    texts.channelName,
    texts.title,
    texts.disconnectAllLabel
  );
  ReactNativeSsh.updateSessionsBody(texts.bodyTemplate);
}

/**
 * Arms a one-shot "command finished" signal on a shell: once its output has been
 * silent for `quietMs`, a notification is posted and `onCommandFinished` fires.
 * It stays silent when the app is on screen or the shell closes first, and
 * returns `false` when the shell is not open. iOS resolves the same way without
 * posting anything.
 */
export function notifyWhenIdle(
  shellId: string,
  quietMs: number,
  texts: IdleNotificationTexts
): boolean {
  return ReactNativeSsh.notifyWhenIdle(shellId, quietMs, texts.title, texts.body ?? null);
}

/** Reads an OpenSSH or PEM private key without contacting a server. */
export function parsePrivateKey(pem: string, passphrase?: string): ParsedKey {
  try {
    return ReactNativeSsh.parsePrivateKey(pem, passphrase ?? null);
  } catch (cause) {
    throw translate(cause);
  }
}

/** Accepts or rejects the host key of a pending connection. */
export function answerHostKey(requestId: string, accept: boolean): boolean {
  return ReactNativeSsh.answerHostKey(requestId, accept);
}

/** Answers a keyboard-interactive round; `null` cancels authentication. */
export function answerPrompts(requestId: string, answers: string[] | null): boolean {
  return ReactNativeSsh.answerPrompts(requestId, answers);
}

export function addSshListener<K extends keyof SshEvents>(
  event: K,
  listener: SshEvents[K]
): EventSubscription {
  return ReactNativeSsh.addListener(event, listener);
}

export { isRetryableError, SshError };

export type {
  BackgroundSessionTexts,
  CommandFinishedNotice,
  ConnectOptions,
  DisconnectNotice,
  ExecOutput,
  HostKeyRequest,
  IdleNotificationTexts,
  KeyboardInteractivePrompt,
  KeyboardInteractiveRequest,
  ParsedKey,
  SessionsChangedNotice,
  ShellOptions,
  SshErrorCode,
  SshEvents,
} from './ReactNativeSsh.types';

function nativeConnectConfig(options: ConnectOptions): NativeConnectConfig {
  return {
    host: options.host,
    port: options.port ?? DEFAULT_PORT,
    username: options.username,
    auth: nativeAuth(options.auth),
    connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    keepaliveIntervalS: options.keepaliveIntervalS ?? DEFAULT_KEEPALIVE_INTERVAL_S,
  };
}

function nativeAuth(auth: ConnectOptions['auth']): NativeAuth {
  switch (auth.type) {
    case 'password':
      return { type: 'password', password: auth.password };
    case 'key':
      return {
        type: 'key',
        privateKeyOpenssh: auth.privateKeyOpenssh,
        passphrase: auth.passphrase ?? null,
      };
    case 'keyboardInteractive':
      return { type: 'keyboardInteractive' };
  }
}
