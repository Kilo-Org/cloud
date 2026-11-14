import { SSH_ERROR_CODES } from '../../../../modules/kilo-ssh/src/ReactNativeSsh.types';
import type * as SshPackage from '../../../../modules/kilo-ssh/src';
import { type ConnectOptions, type SshAuth } from '../../../../modules/kilo-ssh/src';

import { type SshReconnectOutcome } from '@kilocode/app-shared/analytics';

import { i18n } from '@/i18n';

import { trackSshConnectFailed, trackSshConnectSucceeded, trackSshReconnect } from '../analytics';
import { type SshDatabase } from '../database';
import { listForwardsForHost } from '../forwards';
import { autoStartForwards } from '../forwards-runtime';
import { getHost, type SshHost, updateHost } from '../hosts';
import { getKey } from '../keys';
import { nativeErrorCode, sshPackage } from '../native';
import { newId } from '../id';
import { quoteShellArg } from '../shell-quote';
import { sshDatabase } from '../store';
import { MAX_RECONNECT_ATTEMPTS, reconnectDelayMs } from './backoff';
import { requireKeyAccess, waitForForeground } from './biometric';
import { disconnectAll, releaseShell } from './connection';
import { clearTimer, type LiveSession, setPhase, stillOpen } from './live';
import { passwordFor } from './password';
import { patchSession, sessionById } from './session-store';
import { isRetryableReason, type SshCloseReason } from './types';

const TERMINAL_TYPE = 'xterm-256color';
const DEFAULT_TMUX_SESSION = 'kilo';

type ChainOpening = Readonly<{
  entry: LiveSession;
  db: SshDatabase;
  ssh: typeof SshPackage;
  /** The hop sessions this attempt already opened, outermost first. */
  opened: string[];
}>;

type FailOptions = Readonly<{
  /** The host the failure came from, when it is not the target. */
  hop?: SshHost;
  /** Whether the ending is a connection attempt's outcome or an established session's. */
  origin?: 'connect' | 'session';
}>;

/**
 * Opens the hop chain outermost-first, each hop reaching the next through the
 * one before it. Returns false when the chain stopped short.
 */
async function openChain(
  opening: ChainOpening,
  hops: readonly SshHost[],
  via: string | null
): Promise<boolean> {
  const { entry, db, ssh, opened } = opening;
  const hop = hops[0];
  if (hop === undefined) {
    return true;
  }
  const auth = await authFor(entry, db, hop);
  if (auth === null) {
    await disconnectAll(opened);
    return false;
  }
  entry.connectAttemptId = newId();
  const options: ConnectOptions = {
    // Only the session the person opened carries its row's id: a jump hop's
    // connection has no screen of its own, so a reload must not adopt it.
    appSessionId: hops.length === 1 ? entry.id : '',
    attemptId: entry.connectAttemptId,
    host: hop.hostname,
    port: hop.port,
    username: hop.username,
    auth,
  };
  try {
    const nativeSessionId =
      via === null ? await ssh.connect(options) : await ssh.connectVia(via, options);
    entry.connectAttemptId = null;
    opened.push(nativeSessionId);
    if (!stillOpen(entry)) {
      await disconnectAll(opened);
      return false;
    }
    return await openChain(opening, hops.slice(1), nativeSessionId);
  } catch (error) {
    await disconnectAll(opened);
    fail(entry, reasonOf(error), { hop });
    return false;
  }
}

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
  entry.connecting = true;
  const reconnecting = sessionById(entry.id)?.phase.kind === 'reconnecting';
  const cancellation = new AbortController();
  entry.attemptAbort = cancellation;
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
    if (reconnecting && chain.some(hop => hop.authMethod === 'key')) {
      const foreground = waitForForeground(cancellation.signal);
      if (foreground !== null && !(await foreground)) {
        return;
      }
    }
    if (!stillOpen(entry) || cancellation.signal.aborted) {
      return;
    }
    entry.attempt += 1;
    setPhase(entry, { kind: 'connecting', attempt: entry.attempt });

    const ssh = await sshPackage();
    if (!(await openChain({ entry, db, ssh, opened }, chain, null))) {
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
    if (entry.reconnecting) {
      entry.reconnecting = false;
      trackSshReconnect('succeeded');
    } else {
      trackSshConnectSucceeded(host.authMethod);
    }
    // A listening port belongs to the connection that opened it, so the
    // forwards start here rather than on the screen that shows them.
    await autoStartForwards(entry.id, targetSessionId, listForwardsForHost(db, host.id));
  } catch (error) {
    fail(entry, reasonOf(error));
  } finally {
    entry.attemptAbort = null;
    entry.connecting = false;
    entry.connectAttemptId = null;
  }
}

