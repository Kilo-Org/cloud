import { type ForwardInfo, type SessionInfo } from '../../../../modules/kilo-ssh/src';
import { type AdoptedForward } from '../forwards-runtime';
import { type SshForward } from '../forwards';
import { type SshHost } from '../hosts';
import { hostTarget } from '../host-target';

/**
 * What the app should take over from the native registry after a reload.
 *
 * Android keeps the process — and every socket — alive with the foreground
 * service while a reload throws away the JavaScript runtime, so the registry
 * holds sessions and listeners the new runtime has never seen. These functions
 * decide what to adopt and what to stop from the two facts the native side can
 * state: which sessions are open, and which forwards listen. They are pure, so
 * the reconciliation is testable without a device.
 */

/** `user@host:port`: the shape the app stores and the registry records. */
export function nativeTarget(info: Pick<SessionInfo, 'username' | 'host' | 'port'>): string {
  return `${info.username}@${info.host}:${info.port}`;
}

type AdoptedSession = {
  readonly native: SessionInfo;
  readonly host: SshHost;
  /** The shell the terminal reattaches to; `null` when the shell closed first. */
  readonly shellId: string | null;
};

export type SessionPlan = {
  readonly adopt: readonly AdoptedSession[];
  /** Sessions whose host row is gone: still native, absent from the app. */
  readonly unmatched: readonly SessionInfo[];
};

/**
 * Pairs each native session with the host it was opened for, skipping the ones
 * this runtime already tracks. A host that no longer exists leaves its session
 * running natively but unnameable, which is reported rather than guessed.
 */
export function planSessions(
  nativeSessions: readonly SessionInfo[],
  hosts: readonly SshHost[],
  tracked: ReadonlySet<string>
): SessionPlan {
  const adopt: AdoptedSession[] = [];
  const unmatched: SessionInfo[] = [];

  for (const native of nativeSessions) {
    if (!tracked.has(native.sessionId)) {
      const target = nativeTarget(native);
      const host = hosts.find(candidate => hostTarget(candidate) === target);
      if (host === undefined) {
        unmatched.push(native);
      } else {
        adopt.push({ native, host, shellId: native.shellIds[0] ?? null });
      }
    }
  }

  return { adopt, unmatched };
}

export type ForwardTarget = {
  /** The app session the listeners belong to. */
  readonly sessionId: string;
  readonly forwards: readonly SshForward[];
};

type PlannedForwards = {
  readonly sessionId: string;
  readonly nativeSessionId: string;
  readonly forwards: readonly AdoptedForward[];
};

export type ForwardPlan = {
  readonly adopt: readonly PlannedForwards[];
  /**
   * Listeners no stored row can stop: their forward was deleted while the app
   * was away, so nothing on screen would ever offer to close the port.
   */
  readonly orphans: readonly string[];
};

/**
 * Pairs every listener the registry still holds with the stored forward that
 * opened it. The saved direction and bind address identify the row; the bound
 * port is what the listener reports, which is what the sheet shows.
 */
export function planForwards(
  nativeForwards: readonly ForwardInfo[],
  targets: ReadonlyMap<string, ForwardTarget>
): ForwardPlan {
  const adopt = new Map<string, { targets: ForwardTarget; forwards: AdoptedForward[] }>();
  const orphans: string[] = [];

  for (const native of nativeForwards) {
    const target = targets.get(native.sessionId);
    const stored = target?.forwards.find(
      row =>
        row.direction === native.direction &&
        row.bindHost === native.bindHost &&
        row.bindPort === native.bindPort
    );
    if (target === undefined || stored === undefined) {
      orphans.push(native.forwardId);
    } else {
      const group = adopt.get(native.sessionId) ?? { targets: target, forwards: [] };
      group.forwards.push({
        forwardId: stored.id,
        nativeForwardId: native.forwardId,
        port: native.port,
      });
      adopt.set(native.sessionId, group);
    }
  }

  return {
    adopt: [...adopt].map(([nativeSessionId, group]) => ({
      sessionId: group.targets.sessionId,
      nativeSessionId,
      forwards: group.forwards,
    })),
    orphans,
  };
}

/** App session ids whose native connection is gone, from the manager's own state. */
export function planStale(
  entries: readonly { id: string; nativeSessionId: string | null }[],
  alive: ReadonlySet<string>
): readonly string[] {
  return entries
    .filter(entry => entry.nativeSessionId !== null && !alive.has(entry.nativeSessionId))
    .map(entry => entry.id);
}
