export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export const DEFAULT_PAGE_SIZE: PageSize = 25;
export const MAX_PAGE_NUMBER = 10_000;

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
