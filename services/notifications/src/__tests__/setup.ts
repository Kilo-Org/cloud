import { vi } from 'vitest';

// @kilocode/db/client imports pg (CommonJS) which doesn't work in the Workers
// runtime. Mock it globally so modules resolve. Individual test files override
// getWorkerDb with their own return values.
vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));
