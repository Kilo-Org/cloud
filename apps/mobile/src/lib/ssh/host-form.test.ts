import { describe, expect, it, vi } from 'vitest';

import { jumpHostCandidates } from './host-form';
import { type SshHost } from './hosts';

// The stores reach `expo-crypto` for ids; under Node its runtime setup reads
// `__DEV__`, which this project does not define.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'id-fixture' }));

const hostOf = (id: string, jumpHostId: string | null): SshHost => ({
  id,
  label: id,
  hostname: `${id}.example.com`,
  port: 22,
  username: 'igor',
  authMethod: 'password',
  password: null,
  keyId: null,
  jumpHostId,
  tmuxAttach: false,
  tmuxSessionName: null,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  lastConnectedAt: null,
});

describe('jumpHostCandidates', () => {
  it('never offers the host itself', () => {
    const hosts = [hostOf('a', null), hostOf('b', null)];

    expect(jumpHostCandidates(hosts, 'a').map(host => host.id)).toEqual(['b']);
  });

  it('hides a host whose chain reaches the host being edited', () => {
    const hosts = [hostOf('outer', null), hostOf('inner', 'outer'), hostOf('leaf', 'inner')];

    expect(jumpHostCandidates(hosts, 'outer').map(host => host.id)).toEqual([]);
    expect(jumpHostCandidates(hosts, 'inner').map(host => host.id)).toEqual(['outer']);
  });

  it('offers every other host while a new host is being created', () => {
    const hosts = [hostOf('a', null), hostOf('b', 'a')];

    expect(jumpHostCandidates(hosts, null).map(host => host.id)).toEqual(['a', 'b']);
  });
});
