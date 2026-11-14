import { useQuery } from '@tanstack/react-query';

import { readSshBackup } from './backup-payload';
import { sshDatabase } from './store';
import { SSH_KEY } from './use-ssh';
import { useSshClientEnabled } from './use-ssh-client-enabled';

export function useSshBackup() {
  const enabled = useSshClientEnabled();
  return useQuery({
    queryKey: [...SSH_KEY, 'backup'],
    enabled,
    queryFn: async () => readSshBackup(await sshDatabase()),
  });
}
