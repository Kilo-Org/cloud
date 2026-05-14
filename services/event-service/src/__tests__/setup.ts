import { vi } from 'vitest';

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(() => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ api_token_pepper: null }],
        }),
      }),
    }),
  })),
}));
