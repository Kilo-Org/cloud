import { queryClient } from '@/lib/query-client';

import { createForward } from './forwards';
import { hostTarget } from './host-target';
import { createHost, type SshHost } from './hosts';
import { createKey } from './keys';
import { trustHostKey } from './known-hosts';
import { sshPackage } from './native';
import { writeSession } from './session/session-store';
import { type SshSessionPhase } from './session/types';
import { sshDatabase } from './store';
import { SSH_KEY } from './use-ssh';

/** What every dev fixture writes through, and the rows each one seeds. */

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

/**
 * The store writes rows behind React Query's back, so a screen seeded after it
 * mounted would keep the list it read before. Resetting the ssh key drops every
 * cached read and refetches the mounted ones.
 */
export async function resetSshQueries(): Promise<void> {
  await queryClient.resetQueries({ queryKey: SSH_KEY });
}

export async function clearSshRows(): Promise<void> {
  const db = await sshDatabase();
  db.withTransactionSync(() => {
    db.runSync('delete from ssh_forwards', []);
    db.runSync('delete from ssh_snippets', []);
    db.runSync('delete from ssh_known_hosts', []);
    db.runSync('delete from ssh_hosts', []);
    db.runSync('delete from ssh_keys', []);
  });
}

export async function seedHostList(): Promise<void> {
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

export async function seedEditor(keyAuth: boolean): Promise<SshHost> {
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

export async function seedKnownHosts(): Promise<void> {
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
      return { kind: 'awaiting-password', failed: true, label: null };
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
export async function seedSession(name: string): Promise<string> {
  const db = await sshDatabase();
  const host = createHost(db, { ...SESSION_HOST, authMethod: 'password' });
  const sessionId = `fixture-session-${name}`;
  const phase = fixturePhase(name) ?? { kind: 'connected' as const };
  const shellId = phase.kind === 'connected' ? await openSampleShell(host.label) : null;

  writeSession({
    id: sessionId,
    hostId: host.id,
    label: host.label,
    target: hostTarget(host),
    startedAt: Date.now(),
    phase,
    shellId,
    nativeSessionId: null,
    pendingCommand: null,
  });
  return sessionId;
}

async function openSampleShell(label: string): Promise<string> {
  const ssh = await sshPackage();
  const source = ssh.createFeedSource();
  const sample = new TextEncoder().encode(`Welcome to ${label}\r\n${SAMPLE_OUTPUT}`);
  // The view takes the source's sink when it attaches, and bytes written before
  // that have nowhere to go, so the sample waits for the first resize the
  // attached view reports.
  const feedOnce = () => {
    stopListening();
    source.feed(sample);
  };
  const stopListening = source.onResize(feedOnce);
  // A second session beside it, so the switcher has more than one row.
  writeSession({
    id: 'fixture-session-second',
    hostId: 'fixture-host-second',
    label: 'db-primary',
    target: 'igor@10.0.0.12:22',
    startedAt: Date.now() - 60_000,
    phase: { kind: 'closed', reason: 'disconnected', retryable: true },
    shellId: null,
    nativeSessionId: null,
    pendingCommand: null,
  });
  return source.sourceId;
}

/**
 * One host with forwards and a session whose files screen the gate can open.
 * The session has no native connection, so the browser itself stays in its
 * waiting state; the surfaces the gate photographs are the tray, the preview
 * and the forwards sheet over it.
 */
export async function seedFilesSurfaces(): Promise<{ sessionId: string; hostId: string }> {
  const db = await sshDatabase();
  const host = createHost(db, { ...SESSION_HOST, authMethod: 'password' });
  createForward(db, {
    hostId: host.id,
    direction: 'local',
    bindPort: 8080,
    destinationHost: '127.0.0.1',
    destinationPort: 80,
    autoStart: true,
    label: 'Web app',
  });
  createForward(db, {
    hostId: host.id,
    direction: 'remote',
    bindPort: 9000,
    destinationHost: '127.0.0.1',
    destinationPort: 3000,
    autoStart: false,
    label: null,
  });
  createForward(db, {
    hostId: host.id,
    direction: 'local',
    bindPort: 5432,
    destinationHost: 'db.internal',
    destinationPort: 5432,
    autoStart: false,
    label: 'Postgres',
  });
  const sessionId = 'fixture-files-session';
  writeSession({
    id: sessionId,
    hostId: host.id,
    label: host.label,
    target: hostTarget(host),
    startedAt: Date.now(),
    phase: { kind: 'connected' },
    shellId: null,
    nativeSessionId: null,
    pendingCommand: null,
  });
  return { sessionId, hostId: host.id };
}
