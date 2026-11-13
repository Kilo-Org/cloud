import { hostTarget } from '../host-target';
import { type SshHost } from '../hosts';
import { newId } from '../id';
import { sshPackage } from '../native';
import { handleForwardError, resetSessionForwards } from '../forwards-runtime';
import { forgetIdleNotify } from './idle-notify';
import { attempt, fail } from './attempt';
import { clearTimer, live, type LiveSession, setPhase } from './live';
import {
  answerPrompts,
  handleDisconnect,
  handleHostKey,
  handlePrompts,
  respondToHostKey,
} from './server-requests';
import { dropSession, patchSession, sessionById, writeSession } from './session-store';
import { type SshHostKeyDecision } from './types';

/** Opens a session for `host` and starts connecting. Returns the screen's id. */
export function openSession(host: SshHost): string {
  const id = newId();
  const entry: LiveSession = {
    id,
    host,
    nativeSessionId: null,
    attempt: 0,
    timer: null,
    hostKey: null,
    prompts: null,
    passwords: new Map(),
    authHostId: null,
    promptsHostId: null,
    jumpSessionIds: [],
    passphrase: null,
    keyUnlocked: false,
    connecting: false,
    connectTargets: [],
  };
  live.set(id, entry);
  writeSession({
    id,
    hostId: host.id,
    label: host.label,
    target: hostTarget(host),
    startedAt: Date.now(),
    phase: { kind: 'connecting', attempt: 0 },
    shellId: null,
    nativeSessionId: null,
    pendingCommand: null,
  });
  void begin(entry);
  return id;
}

/** Ends a session and releases its native connection and shell. */
export async function closeSession(id: string): Promise<void> {
  const entry = live.get(id);
  if (entry === undefined) {
    return;
  }
  clearTimer(entry);
  const shellId = sessionById(id)?.shellId ?? null;
  const nativeSessionId = entry.nativeSessionId;
  const jumps = entry.jumpSessionIds;
  live.delete(id);
  dropSession(id);
  forgetIdleNotify(id);
  await resetSessionForwards(id);
  try {
    const ssh = await sshPackage();
    if (shellId !== null) {
      ssh.closeShell(shellId);
    }
    if (nativeSessionId !== null) {
      await ssh.disconnect(nativeSessionId);
    }
    await Promise.all(jumps.map(jump => ssh.disconnect(jump)));
  } catch {
    // The connection already went away, or this build carries no module: no
    // native resource is left to release.
  }
}

/** Starts a fresh attempt after the person asked for one. */
export function retrySession(id: string): void {
  const entry = live.get(id);
  if (entry === undefined || entry.connecting) {
    return;
  }
  entry.attempt = 0;
  entry.keyUnlocked = false;
  entry.passwords.clear();
  entry.authHostId = null;
  entry.passphrase = null;
  void attempt(entry);
}

/** Retries every session waiting on a timer, now: the network is back. */
export function resumeSshSessions(): void {
  for (const entry of live.values()) {
    if (!entry.connecting && sessionById(entry.id)?.phase.kind === 'reconnecting') {
      void attempt(entry);
    }
  }
}

/** Answers the host-key sheet of a session. */
export function decideHostKey(id: string, decision: SshHostKeyDecision): void {
  const entry = live.get(id);
  const pending = entry?.hostKey ?? null;
  if (entry === undefined || pending === null) {
    return;
  }
  entry.hostKey = null;
  respondToHostKey(entry, pending, decision);
}

/** Supplies the password the connection is waiting on, for the host that asked. */
export function submitPassword(id: string, password: string): void {
  const entry = live.get(id);
  const hostId = entry?.authHostId ?? null;
  if (entry === undefined || hostId === null) {
    return;
  }
  entry.passwords.set(hostId, password);
  void attempt(entry);
}

/** Supplies the passphrase the connection's key is waiting on. */
export function submitPassphrase(id: string, passphrase: string): void {
  const entry = live.get(id);
  if (entry === undefined) {
    return;
  }
  entry.passphrase = passphrase;
  void attempt(entry);
}

/** Answers one keyboard-interactive round; `null` cancels authentication. */
export function submitPrompts(id: string, answers: string[] | null): void {
  const entry = live.get(id);
  const pending = entry?.prompts ?? null;
  if (entry === undefined || pending === null) {
    return;
  }
  entry.prompts = null;
  setPhase(entry, { kind: 'connecting', attempt: entry.attempt });
  answerPrompts(pending.requestId, answers);
}

/** Marks the tmux attach as typed, so the terminal types it once. */
export function consumePendingCommand(id: string, command: string): void {
  const session = sessionById(id);
  if (session?.pendingCommand === command) {
    patchSession(id, { pendingCommand: null });
  }
}

/**
 * The native shell ended. A remote exit (`error` null) closes the session; a
 * failure closes the channel under it, which is one of the transport reasons a
 * reconnect clears.
 */
export function endShell(id: string, error: string | null): void {
  const entry = live.get(id);
  if (entry === undefined) {
    return;
  }
  patchSession(id, { shellId: null, pendingCommand: null });
  fail(entry, error === null || error.length === 0 ? 'user' : 'ChannelClosed');
}

async function begin(entry: LiveSession): Promise<void> {
  try {
    await ensureListening();
  } catch {
    fail(entry, 'unavailable');
    return;
  }
  await attempt(entry);
}

let listening: Promise<void> | null = null;

/**
 * The core reports host keys, prompts and disconnects through one set of
 * listeners, so they are added once for the process and every session reads
 * them. A build without the native module rejects, and every session then
 * closes as unavailable.
 */
function ensureListening(): Promise<void> {
  listening ??= subscribeToSshEvents();
  return listening;
}

async function subscribeToSshEvents(): Promise<void> {
  const ssh = await sshPackage();
  ssh.addSshListener('onHostKey', handleHostKey);
  ssh.addSshListener('onKeyboardInteractive', handlePrompts);
  ssh.addSshListener('onDisconnect', handleDisconnect);
  ssh.addSshListener('onForwardError', notice => {
    handleForwardError(notice.sessionId);
  });
}
