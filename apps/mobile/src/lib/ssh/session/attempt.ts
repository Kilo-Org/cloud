import { type ConnectOptions, type SshAuth, type SshErrorCode } from '@kilocode/react-native-ssh';

import { i18n } from '@/i18n';

import { type SshDatabase } from '../database';
import { getHost, type SshHost, updateHost } from '../hosts';
import { getKey } from '../keys';
import { nativeErrorCode, sshPackage } from '../native';
import { quoteShellArg } from '../shell-quote';
import { sshDatabase } from '../store';
import { MAX_RECONNECT_ATTEMPTS, reconnectDelayMs } from './backoff';
import { requireKeyAccess } from './biometric';
import { clearTimer, type LiveSession, setPhase, stillOpen } from './live';
import { patchSession, sessionById } from './session-store';
import { isRetryableReason, type SshCloseReason } from './types';

const TERMINAL_TYPE = 'xterm-256color';
const DEFAULT_TMUX_SESSION = 'kilo';

/**
 * The core's failure codes, restated so a rejected promise can be classified
 * without loading the native module. Keep in step with `SSH_ERROR_CODES` in
 * `@kilocode/react-native-ssh`.
 */
const ERROR_CODES: readonly SshErrorCode[] = [
  'Network',
  'Timeout',
  'HostKeyRejected',
  'AuthFailed',
  'AuthCancelled',
  'UnsupportedAlgorithm',
  'KeyParse',
  'WrongPassphrase',
  'ChannelClosed',
  'Protocol',
  'KeyGeneration',
];

/**
 * Opens the connection, the shell, and then the terminal the screen renders.
 * Every ending goes through {@link fail}, which decides whether the session
 * retries, asks for an answer, or closes.
 */
export async function attempt(entry: LiveSession): Promise<void> {
  if (!stillOpen(entry)) {
    return;
  }
  clearTimer(entry);
  entry.attempt += 1;
  entry.connecting = true;
  setPhase(entry, { kind: 'connecting', attempt: entry.attempt });
  try {
    const db = await sshDatabase();
    const host = getHost(db, entry.host.id);
    if (host === null) {
      fail(entry, 'host-missing');
      return;
    }
    entry.host = host;
    const auth = await authFor(entry, db, host);
    if (auth === null) {
      return;
    }
    const ssh = await sshPackage();
    const options: ConnectOptions = {
      host: host.hostname,
      port: host.port,
      username: host.username,
      auth,
    };
    const nativeSessionId = await ssh.connect(options);
    if (!stillOpen(entry)) {
      await forgetSession(nativeSessionId);
      return;
    }
    entry.nativeSessionId = nativeSessionId;
    const shellId = await ssh.openShell(nativeSessionId, { term: TERMINAL_TYPE });
    if (!stillOpen(entry)) {
      ssh.closeShell(shellId);
      return;
    }
    updateHost(db, host.id, { lastConnectedAt: Date.now() });
    patchSession(entry.id, {
      shellId,
      pendingCommand: host.tmuxAttach ? tmuxAttachCommand(host) : null,
      phase: { kind: 'connected' },
    });
  } catch (error) {
    fail(entry, reasonOf(error));
  } finally {
    entry.connecting = false;
  }
}

/**
 * Applies the ending of an attempt: the sheets a reason can be answered with,
 * an automatic retry for a transport failure, and the closed state otherwise.
 */
export function fail(entry: LiveSession, reason: SshCloseReason): void {
  if (!stillOpen(entry)) {
    return;
  }
  releaseShell(entry);
  entry.prompts = null;
  entry.hostKey = null;
  if (reason === 'AuthFailed' && entry.host.authMethod === 'password') {
    entry.password = null;
    setPhase(entry, { kind: 'awaiting-password', failed: true });
    return;
  }
  if (reason === 'WrongPassphrase') {
    setPhase(entry, { kind: 'awaiting-passphrase', failed: true });
    return;
  }
  if (isRetryableReason(reason) && entry.attempt < MAX_RECONNECT_ATTEMPTS) {
    scheduleReconnect(entry, reason);
    return;
  }
  setPhase(entry, { kind: 'closed', reason, retryable: isRetryableReason(reason) });
}

/**
 * The authentication the next attempt sends. `null` means a sheet is open and
 * the session continues when its answer arrives.
 */
async function authFor(
  entry: LiveSession,
  db: SshDatabase,
  host: SshHost
): Promise<SshAuth | null> {
  if (host.authMethod === 'password') {
    const password = host.password ?? entry.password;
    if (password === null) {
      setPhase(entry, { kind: 'awaiting-password', failed: false });
      return null;
    }
    return { type: 'password', password };
  }

  if (host.authMethod === 'key') {
    const key = host.keyId === null ? null : getKey(db, host.keyId);
    if (key === null) {
      fail(entry, 'key-missing');
      return null;
    }
    if (!entry.keyUnlocked) {
      const unlocked = await requireKeyAccess(i18n.t('ssh.session.keyPrompt'));
      if (!unlocked) {
        fail(entry, 'AuthCancelled');
        return null;
      }
      entry.keyUnlocked = true;
    }
    const passphrase = entry.passphrase ?? key.passphrase ?? undefined;
    try {
      const ssh = await sshPackage();
      ssh.parsePrivateKey(key.privateKeyOpenssh, passphrase);
    } catch (error) {
      const reason = reasonOf(error);
      if (reason === 'WrongPassphrase') {
        setPhase(entry, { kind: 'awaiting-passphrase', failed: passphrase !== undefined });
        return null;
      }
      fail(entry, reason);
      return null;
    }
    return { type: 'key', privateKeyOpenssh: key.privateKeyOpenssh, passphrase };
  }

  return { type: 'keyboardInteractive' };
}

function scheduleReconnect(entry: LiveSession, reason: SshCloseReason): void {
  const next = entry.attempt + 1;
  setPhase(entry, { kind: 'reconnecting', attempt: next, reason });
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void attempt(entry);
  }, reconnectDelayMs(next));
}

function releaseShell(entry: LiveSession): void {
  const session = sessionById(entry.id);
  const shellId = session?.shellId ?? null;
  if (shellId !== null) {
    void closeShellQuietly(shellId);
  }
  if (session !== null && (session.shellId !== null || session.pendingCommand !== null)) {
    patchSession(entry.id, { shellId: null, pendingCommand: null });
  }
}

async function closeShellQuietly(shellId: string): Promise<void> {
  try {
    const ssh = await sshPackage();
    ssh.closeShell(shellId);
  } catch {
    // The shell already ended, or this build carries no module: nothing is
    // left to release.
  }
}

/**
 * Releases a native session the app no longer renders. A session left in the
 * core's registry keeps the connection state its host's next attempt waits on.
 */
export async function forgetSession(nativeSessionId: string): Promise<void> {
  try {
    const ssh = await sshPackage();
    await ssh.disconnect(nativeSessionId);
  } catch {
    // The screen that owned this connection is gone, so its resources are too.
  }
}

function tmuxAttachCommand(host: SshHost): string {
  const requested = host.tmuxSessionName?.trim() ?? '';
  const name = requested.length === 0 ? DEFAULT_TMUX_SESSION : requested;
  return `tmux new -A -s ${quoteShellArg(name)}\r`;
}

function reasonOf(cause: unknown): SshCloseReason {
  const code = nativeErrorCode(cause);
  const match = ERROR_CODES.find(candidate => candidate === code);
  return match ?? 'Protocol';
}
