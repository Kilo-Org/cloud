import { type ForwardInfo, type SessionInfo } from '../../../../modules/kilo-ssh/src';

import { adoptForwards, resetSessionForwards } from '../forwards-runtime';
import { listForwardsForHost } from '../forwards';
import { listHosts } from '../hosts';
import { newId } from '../id';
import { sshPackage } from '../native';
import { sshDatabase } from '../store';
import { forgetIdleNotify } from './idle-notify';
import { live } from './live';
import { ensureSshEvents } from './manager';
import {
  type ForwardTarget,
  nativeTarget,
  planForwards,
  planSessions,
  planStale,
} from './rehydrate-plan';
import { patchSession, writeSession } from './session-store';

export type Rehydration = {
  readonly adopted: number;
  readonly closed: number;
  readonly orphans: number;
  readonly unmatched: number;
};

const NOTHING: Rehydration = { adopted: 0, closed: 0, orphans: 0, unmatched: 0 };

/** What the native registry still holds, in the shape a plan reads it. */
type RegistrySnapshot = Readonly<{
  sessions: SessionInfo[];
  forwards: ForwardInfo[];
}>;

/**
 * Brings the manager back in line with the native registry.
 *
 * A build without the module, or any failure reading the registry, leaves the
 * app exactly as it was: rehydration is an improvement over a stale screen, not
 * something a session may fail on.
 */
export async function rehydrateSshSessions(): Promise<Rehydration> {
  const registry = await readRegistry();
  if (registry === null) {
    return NOTHING;
  }

  const alive = new Set(registry.sessions.map(session => session.sessionId));
  const stale = planStale([...live.values()], alive);
  for (const id of stale) {
    closeStale(id);
  }

  const db = await sshDatabase();
  const hosts = listHosts(db);
  const tracked = new Set(
    [...live.values()].map(entry => entry.nativeSessionId).filter((id): id is string => id !== null)
  );
  const plan = planSessions(registry.sessions, hosts, tracked);
  const adoptedTargets = new Map<string, ForwardTarget>();

  for (const item of plan.adopt) {
    const id = newId();
    live.set(id, {
      id,
      host: item.host,
      nativeSessionId: item.native.sessionId,
      attempt: 1,
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
    });
    writeSession({
      id,
      hostId: item.host.id,
      label: item.host.label,
      target: nativeTarget(item.native),
      startedAt: Date.now(),
      phase: { kind: 'connected' },
      shellId: item.shellId,
      nativeSessionId: item.native.sessionId,
      pendingCommand: null,
    });
    adoptedTargets.set(item.native.sessionId, {
      sessionId: id,
      forwards: listForwardsForHost(db, item.host.id),
    });
  }

  for (const entry of live.values()) {
    if (entry.nativeSessionId !== null && !adoptedTargets.has(entry.nativeSessionId)) {
      adoptedTargets.set(entry.nativeSessionId, {
        sessionId: entry.id,
        forwards: listForwardsForHost(db, entry.host.id),
      });
    }
  }

  const forwards = planForwards(registry.forwards, adoptedTargets);
  for (const group of forwards.adopt) {
    adoptForwards(group.sessionId, group.nativeSessionId, group.forwards);
  }
  await stopOrphans(forwards.orphans);

  return {
    adopted: plan.adopt.length,
    closed: stale.length,
    orphans: forwards.orphans.length,
    unmatched: plan.unmatched.length,
  };
}

async function readRegistry(): Promise<RegistrySnapshot | null> {
  try {
    const ssh = await sshPackage();
    await ensureSshEvents();
    return {
      sessions: await ssh.listSessions(),
      forwards: await ssh.listForwards(),
    };
  } catch {
    return null;
  }
}

/**
 * A session whose socket died while nothing was listening: the app keeps its
 * screen, but nothing in it may still claim a connection.
 */
function closeStale(id: string): void {
  const entry = live.get(id);
  if (entry !== undefined) {
    entry.nativeSessionId = null;
    entry.jumpSessionIds = [];
    entry.connecting = false;
  }
  patchSession(id, {
    phase: { kind: 'closed', reason: 'disconnected', retryable: false },
    shellId: null,
    nativeSessionId: null,
    pendingCommand: null,
  });
  forgetIdleNotify(id);
  void resetSessionForwards(id);
}

async function stopOrphans(orphans: readonly string[]): Promise<void> {
  if (orphans.length === 0) {
    return;
  }
  try {
    const ssh = await sshPackage();
    await Promise.all(
      orphans.map(orphan =>
        ssh.stopForwardById(orphan).catch(() => {
          // The connection the listener ran on is already gone.
        })
      )
    );
  } catch {
    // Without the module there is nothing listening to stop.
  }
}
