import { useQuery } from '@tanstack/react-query';

type User = {
  id: string;
  google_user_email: string;
  google_user_name: string | null;
};

type SearchUsersResponse = {
  users: User[];
};

export function useSearchUsers(searchTerm: string) {
  return useQuery({
    queryKey: ['search-users', searchTerm],
    queryFn: async (): Promise<SearchUsersResponse> => {
      const response = await fetch(
        `/admin/api/users?search=${encodeURIComponent(searchTerm)}&limit=10`
      );
      if (!response.ok) {
        throw new Error('Failed to search users');
      }
      return response.json() as Promise<SearchUsersResponse>;
    },
    enabled: searchTerm.trim().length > 0,
    staleTime: 30000, // Cache results for 30 seconds
  });
}
