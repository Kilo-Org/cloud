import { vi } from 'vitest';

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: (table: { _: { name: string } }) => ({
        where: () => {
          if (table._.name === 'user_push_tokens') return [];
          if (table._.name === 'channel_badge_counts') return [{ total: 0 }];
          return [];
        },
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
    delete: () => ({ where: async () => undefined }),
  }),
}));
