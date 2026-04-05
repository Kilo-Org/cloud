export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export type PaginationMetadata = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export const getPaginationHelpers = (pagination: PaginationMetadata) => ({
  hasNext: pagination.page < pagination.totalPages,
  hasPrev: pagination.page > 1,
});
