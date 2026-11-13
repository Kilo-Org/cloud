import type * as SshPackage from '@kilocode/react-native-ssh';
import { type ConnectOptions, type SshAuth, type SshErrorCode } from '@kilocode/react-native-ssh';

import { i18n } from '@/i18n';

import { type SshDatabase } from '../database';
import { listForwardsForHost } from '../forwards';
import { autoStartForwards, resetSessionForwards } from '../forwards-runtime';
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
 * Opens the hop chain outermost-first, each hop reaching the next through the
 * one before it. Returns false when the chain stopped short.
 */
async function openChain(
  entry: LiveSession,
  db: SshDatabase,
  ssh: typeof SshPackage,
  hops: readonly SshHost[],
  opened: string[],
  via: string | null
): Promise<boolean> {
  const hop = hops[0];
  if (hop === undefined) {
    return true;
  }
  const auth = await authFor(entry, db, hop);
  if (auth === null) {
    await disconnectAll(opened);
    return false;
  }
  const options: ConnectOptions = {
    host: hop.hostname,
    port: hop.port,
    username: hop.username,
    auth,
  };
  entry.promptsHostId = auth.type === 'keyboardInteractive' ? hop.id : null;
  try {
    const nativeSessionId =
      via === null ? await ssh.connect(options) : await ssh.connectVia(via, options);
    opened.push(nativeSessionId);
    if (!stillOpen(entry)) {
      await disconnectAll(opened);
      return false;
    }
    return openChain(entry, db, ssh, hops.slice(1), opened, nativeSessionId);
  } catch (error) {
    await disconnectAll(opened);
    fail(entry, reasonOf(error), hop);
    return false;
  }
}

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
  'NotFound',
  'PermissionDenied',
  'Cancelled',
  'Forwarding',
  'LocalIo',
];

/**
 * Opens the hop chain, then the shell, and then the terminal the screen renders.
 * A host with a jump host reaches its target through `connectVia`, one session
 * per hop. Every ending goes through {@link fail}, which decides whether the
 * session retries, asks for an answer, or closes.
 */
export async function attempt(entry: LiveSession): Promise<void> {
  if (!stillOpen(entry)) {
    return;
  }
  clearTimer(entry);
  entry.attempt += 1;
  entry.connecting = true;
  setPhase(entry, { kind: 'connecting', attempt: entry.attempt });
  const opened: string[] = [];
  try {
    const db = await sshDatabase();
    const host = getHost(db, entry.host.id);
    if (host === null) {
      fail(entry, 'host-missing');
      return;
    }
    entry.host = host;
    const chain = hopChain(db, host);
    if (chain === null) {
      fail(entry, 'host-missing');
      return;
    }
    entry.connectTargets = chain.map(hop => ({ host: hop.hostname, port: hop.port }));

    const ssh = await sshPackage();
    if (!(await openChain(entry, db, ssh, chain, opened, null))) {
      return;
    }

    const targetSessionId = opened.at(-1) ?? null;
    if (targetSessionId === null) {
      fail(entry, 'Protocol');
      return;
    }
    entry.jumpSessionIds = opened.slice(0, -1);
    entry.nativeSessionId = targetSessionId;
    patchSession(entry.id, { nativeSessionId: targetSessionId });

    const shellId = await ssh.openShell(targetSessionId, { term: TERMINAL_TYPE });
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
    // A listening port belongs to the connection that opened it, so the
    // forwards start here rather than on the screen that shows them.
    await autoStartForwards(entry.id, targetSessionId, listForwardsForHost(db, host.id));
  } catch (error) {
    fail(entry, reasonOf(error));
  } finally {
    entry.connecting = false;
    entry.connectTargets = [];
    entry.promptsHostId = null;
  }
}

/**
 * Applies the ending of an attempt: the sheets a reason can be answered with,
 * an automatic retry for a transport failure, and the closed state otherwise.
 * `hop` is the host the failure came from when it is not the target.
 */
export function fail(entry: LiveSession, reason: SshCloseReason, hop?: SshHost): void {
  if (!stillOpen(entry)) {
    return;
  }
  releaseShell(entry);
  entry.prompts = null;
  entry.hostKey = null;
  const failedHost = hop ?? entry.host;
  if (reason === 'AuthFailed' && failedHost.authMethod === 'password') {
    entry.passwords.delete(failedHost.id);
    entry.authHostId = failedHost.id;
    setPhase(entry, {
      kind: 'awaiting-password',
      failed: true,
      label: failedHost.id === entry.host.id ? null : failedHost.label,
    });
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
 * The hosts this session opens, outermost first: the target last, each jump
 * host before the host that jumps through it. Null when a stored hop is gone.
 */
function hopChain(db: SshDatabase, host: SshHost): SshHost[] | null {
  const chain = [host];
  const seen = new Set([host.id]);
  let current = host;
  while (current.jumpHostId !== null) {
    if (seen.has(current.jumpHostId)) {
      return null;
    }
    const jump = getHost(db, current.jumpHostId);
    if (jump === null) {
      return null;
    }
    seen.add(jump.id);
    chain.unshift(jump);
    current = jump;
  }
  return chain;
}

/**
 * The authentication the next attempt sends for `host`. `null` means a sheet is
 * open and the session continues when its answer arrives.
 */
async function authFor(
  entry: LiveSession,
  db: SshDatabase,
  host: SshHost
): Promise<SshAuth | null> {
  if (host.authMethod === 'password') {
    const password = host.password ?? entry.passwords.get(host.id) ?? null;
    if (password === null) {
      entry.authHostId = host.id;
      setPhase(entry, {
        kind: 'awaiting-password',
        failed: false,
        label: host.id === entry.host.id ? null : host.label,
      });
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
  patchSession(entry.id, { nativeSessionId: null });
  void resetSessionForwards(entry.id);
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

/** Closes the hop sessions an abandoned attempt opened, outermost last. */
async function disconnectAll(sessionIds: readonly string[]): Promise<void> {
  await Promise.all(sessionIds.toReversed().map(sessionId => forgetSession(sessionId)));
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
