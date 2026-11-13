import {
  type DisconnectNotice,
  type HostKeyRequest,
  type KeyboardInteractiveRequest,
} from '../../../../modules/kilo-ssh/src';

import { hostPattern } from '../known-host-pattern';
import { findKnownHost, trustHostKey } from '../known-hosts';
import { sshPackage } from '../native';
import { sshDatabase } from '../store';
import { fail, forgetSession } from './attempt';
import { type HostKeyVerdict, judgeHostKey } from './host-key';
import { live, type LiveSession, setPhase, stillOpen } from './live';
import { patchSession } from './session-store';
import { type SshHostKeyAwaiting, type SshHostKeyDecision } from './types';

/** A host key was offered: judge it against the store and ask if it is new. */
export function handleHostKey(request: HostKeyRequest): void {
  const entry = findConnecting(request.host, request.port);
  if (entry === null) {
    void answerHostKey(request.requestId, false);
    return;
  }
  void judgeOfferedKey(entry, request);
}

/** Answers the host-key sheet of a session. */
export function respondToHostKey(
  entry: LiveSession,
  pending: SshHostKeyAwaiting,
  decision: SshHostKeyDecision
): void {
  void recordDecision(entry, pending, decision);
}

/** Answers one keyboard-interactive round; `null` cancels authentication. */
export function answerPrompts(requestId: string, answers: string[] | null): void {
  void sendPrompts(requestId, answers);
}

/** The native connection ended under its session, or under one of its hops. */
export function handleDisconnect(notice: DisconnectNotice): void {
  for (const entry of live.values()) {
    if (entry.nativeSessionId === notice.sessionId) {
      entry.nativeSessionId = null;
      patchSession(entry.id, { nativeSessionId: null });
      // The core reports a disconnect before it has released the session, and
      // a session left in its registry keeps the connection state the next
      // attempt to the same host waits on. Closing it is what lets a retry
      // reach the network again.
      void forgetSession(notice.sessionId);
      fail(entry, 'disconnected');
      return;
    }
    const hop = entry.jumpSessionIds.indexOf(notice.sessionId);
    if (hop !== -1) {
      // A hop that dropped takes the target's path with it, so the whole chain
      // is retried from the outermost surviving session.
      entry.jumpSessionIds.splice(hop, 1);
      void forgetSession(notice.sessionId);
      fail(entry, 'disconnected');
      return;
    }
  }
}

/** A keyboard-interactive round the server is waiting on. */
export function handlePrompts(request: KeyboardInteractiveRequest): void {
  const entry = findAwaitingPrompts();
  if (entry === null) {
    answerPrompts(request.requestId, null);
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

async function judgeOfferedKey(entry: LiveSession, request: HostKeyRequest): Promise<void> {
  const awaiting: SshHostKeyAwaiting = {
    requestId: request.requestId,
    hostPattern: hostPattern(request.host, request.port),
    algorithm: request.algorithm,
    publicKeyBase64: request.publicKeyBase64,
    fingerprintSha256: request.fingerprintSha256,
    knownFingerprintSha256: null,
  };
  const verdict = await readVerdict(awaiting);
  if (verdict === null || !stillOpen(entry)) {
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

/** The store's verdict, or `null` when it cannot be read: then the key is refused. */
async function readVerdict(awaiting: SshHostKeyAwaiting): Promise<HostKeyVerdict | null> {
  try {
    const db = await sshDatabase();
    return judgeHostKey(db, awaiting);
  } catch {
    return null;
  }
}

async function recordDecision(
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
      // The connection is still trusted for its own lifetime; the next one asks
      // again because nothing was stored.
    }
  }
  setPhase(entry, { kind: 'connecting', attempt: entry.attempt });
  await answerHostKey(pending.requestId, true);
}

async function answerHostKey(requestId: string, accept: boolean): Promise<void> {
  try {
    const ssh = await sshPackage();
    ssh.answerHostKey(requestId, accept);
  } catch {
    // The package is gone, and the pending request with it.
  }
}

async function sendPrompts(requestId: string, answers: string[] | null): Promise<void> {
  try {
    const ssh = await sshPackage();
    ssh.answerPrompts(requestId, answers);
  } catch {
    // The package is gone, and the pending request with it.
  }
}

/**
 * The session a host key belongs to. The core reports the key before it hands
 * back a session id, so the attempt in flight for that host — the target or one
 * of its hops — is the one the key decides for.
 */
function findConnecting(host: string, port: number): LiveSession | null {
  for (const entry of live.values()) {
    if (
      entry.connecting &&
      entry.connectTargets.some(target => target.host === host && target.port === port)
    ) {
      return entry;
    }
  }
  return null;
}

/** The session a keyboard-interactive round belongs to, for the same reason. */
function findAwaitingPrompts(): LiveSession | null {
  for (const entry of live.values()) {
    if (entry.connecting && entry.prompts === null && entry.promptsHostId !== null) {
      return entry;
    }
  }
  return null;
}
