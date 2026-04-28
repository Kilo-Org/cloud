import { vi } from 'vitest';

// sandbox-ownership, user-lookup, and sandbox-lookup import @kilocode/db → pg
// which doesn't work in the Workers runtime. Mock them globally so modules
// resolve. Individual test files override with their own mocks to test specific
// logic.
vi.mock('../services/sandbox-ownership', () => ({
  userOwnsSandbox: vi.fn(async () => true),
  lookupSandboxOwnerUserId: vi.fn(async () => null),
}));

vi.mock('../services/user-lookup', () => ({
  resolveUserDisplayInfo: vi.fn(async () => new Map()),
  validateUserIds: vi.fn(async (_conn: string, userIds: string[]) => ({
    valid: userIds,
    invalid: [],
  })),
}));

vi.mock('../services/sandbox-lookup', () => ({
  fetchSandboxLabel: vi.fn(async (_env: unknown, sandboxId: string) => `Agent ${sandboxId}`),
}));
