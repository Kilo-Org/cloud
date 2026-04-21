import { vi } from 'vitest';

// sandbox-ownership imports @kilocode/db → pg which doesn't work in the Workers runtime.
// Mock it globally so modules resolve. Default to true (allow) — individual test files
// override with their own mock to test ownership logic.
vi.mock('../services/sandbox-ownership', () => ({
  userOwnsSandbox: vi.fn(async () => true),
}));
