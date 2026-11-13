import { router } from 'expo-router';
import { useEffect, useState } from 'react';

import { queryClient } from '@/lib/query-client';

import { createForward } from './forwards';
import { hostTarget } from './host-target';
import { createHost, type SshHost } from './hosts';
import { createKey } from './keys';
import { trustHostKey } from './known-hosts';
import { sshPackage } from './native';
import { SSH_HOSTS_ROUTE, SSH_KNOWN_HOSTS_ROUTE, sshHostPath, sshSessionPath } from './routes';
import { writeSession } from './session/session-store';
import  { type SshSessionPhase } from './session/types';
import { sshDatabase } from './store';
import { SSH_KEY } from './use-ssh';

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
  privateKeyOpenssh:
    '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----',
  publicKeyOpenssh: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureLaptopKey laptop',
  fingerprintSha256: 'SHA256:laptopFixtureFingerprint',
} as const;

function log(message: string): void {
  // eslint-disable-next-line no-console -- dev-only harness feedback in the Metro log
  console.info(`[ssh-fixture] ${message}`);
}

/**
 * The store writes rows behind React Query's back, so a screen seeded after it
 * mounted would keep the list it read before. Resetting the ssh key drops every
 * cached read and refetches the mounted ones.
 */
async function resetSshQueries(): Promise<void> {
  await queryClient.resetQueries({ queryKey: SSH_KEY });
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

/** Coloured sample output, so the gate photographs the real palette. */
const SAMPLE_OUTPUT = [
  '\u001B[32mdeploy@web-1\u001B[0m:\u001B[34m~\u001B[0m$ ls -la',
  'total 28',
  'drwxr-xr-x  4 deploy deploy 4096 Nov 13 07:10 \u001B[34mapp\u001B[0m',
  '-rw-r--r--  1 deploy deploy  918 Nov 13 07:09 README.md',
  '\u001B[32mdeploy@web-1\u001B[0m:\u001B[34m~\u001B[0m$ npm run check',
  '\u001B[33mwarn\u001B[0m 3 packages are looking for funding',
  '\u001B[32mok\u001B[0m 41 tests passed',
  '\u001B[31merror\u001B[0m nothing failed, this line only shows the error colour',
  '\u001B[32mdeploy@web-1\u001B[0m:\u001B[34m~\u001B[0m$ ',
].join('\r\n');

const SESSION_HOST = {
  label: 'web-1',
  hostname: 'web-1.kilo.test',
  port: 2222,
  username: 'deploy',
};

function sessionHostKey(knownFingerprintSha256: string | null) {
  return {
    requestId: 'fixture-request',
    hostPattern: '[fixture-web-1.kilo.test]:2222',
    algorithm: 'ssh-ed25519',
    publicKeyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIFixtureSessionKey',
    fingerprintSha256: 'SHA256:fixtureSessionFingerprint',
    knownFingerprintSha256,
  };
}

function fixturePhase(name: string): SshSessionPhase | null {
  switch (name) {
    case 'trust': {
      return { kind: 'awaiting-host-key', hostKey: sessionHostKey(null) };
    }
    case 'blocked': {
      return {
        kind: 'awaiting-host-key',
        hostKey: sessionHostKey('SHA256:fixtureStoredFingerprint'),
      };
    }
    case 'prompts': {
      return {
        kind: 'awaiting-prompts',
        prompts: {
          requestId: 'fixture-request',
          name: 'Two-factor authentication',
          instructions: 'Enter the code from your authenticator app.',
          prompts: [
            { text: 'Password: ', echo: false },
            { text: 'Verification code: ', echo: true },
          ],
        },
      };
    }
    case 'password': {
      return { kind: 'awaiting-password', failed: true };
    }
    case 'reconnecting': {
      return { kind: 'reconnecting', attempt: 2, reason: 'Network' };
    }
    case 'closed': {
      return { kind: 'closed', reason: 'Network', retryable: true };
    }
    default: {
      return null;
    }
  }
}

/**
 * One session in a named state, then its terminal screen. The connected state
 * gets a JavaScript-fed terminal source with real output; every other state is
 * a phase the screen renders without a connection.
 */
async function seedSession(name: string): Promise<string> {
  const db = await sshDatabase();
  const host = createHost(db, { ...SESSION_HOST, authMethod: 'password' });
  const sessionId = `fixture-session-${name}`;
  const phase = fixturePhase(name) ?? { kind: 'connected' as const };
  const shellId =
    phase.kind === 'connected' ? await openSampleShell(host.label) : null;

  writeSession({
    id: sessionId,
    hostId: host.id,
    label: host.label,
    target: hostTarget(host),
    startedAt: Date.now(),
    phase,
    shellId,
    pendingCommand: null,
  });
  return sessionId;
}

async function openSampleShell(label: string): Promise<string> {
  const ssh = await sshPackage();
  const source = ssh.createFeedSource();
  // The sample is ASCII, so one byte per character is its UTF-8 encoding.
  const text = `Welcome to ${label}\r\n${SAMPLE_OUTPUT}`;
  source.feed(Uint8Array.from(text, character => character.charCodeAt(0)));
  // A second session beside it, so the switcher has more than one row.
  writeSession({
    id: 'fixture-session-second',
    hostId: 'fixture-host-second',
    label: 'db-primary',
    target: 'igor@10.0.0.12:22',
    startedAt: Date.now() - 60_000,
    phase: { kind: 'closed', reason: 'disconnected', retryable: true },
    shellId: null,
    pendingCommand: null,
  });
  return source.sourceId;
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
