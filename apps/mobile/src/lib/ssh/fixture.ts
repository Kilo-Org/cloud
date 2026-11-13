import { router } from 'expo-router';
import { useEffect, useState } from 'react';

import { createForward } from './forwards';
import { createHost, type SshHost } from './hosts';
import { createKey } from './keys';
import { trustHostKey } from './known-hosts';
import { SSH_HOSTS_ROUTE, SSH_KNOWN_HOSTS_ROUTE, sshHostPath } from './routes';
import { sshDatabase } from './store';

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

const KNOWN_HOSTS = [
  {
    hostPattern: '[web-1.kilo.test]:2222',
    keyAlgorithm: 'ssh-ed25519',
    publicKeyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIFixtureWebKey',
    fingerprintSha256: 'SHA256:web1FixtureFingerprint',
  },
  {
    hostPattern: 'bastion.kilo.test',
    keyAlgorithm: 'ssh-rsa',
    publicKeyBase64: 'AAAAB3NzaC1yc2EAAAADAQABAAABAQFixtureBastionKey',
    fingerprintSha256: 'SHA256:bastionFixtureFingerprint',
  },
];

const FIXTURE_KEY = {
  label: 'laptop',
  algorithm: 'ed25519',
  source: 'generated',
  privateKeyOpenssh: '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----',
  publicKeyOpenssh: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureLaptopKey laptop',
  fingerprintSha256: 'SHA256:laptopFixtureFingerprint',
} as const;

function log(message: string): void {
  // eslint-disable-next-line no-console -- dev-only harness feedback in the Metro log
  console.info(`[ssh-fixture] ${message}`);
}

async function clearSshRows(): Promise<void> {
  const db = await sshDatabase();
  db.withTransactionSync(() => {
    db.runSync('delete from ssh_forwards', []);
    db.runSync('delete from ssh_snippets', []);
    db.runSync('delete from ssh_known_hosts', []);
    db.runSync('delete from ssh_hosts', []);
    db.runSync('delete from ssh_keys', []);
  });
}

async function seedHostList(): Promise<void> {
  const db = await sshDatabase();
  const bastion = createHost(db, {
    label: 'bastion',
    hostname: 'bastion.kilo.test',
    username: 'ops',
    authMethod: 'password',
  });
  const web = createHost(db, {
    label: 'web-1',
    hostname: 'web-1.kilo.test',
    port: 2222,
    username: 'deploy',
    authMethod: 'password',
  });
  createHost(db, {
    label: 'db-primary',
    hostname: '10.0.0.12',
    username: 'igor',
    authMethod: 'password',
    jumpHostId: bastion.id,
    tmuxAttach: true,
    tmuxSessionName: 'db',
  });
  createKey(db, FIXTURE_KEY);
  createForward(db, {
    hostId: web.id,
    direction: 'local',
    bindPort: 8080,
    destinationHost: 'localhost',
    destinationPort: 80,
  });
  for (const knownHost of KNOWN_HOSTS) {
    trustHostKey(db, knownHost);
  }
}

async function seedEditor(keyAuth: boolean): Promise<SshHost> {
  const db = await sshDatabase();
  const key = keyAuth ? createKey(db, FIXTURE_KEY) : null;
  return createHost(db, {
    label: keyAuth ? 'web-1' : 'home-server',
    hostname: keyAuth ? 'web-1.kilo.test' : 'home.kilo.test',
    port: keyAuth ? 2222 : 22,
    username: keyAuth ? 'deploy' : 'igor',
    authMethod: keyAuth ? 'key' : 'password',
    keyId: key?.id ?? null,
  });
}

async function seedKnownHosts(): Promise<void> {
  const db = await sshDatabase();
  for (const knownHost of KNOWN_HOSTS) {
    trustHostKey(db, knownHost);
  }
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
    await clearSshRows();
    if (name === 'hosts') {
      await seedHostList();
      router.replace(SSH_HOSTS_ROUTE);
    } else if (name === 'empty') {
      router.replace(SSH_HOSTS_ROUTE);
    } else if (name === 'known-hosts') {
      await seedKnownHosts();
      router.replace(SSH_KNOWN_HOSTS_ROUTE);
    } else if (name === 'known-hosts-empty') {
      router.replace(SSH_KNOWN_HOSTS_ROUTE);
    } else if (name === 'editor-password' || name === 'editor-key') {
      const host = await seedEditor(name === 'editor-key');
      router.replace(sshHostPath(host.id));
    } else {
      log(`unknown fixture ${name}`);
    }
  })();
  return true;
}
