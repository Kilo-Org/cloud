import { describe, expect, it, vi } from 'vitest';

import { planSshConfigImport } from './config-import';
import { type SshHost } from './hosts';
import { parseSshConfig } from './ssh-config-parse';

// The planner imports the stores, whose ids come from `expo-crypto`. Under Node
// that module loads Expo's runtime setup, which reads `__DEV__`; the mock keeps
// this suite on the pure planner path.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'id-fixture' }));

const existingHost = (label: string, overrides: Partial<SshHost> = {}): SshHost => ({
  id: `id-${label}`,
  label,
  hostname: `${label}.example.com`,
  port: 22,
  username: 'igor',
  authMethod: 'password',
  password: null,
  keyId: null,
  jumpHostId: null,
  tmuxAttach: false,
  tmuxSessionName: null,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  lastConnectedAt: null,
  ...overrides,
});

describe('parseSshConfig', () => {
  it('splits the global section, Host blocks and Match blocks', () => {
    const blocks = parseSshConfig(`
User igor
Port 2222

Host web api
  HostName web.example.com  # trailing comment
  User deploy

Match host *.example.com
  User fallback
`);

    expect(blocks).toEqual([
      {
        kind: 'global',
        entries: [
          { key: 'user', value: 'igor' },
          { key: 'port', value: '2222' },
        ],
      },
      {
        kind: 'host',
        patterns: ['web', 'api'],
        entries: [
          { key: 'hostname', value: 'web.example.com' },
          { key: 'user', value: 'deploy' },
        ],
      },
      { kind: 'match', entries: [{ key: 'user', value: 'fallback' }] },
    ]);
  });

  it('reads an equals form and a quoted value', () => {
    const blocks = parseSshConfig('Host=web\n  IdentityFile "/keys/my key"\n');

    expect(blocks[1]).toEqual({
      kind: 'host',
      patterns: ['web'],
      entries: [{ key: 'identityfile', value: '/keys/my key' }],
    });
  });
});

