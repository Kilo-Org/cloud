'use client';

import { useModelStatsList } from '@/app/admin/api/model-stats/hooks';

export function useAddModelSearch(search: string) {
  return useModelStatsList({
    page: 1,
    limit: 100,
    sortBy: 'name',
    sortOrder: 'asc',
    search,
    isActive: '',
  });
}
