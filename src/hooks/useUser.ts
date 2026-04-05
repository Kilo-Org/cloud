import { useQuery } from '@tanstack/react-query';
import type { User } from '@kilocode/db/schema';

async function fetchUser(): Promise<User | null> {
  const res = await fetch('/api/user');
  if (res.status === 401 || res.status === 403) {
    return null;
  }
  if (!res.ok) {
    throw new Error('Failed to fetch user');
  }
  return res.json() as Promise<User>;
}

export function useUser() {
  return useQuery({
    queryKey: ['user'],
    queryFn: fetchUser,
  });
}