describe('planSshConfigImport', () => {
  it('imports every non-wildcard pattern and skips the wildcard blocks', () => {
    const plan = planSshConfigImport(
      `
Host *
  User shared

Host web api
  User deploy

Host web-*
  User pool
`,
      []
    );

    expect(plan.hosts.map(host => host.alias)).toEqual(['web', 'api']);
    expect(plan.hosts[0]).toMatchObject({
      alias: 'web',
      hostname: 'web',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      jumpTarget: null,
    });
  });

  it('applies the global directives as defaults', () => {
    const plan = planSshConfigImport(
      `
User igor
Port 2222

Host build
  HostName build.example.com
  Port 2200
`,
      []
    );

    expect(plan.hosts[0]).toMatchObject({ username: 'igor', port: 2200 });
  });

  it('keeps the first value a repeated directive has', () => {
    const plan = planSshConfigImport(
      `
Host web
  User first
  User second
  HostName web.example.com

Host web
  HostName other.example.com
`,
      []
    );

    expect(plan.hosts).toHaveLength(1);
    expect(plan.hosts[0]).toMatchObject({ username: 'first', hostname: 'web.example.com' });
  });

  it('skips a host with no User line and a host with an invalid port', () => {
    const plan = planSshConfigImport(
      `
Host anonymous
  HostName anonymous.example.com

Host broken
  User igor
  Port 99999
`,
      []
    );

    expect(plan.hosts).toEqual([]);
    expect(plan.skipped).toEqual([
      { alias: 'anonymous', reason: 'noUsername' },
      { alias: 'broken', reason: 'invalidPort' },
    ]);
  });

  it('marks a host with an IdentityFile as key auth and says the key is missing', () => {
    const plan = planSshConfigImport(
      `
Host secure
  User igor
  IdentityFile ~/.ssh/id_ed25519
`,
      []
    );

    expect(plan.hosts[0]).toMatchObject({
      authMethod: 'key',
      identityFile: '~/.ssh/id_ed25519',
      warnings: [{ kind: 'needsKey', identityFile: '~/.ssh/id_ed25519' }],
    });
  });

  it('resolves a ProxyJump to a host imported in the same batch', () => {
    const plan = planSshConfigImport(
      `
Host bastion
  User jump

Host internal
  User igor
  ProxyJump bastion
`,
      []
    );

    expect(plan.hosts[1]).toMatchObject({
      alias: 'internal',
      jumpTarget: 'bastion',
      jumpHostId: null,
    });
  });

  it('resolves a ProxyJump to an existing host by label, user and port included', () => {
    const plan = planSshConfigImport(
      `
Host internal
  User igor
  ProxyJump ops@Bastion:2222
`,
      [existingHost('bastion')]
    );

    expect(plan.hosts[0]).toMatchObject({ jumpTarget: 'bastion', jumpHostId: 'id-bastion' });
  });

  it('reports a ProxyJump it cannot resolve and imports the host anyway', () => {
    const plan = planSshConfigImport(
      `
Host internal
  User igor
  ProxyJump unknown-bastion
`,
      []
    );

    expect(plan.hosts[0]).toMatchObject({ jumpTarget: null, jumpHostId: null });
    expect(plan.hosts[0]?.warnings).toEqual([
      { kind: 'jumpHostMissing', target: 'unknown-bastion' },
    ]);
  });

  it('takes the first hop of a multi-hop ProxyJump and says so', () => {
    const plan = planSshConfigImport(
      `
Host edge
  User edge
Host core
  User core
Host internal
  User igor
  ProxyJump edge,core
`,
      []
    );

    expect(plan.hosts[2]).toMatchObject({ jumpTarget: 'edge' });
    expect(plan.hosts[2]?.warnings).toEqual([{ kind: 'jumpHostMultiHop' }]);
  });

  it('keeps one side of a mutual jump and drops the one that would close it', () => {
    const plan = planSshConfigImport(
      `
Host one
  User igor
  ProxyJump two
Host two
  User igor
  ProxyJump one
`,
      []
    );

    expect(plan.hosts[0]).toMatchObject({ jumpTarget: 'two' });
    expect(plan.hosts[0]?.warnings).toEqual([]);
    expect(plan.hosts[1]).toMatchObject({ jumpTarget: null });
    expect(plan.hosts[1]?.warnings).toEqual([{ kind: 'jumpHostCycle', target: 'one' }]);
  });

  it('maps LocalForward and RemoteForward into forwards on the host', () => {
    const plan = planSshConfigImport(
      `
Host web
  User igor
  LocalForward 8080 localhost:80
  LocalForward 127.0.0.1:5432 db.internal:5432
  RemoteForward 9000 localhost:3000
`,
      []
    );

    expect(plan.hosts[0]?.forwards).toEqual([
      {
        direction: 'local',
        bindHost: '127.0.0.1',
        bindPort: 8080,
        destinationHost: 'localhost',
        destinationPort: 80,
      },
      {
        direction: 'local',
        bindHost: '127.0.0.1',
        bindPort: 5432,
        destinationHost: 'db.internal',
        destinationPort: 5432,
      },
      {
        direction: 'remote',
        bindHost: '127.0.0.1',
        bindPort: 9000,
        destinationHost: 'localhost',
        destinationPort: 3000,
      },
    ]);
  });

  it('warns about a forward it cannot store', () => {
    const plan = planSshConfigImport(
      `
Host web
  User igor
  LocalForward 8080 /var/run/docker.sock
`,
      []
    );

    expect(plan.hosts[0]?.forwards).toEqual([]);
    expect(plan.hosts[0]?.warnings).toEqual([
      { kind: 'forwardUnsupported', directive: 'localforward' },
    ]);
  });

  it('starts the imported hosts after the ones already stored', () => {
    const plan = planSshConfigImport('Host web\n  User igor\n', [
      existingHost('a', { sortOrder: 0 }),
      existingHost('b', { sortOrder: 4 }),
    ]);

    expect(plan.startSortOrder).toBe(5);
  });

  it('finds nothing in a config with no hosts', () => {
    expect(planSshConfigImport('# just a comment\nHost *\n  User igor\n', [])).toEqual({
      hosts: [],
      skipped: [],
      startSortOrder: 0,
    });
  });
});