/**
 * Applies the ending of an attempt: the sheets a reason can be answered with,
 * an automatic retry for a transport failure, and the closed state otherwise.
 */
export function fail(entry: LiveSession, reason: SshCloseReason, options: FailOptions = {}): void {
  const origin = options.origin ?? 'connect';
  if (!stillOpen(entry)) {
    return;
  }
  entry.attemptAbort?.abort();
  releaseShell(entry);
  entry.prompts = null;
  entry.hostKey = null;
  const failedHost = options.hop ?? entry.host;
  entry.connectAttemptId = null;
  if (reason === 'AuthFailed' && failedHost.authMethod === 'password') {
    entry.passwords.delete(failedHost.id);
    entry.authHostId = failedHost.id;
    setPhase(entry, {
      kind: 'awaiting-password',
      failed: true,
      label: failedHost.id === entry.host.id ? null : failedHost.label,
    });
    finishReconnect(entry, 'requires_input');
    return;
  }
  if (reason === 'WrongPassphrase') {
    setPhase(entry, { kind: 'awaiting-passphrase', failed: true });
    finishReconnect(entry, 'requires_input');
    return;
  }
  if (isRetryableReason(reason) && entry.attempt < MAX_RECONNECT_ATTEMPTS) {
    scheduleReconnect(entry, reason, origin);
    return;
  }
  setPhase(entry, { kind: 'closed', reason, retryable: isRetryableReason(reason) });
  if (origin === 'session') {
    entry.reconnecting = false;
    return;
  }
  if (entry.reconnecting) {
    finishReconnect(entry, 'failed');
    return;
  }
  trackSshConnectFailed(entry.host.authMethod, reason);
}

/** Ends the automatic retry sequence and reports it exactly once. */
function finishReconnect(entry: LiveSession, outcome: SshReconnectOutcome): void {
  if (!entry.reconnecting) {
    return;
  }
  entry.reconnecting = false;
  trackSshReconnect(outcome);
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
    const password = passwordFor(host, entry.passwords);
    if (password === null) {
      entry.authHostId = host.id;
      setPhase(entry, {
        kind: 'awaiting-password',
        failed: false,
        label: host.id === entry.host.id ? null : host.label,
      });
      finishReconnect(entry, 'requires_input');
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
    if (!(await requireKeyAccess(i18n.t('ssh.session.keyPrompt'), entry.attemptAbort?.signal))) {
      if (!entry.attemptAbort?.signal.aborted) {
        fail(entry, 'AuthCancelled');
      }
      return null;
    }
    if (!stillOpen(entry)) {
      return null;
    }
    const passphrase = entry.passphrase ?? key.passphrase ?? undefined;
    try {
      const ssh = await sshPackage();
      ssh.parsePrivateKey(key.privateKeyOpenssh, passphrase);
    } catch (error) {
      const reason = reasonOf(error);
      if (reason === 'WrongPassphrase') {
        setPhase(entry, { kind: 'awaiting-passphrase', failed: passphrase !== undefined });
        finishReconnect(entry, 'requires_input');
        return null;
      }
      fail(entry, reason);
      return null;
    }
    return { type: 'key', privateKeyOpenssh: key.privateKeyOpenssh, passphrase };
  }

  return { type: 'keyboardInteractive' };
}

function scheduleReconnect(
  entry: LiveSession,
  reason: SshCloseReason,
  origin: 'connect' | 'session'
): void {
  if (origin === 'session') {
    entry.reconnecting = true;
  }
  const next = entry.attempt + 1;
  setPhase(entry, { kind: 'reconnecting', attempt: next, reason });
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void attempt(entry);
  }, reconnectDelayMs(next));
}

function tmuxAttachCommand(host: SshHost): string {
  const requested = host.tmuxSessionName?.trim() ?? '';
  const name = requested.length === 0 ? DEFAULT_TMUX_SESSION : requested;
  return `tmux new -A -s ${quoteShellArg(name)}\r`;
}

function reasonOf(cause: unknown): SshCloseReason {
  const code = nativeErrorCode(cause);
  const match = SSH_ERROR_CODES.find(candidate => candidate === code);
  return match ?? 'Protocol';
}
