import  {
  type ConnectOptions,
  type DisconnectNotice,
  type HostKeyRequest,
  type KeyboardInteractiveRequest,
  type SshAuth,
  type SshErrorCode,
} from '@kilocode/react-native-ssh';

import { i18n } from '@/i18n';

import  { type SshDatabase } from '../database';
import { hostTarget } from '../host-target';
import { getHost, type SshHost, updateHost } from '../hosts';
import { newId } from '../id';
import { getKey } from '../keys';
import { hostPattern } from '../known-host-pattern';
import { findKnownHost, trustHostKey } from '../known-hosts';
import { sshPackage } from '../native';
import { quoteShellArg } from '../shell-quote';
import { sshDatabase } from '../store';
import { MAX_RECONNECT_ATTEMPTS, reconnectDelayMs } from './backoff';
import { requireKeyAccess } from './biometric';
import { type HostKeyVerdict, judgeHostKey } from './host-key';
import {
  dropSession,
  patchSession,
  sessionById,
  writeSession,
} from './session-store';
import {
  isRetryableReason,
  type SshCloseReason,
  type SshHostKeyAwaiting,
  type SshHostKeyDecision,
  type SshPromptsAwaiting,
  type SshSessionPhase,
} from './types';

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
 * What the manager holds for a session beyond what the screen renders: the
 * native ids, the inputs a sheet is waiting on, and the retry timer.
 */
type LiveSession = {
  readonly id: string;
  host: SshHost;
  nativeSessionId: string | null;
  /** The attempt in flight or last finished; the next one is one higher. */
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  hostKey: SshHostKeyAwaiting | null;
  prompts: SshPromptsAwaiting | null;
  /** Typed once for this session when the host has no saved password. */
  password: string | null;
  /** Typed once for this session when the key needs one. */
  passphrase: string | null;
  /** The device-auth gate passed for this session's key. */
  keyUnlocked: boolean;
  connecting: boolean;
  open: boolean;
};

const live = new Map<string, LiveSession>();
let listening = false;

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
    password: null,
    passphrase: null,
    keyUnlocked: false,
    connecting: false,
    open: true,
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
  entry.open = false;
  clearTimer(entry);
  const shellId = sessionById(id)?.shellId ?? null;
  const nativeSessionId = entry.nativeSessionId;
  live.delete(id);
  dropSession(id);
  try {
    const ssh = await sshPackage();
    if (shellId !== null) {
      ssh.closeShell(shellId);
    }
    if (nativeSessionId !== null) {
      await ssh.disconnect(nativeSessionId);
    }
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
  entry.password = null;
  entry.passphrase = null;
  void attempt(entry);
}

