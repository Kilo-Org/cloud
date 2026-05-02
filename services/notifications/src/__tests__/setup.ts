import { vi } from 'vitest';

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: (table: { _: { name: string } }) => ({
        where: () => ({
          limit: async () => [{ api_token_pepper: null }],
          then: (resolve: (rows: unknown[]) => unknown) => {
            if (table._.name === 'user_push_tokens') return resolve([]);
            return resolve([]);
          },
        }),
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
    delete: () => ({ where: async () => undefined }),
  }),
}));
