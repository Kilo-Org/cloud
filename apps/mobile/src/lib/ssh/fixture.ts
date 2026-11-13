import { router } from 'expo-router';
import { useEffect, useState } from 'react';

import {
  clearSshRows,
  log,
  resetSshQueries,
  seedEditor,
  seedFilesSurfaces,
  seedHostList,
  seedKnownHosts,
  seedSession,
} from './fixture-seeds';
import {
  SSH_HOSTS_ROUTE,
  SSH_KNOWN_HOSTS_ROUTE,
  sshFilesPath,
  sshHostPath,
  sshSessionPath,
} from './routes';

/**
 * Dev-only SSH fixtures, reached as `kiloapp:///dev/ssh-fixture/<name>`.
 *
 * They write through the app's own stores, so a seeded screen is the screen a
 * person who added those rows sees. The only entry point is
 * `+native-intent.tsx`, behind `__DEV__`.
 *
 * - `hosts`: three hosts, one of them behind a jump host, with a key and two
 *   trusted host keys, then opens the hosts list.
 * - `empty`: clears the ssh tables, then opens the hosts list.
 * - `known-hosts`: two trusted host keys, then opens the known-hosts screen.
 * - `known-hosts-empty`: clears the ssh tables, then opens that screen.
 * - `editor-password` / `editor-key`: one host (the second with a stored key),
 *   then opens its editor.
 * - `session-connected`, `session-trust`, `session-blocked`, `session-prompts`,
 *   `session-password`, `session-reconnecting`, `session-closed`: one session in
 *   that state, then opens its terminal screen. The connected state renders a
 *   `createFeedSource()` terminal with sample output, so the gate measures the
 *   real view rather than a placeholder; the others never open a connection.
 *   These records are written straight into the session store: the screen reads
 *   the same shape the manager writes, but there is no native session behind
 *   them, so the header's retry and close do nothing.
 */

const FIXTURE_PATH = /(?:^|\/)dev\/ssh-fixture\/([\w-]+)\/?(?:[?#].*)?$/;

let flagOn = false;
const flagListeners = new Set<() => void>();

function setFlagOn(next: boolean): void {
  if (flagOn === next) {
    return;
  }
  flagOn = next;
  for (const listener of flagListeners) {
    listener();
  }
}

/**
 * The SSH flag, forced on for a dev fixture. The Home entry reads it beside the
 * remote flag, so a build with no PostHog key can still show the row the design
 * gate captures. Always false outside a development build.
 */
export function useSshFixtureFlag(): boolean {
  const [on, setOn] = useState(flagOn);
  useEffect(() => {
    if (!__DEV__) {
      return undefined;
    }
    const listener = () => {
      setOn(flagOn);
    };
    flagListeners.add(listener);
    return () => {
      flagListeners.delete(listener);
    };
  }, []);
  return __DEV__ && on;
}

/**
 * Handle a fixture link. True when the path names this fixture (it seeds and
 * navigates itself), so the caller returns falsy and nothing else resolves the
 * link.
 */
export function handleSshFixturePath(path: string): boolean {
  const name = FIXTURE_PATH.exec(path)?.[1];
  if (name === undefined) {
    return false;
  }
  if (name === 'flag-on') {
    setFlagOn(true);
    log('flag on');
    router.replace('/');
    return true;
  }
  if (name === 'flag-off') {
    setFlagOn(false);
    log('flag off');
    return true;
  }
  void (async () => {
    // A prompt sheet from the previous fixture is a modal over the screen the
    // next link opens, so a run of links would measure one screen repeatedly.
    if (router.canDismiss()) {
      router.dismissAll();
    }
    await clearSshRows();
    if (name === 'hosts') {
      await seedHostList();
      await resetSshQueries();
      router.replace(SSH_HOSTS_ROUTE);
    } else if (name === 'empty') {
      await resetSshQueries();
      router.replace(SSH_HOSTS_ROUTE);
    } else if (name === 'known-hosts') {
      await seedKnownHosts();
      await resetSshQueries();
      router.replace(SSH_KNOWN_HOSTS_ROUTE);
    } else if (name === 'known-hosts-empty') {
      await resetSshQueries();
      router.replace(SSH_KNOWN_HOSTS_ROUTE);
    } else if (name === 'editor-password' || name === 'editor-key') {
      const host = await seedEditor(name === 'editor-key');
      await resetSshQueries();
      router.replace(sshHostPath(host.id));
    } else if (name === 'files-transfers' || name === 'files-preview' || name === 'forwards') {
      const seeded = await seedFilesSurfaces();
      await resetSshQueries();
      router.replace(sshFilesPath(seeded.sessionId, { dev: filesDevSurface(name) }));
    } else if (name === 'forwards-editor') {
      const seeded = await seedFilesSurfaces();
      await resetSshQueries();
      router.replace(sshHostPath(seeded.hostId));
    } else if (name.startsWith('session-')) {
      const state = name.slice('session-'.length);
      const sessionId = await seedSession(state);
      await resetSshQueries();
      router.replace(sshSessionPath(sessionId));
    } else {
      log(`unknown fixture ${name}`);
    }
  })();
  return true;
}

function filesDevSurface(name: string): 'transfers' | 'preview' | 'forwards' {
  if (name === 'forwards') {
    return 'forwards';
  }
  return name === 'files-preview' ? 'preview' : 'transfers';
}
