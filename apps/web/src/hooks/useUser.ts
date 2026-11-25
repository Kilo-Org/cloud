import { useQuery } from '@tanstack/react-query';
import type { ClientUser } from '@/lib/user/client-user';

async function fetchUser(): Promise<ClientUser | null> {
  const res = await fetch('/api/user');
  if (res.status === 401 || res.status === 403) {
    return null;
  }
  if (!res.ok) {
    throw new Error('Failed to fetch user');
  }
  return res.json() as Promise<ClientUser>;
}

export function useUser() {
  return useQuery({
    queryKey: ['user'],
    queryFn: fetchUser,
  });
}