/** Retries every session waiting on a timer, now: the network is back. */
export function resumeSshSessions(): void {
  for (const entry of live.values()) {
    if (entry.connecting || sessionById(entry.id)?.phase.kind !== 'reconnecting') {
      continue;
    }
    void attempt(entry);
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
  void respondToHostKey(entry, pending, decision);
}

/** Supplies the password the connection is waiting on. */
export function submitPassword(id: string, password: string): void {
  const entry = live.get(id);
  if (entry === undefined) {
    return;
  }
  entry.password = password;
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
  void sshPackage()
    .then(ssh => ssh.answerPrompts(pending.requestId, answers))
    .catch(() => undefined);
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

async function ensureListening(): Promise<void> {
  if (listening) {
    return;
  }
  const ssh = await sshPackage();
  if (listening) {
    return;
  }
  listening = true;
  ssh.addSshListener('onHostKey', handleHostKey);
  ssh.addSshListener('onKeyboardInteractive', handlePrompts);
  ssh.addSshListener('onDisconnect', handleDisconnect);
}

async function attempt(entry: LiveSession): Promise<void> {
  if (!entry.open) {
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
    if (!entry.open) {
      void ssh.disconnect(nativeSessionId).catch(() => undefined);
      return;
    }
    entry.nativeSessionId = nativeSessionId;
    const shellId = await ssh.openShell(nativeSessionId, { term: TERMINAL_TYPE });
    if (!entry.open) {
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
    handleFailure(entry, error);
  } finally {
    entry.connecting = false;
  }
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

function handleFailure(entry: LiveSession, cause: unknown): void {
  fail(entry, reasonOf(cause));
}

/**
 * Applies the ending of an attempt: the sheets a reason can be answered with,
 * an automatic retry for a transport failure, and the closed state otherwise.
 */
function fail(entry: LiveSession, reason: SshCloseReason): void {
  if (!entry.open) {
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

function scheduleReconnect(entry: LiveSession, reason: SshCloseReason): void {
  const next = entry.attempt + 1;
  setPhase(entry, { kind: 'reconnecting', attempt: next, reason });
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void attempt(entry);
  }, reconnectDelayMs(next));
}

function handleHostKey(request: HostKeyRequest): void {
  const entry = findConnecting(request.host, request.port);
  if (entry === null) {
    void answerHostKey(request.requestId, false);
    return;
  }
  void judgeOfferedKey(entry, request);
}

async function judgeOfferedKey(entry: LiveSession, request: HostKeyRequest): Promise<void> {
  const awaiting: SshHostKeyAwaiting = {
    requestId: request.requestId,
    hostPattern: hostPattern(request.host, request.port),
    algorithm: request.algorithm,
    publicKeyBase64: request.publicKeyBase64,
    fingerprintSha256: request.fingerprintSha256,
    knownFingerprintSha256: null,
  };
  let verdict: HostKeyVerdict;
  try {
    verdict = judgeHostKey(await sshDatabase(), awaiting);
  } catch {
    await answerHostKey(request.requestId, false);
    return;
  }
  if (!entry.open) {
    await answerHostKey(request.requestId, false);
    return;
  }
  if (verdict.kind === 'trusted') {
    await answerHostKey(request.requestId, true);
    return;
  }
  entry.hostKey =
    verdict.kind === 'mismatch'
      ? { ...awaiting, knownFingerprintSha256: verdict.knownFingerprintSha256 }
      : awaiting;
  setPhase(entry, { kind: 'awaiting-host-key', hostKey: entry.hostKey });
}

async function respondToHostKey(
  entry: LiveSession,
  pending: SshHostKeyAwaiting,
  decision: SshHostKeyDecision
): Promise<void> {
  if (decision === 'cancel') {
    await answerHostKey(pending.requestId, false);
    return;
  }
  if (decision === 'save') {
    try {
      const db = await sshDatabase();
      if (findKnownHost(db, pending.hostPattern, pending.algorithm) === null) {
        trustHostKey(db, {
          hostPattern: pending.hostPattern,
          keyAlgorithm: pending.algorithm,
          publicKeyBase64: pending.publicKeyBase64,
          fingerprintSha256: pending.fingerprintSha256,
        });
      }
    } catch {
      // The connection is still trusted for its own lifetime; the next one
      // asks again because nothing was stored.
    }
  }
  setPhase(entry, { kind: 'connecting', attempt: entry.attempt });
  await answerHostKey(pending.requestId, true);
}

function handlePrompts(request: KeyboardInteractiveRequest): void {
  const entry = findAwaitingPrompts();
  if (entry === null) {
    void declinePrompts(request.requestId);
    return;
  }
  entry.prompts = {
    requestId: request.requestId,
    name: request.name,
    instructions: request.instructions,
    prompts: request.prompts.map(prompt => ({ text: prompt.text, echo: prompt.echo })),
  };
  setPhase(entry, { kind: 'awaiting-prompts', prompts: entry.prompts });
}

function handleDisconnect(notice: DisconnectNotice): void {
  for (const entry of live.values()) {
    if (entry.nativeSessionId !== notice.sessionId) {
      continue;
    }
    entry.nativeSessionId = null;
    fail(entry, 'disconnected');
    return;
  }
}

/**
 * The session a host key belongs to. The core reports the key before it hands
 * back a session id, so the one attempt in flight for that target is the one
 * the key decides for.
 */
function findConnecting(host: string, port: number): LiveSession | null {
  for (const entry of live.values()) {
    if (entry.open && entry.connecting && entry.host.hostname === host && entry.host.port === port) {
      return entry;
    }
  }
  return null;
}

/** The session a keyboard-interactive round belongs to, for the same reason. */
function findAwaitingPrompts(): LiveSession | null {
  for (const entry of live.values()) {
    if (
      entry.open &&
      entry.connecting &&
      entry.prompts === null &&
      entry.host.authMethod === 'keyboard_interactive'
    ) {
      return entry;
    }
  }
  return null;
}

async function answerHostKey(requestId: string, accept: boolean): Promise<void> {
  try {
    const ssh = await sshPackage();
    ssh.answerHostKey(requestId, accept);
  } catch {
    // The package is gone, and the pending request with it.
  }
}

async function declinePrompts(requestId: string): Promise<void> {
  try {
    const ssh = await sshPackage();
    ssh.answerPrompts(requestId, null);
  } catch {
    // The package is gone, and the pending request with it.
  }
}

function setPhase(entry: LiveSession, phase: SshSessionPhase): void {
  patchSession(entry.id, { phase });
}

function releaseShell(entry: LiveSession): void {
  const session = sessionById(entry.id);
  const shellId = session?.shellId ?? null;
  if (shellId !== null) {
    void sshPackage()
      .then(ssh =>{  ssh.closeShell(shellId); })
      .catch(() => undefined);
  }
  if (session !== null && (session.shellId !== null || session.pendingCommand !== null)) {
    patchSession(entry.id, { shellId: null, pendingCommand: null });
  }
}

function clearTimer(entry: LiveSession): void {
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

function tmuxAttachCommand(host: SshHost): string {
  const requested = host.tmuxSessionName?.trim() ?? '';
  const name = requested.length === 0 ? DEFAULT_TMUX_SESSION : requested;
  return `tmux new -A -s ${quoteShellArg(name)}\r`;
}

function reasonOf(cause: unknown): SshCloseReason {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const { code } = cause;
    const match = ERROR_CODES.find(candidate => candidate === code);
    if (match !== undefined) {
      return match;
    }
  }
  return 'Protocol';
}
