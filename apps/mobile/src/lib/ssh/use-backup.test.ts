import { expect, it, vi } from 'vitest';

import { useSshBackup } from './use-backup';

const state = vi.hoisted(() => ({ options: null as unknown }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => {
    state.options = options;
    return {};
  },
}));
vi.mock('./use-ssh', () => ({ SSH_KEY: ['ssh'] }));
vi.mock('./use-ssh-client-enabled', () => ({ useSshClientEnabled: () => true }));
vi.mock('./store', () => ({ sshDatabase: () => Promise.resolve({}) }));
vi.mock('./backup-payload', () => ({ readSshBackup: () => ({}) }));

it('reads the on-device backup instead of waiting for the connectivity manager', () => {
  useSshBackup();
  expect(state.options).toMatchObject({ enabled: true, networkMode: 'always' });
});
