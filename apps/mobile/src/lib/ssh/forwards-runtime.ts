import { type Forward } from '@kilocode/react-native-ssh';

import { type SshForward } from './forwards';
import { nativeErrorCode, sshPackage } from './native';

/** What a stored forward is doing right now. */
export type ForwardStatus =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'listening'; readonly port: number }
  | { readonly kind: 'failed'; readonly code: string | null };

type SessionForwards = {
  statuses: Map<string, ForwardStatus>;
  handles: Map<string, Forward>;
  nativeSessionId: string | null;
};

const sessions = new Map<string, SessionForwards>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, ReadonlyMap<string, ForwardStatus>> = new Map();

export function subscribeForwards(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every session's forwards, by session id and then forward id. */
export function forwardsSnapshot(): ReadonlyMap<string, ReadonlyMap<string, ForwardStatus>> {
  return snapshot;
}

const STOPPED: ForwardStatus = { kind: 'stopped' };

function publish(): void {
  const next = new Map<string, ReadonlyMap<string, ForwardStatus>>();
  for (const [sessionId, entry] of sessions) {
    next.set(sessionId, new Map(entry.statuses));
  }
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function entryFor(sessionId: string): SessionForwards {
  const existing = sessions.get(sessionId);
  if (existing) {
    return existing;
  }
  const created: SessionForwards = {
    statuses: new Map(),
    handles: new Map(),
    nativeSessionId: null,
  };
  sessions.set(sessionId, created);
  return created;
}

function setStatus(sessionId: string, forwardId: string, status: ForwardStatus): void {
  entryFor(sessionId).statuses.set(forwardId, status);
  publish();
}

/**
 * Starts one stored forward on the session's connection. A forward already
 * starting or listening is left alone, so a double press cannot open a second
 * listener on the same port.
 */
export async function startForward(
  sessionId: string,
  nativeSessionId: string,
  forward: SshForward
): Promise<void> {
  const entry = entryFor(sessionId);
  entry.nativeSessionId = nativeSessionId;
  const current = entry.statuses.get(forward.id) ?? STOPPED;
  if (current.kind === 'starting' || current.kind === 'listening') {
    return;
  }
  setStatus(sessionId, forward.id, { kind: 'starting' });
  try {
    const ssh = await sshPackage();
    const config = {
      bindHost: forward.bindHost,
      bindPort: forward.bindPort,
      destHost: forward.destinationHost,
      destPort: forward.destinationPort,
    };
    const handle =
      forward.direction === 'local'
        ? await ssh.startLocalForward(nativeSessionId, config)
        : await ssh.startRemoteForward(nativeSessionId, config);
    if (!sessions.has(sessionId)) {
      await stopQuietly(handle);
      return;
    }
    entry.handles.set(forward.id, handle);
    setStatus(sessionId, forward.id, { kind: 'listening', port: handle.port });
  } catch (error) {
    if (!sessions.has(sessionId)) {
      return;
    }
    setStatus(sessionId, forward.id, { kind: 'failed', code: nativeErrorCode(error) });
  }
}

export async function stopForward(sessionId: string, forwardId: string): Promise<void> {
  const entry = sessions.get(sessionId);
  const handle = entry?.handles.get(forwardId);
  entry?.handles.delete(forwardId);
  setStatus(sessionId, forwardId, STOPPED);
  if (handle) {
    await stopQuietly(handle);
  }
}

/**
 * Starts every forward the host marks as auto-start. A reconnect starts from a
 * clean slate: the previous listeners belonged to a connection that is gone.
 */
export async function autoStartForwards(
  sessionId: string,
  nativeSessionId: string,
  forwards: readonly SshForward[]
): Promise<void> {
  await resetSessionForwards(sessionId);
  entryFor(sessionId).nativeSessionId = nativeSessionId;
  await Promise.all(
    forwards
      .filter(forward => forward.autoStart)
      .map(forward => startForward(sessionId, nativeSessionId, forward))
  );
}

/**
 * The package reported a forward failure on a native session. The event names
 * no forward, so every listener of that connection is marked failed: the
 * session-level failure is what took them down.
 */
export function handleForwardError(nativeSessionId: string): void {
  const entry = [...sessions.values()].find(item => item.nativeSessionId === nativeSessionId);
  if (entry === undefined) {
    return;
  }
  entry.handles.clear();
  for (const [forwardId, status] of entry.statuses) {
    if (status.kind === 'listening' || status.kind === 'starting') {
      entry.statuses.set(forwardId, { kind: 'failed', code: 'Forwarding' });
    }
  }
  publish();
}

/** Ends every listener of the session and forgets its state. */
export async function resetSessionForwards(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId);
  if (entry === undefined) {
    return;
  }
  sessions.delete(sessionId);
  publish();
  await Promise.all([...entry.handles.values()].map(handle => stopQuietly(handle)));
}

async function stopQuietly(handle: Forward): Promise<void> {
  try {
    await handle.stop();
  } catch {
    // The connection the listener ran on is already gone.
  }
}

/**
 * The destination ports a local forward would serve over HTTP. A forward to one
 * of them is reachable from the device's browser at its own bind port.
 */
const HTTP_PORTS: ReadonlySet<number> = new Set([80, 3000, 5000, 8000, 8001, 8080, 8081, 8888]);

/** Whether a listening local forward serves a page the in-app browser can open. */
export function isHttpForward(forward: Pick<SshForward, 'direction' | 'destinationPort'>): boolean {
  return forward.direction === 'local' && HTTP_PORTS.has(forward.destinationPort);
}

export function localForwardUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}
