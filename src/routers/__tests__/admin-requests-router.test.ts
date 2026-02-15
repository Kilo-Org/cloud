import { describe, test, expect, beforeAll } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import { api_request_log } from '@/db/schema';
import type { User } from '@/db/schema';

let regularUser: User;
let adminUser: User;

beforeAll(async () => {
  regularUser = await insertTestUser({
    google_user_email: `regular-requests-${Date.now()}@example.com`,
    google_user_name: 'Regular User',
    is_admin: false,
  });

  adminUser = await insertTestUser({
    google_user_email: `admin-requests-${Date.now()}@admin.example.com`,
    google_user_name: 'Admin User',
    is_admin: true,
  });

  // Insert some test records
  await db.insert(api_request_log).values([
    {
      kilo_user_id: adminUser.id,
      organization_id: null,
      provider: 'openai',
      model: 'gpt-4',
      status_code: 200,
      request: { prompt: 'hello' },
      response: '{"text":"world"}',
    },
    {
      kilo_user_id: adminUser.id,
      organization_id: 'org-123',
      provider: 'anthropic',
      model: 'claude-3',
      status_code: 429,
      request: { prompt: 'test' },
      response: '{"error":"rate limited"}',
    },
    {
      kilo_user_id: regularUser.id,
      organization_id: null,
      provider: 'openai',
      model: 'gpt-3.5-turbo',
      status_code: 500,
      request: null,
      response: null,
    },
  ]);
});

describe('admin.requests.list', () => {
  test('throws FORBIDDEN for non-admin users', async () => {
    const caller = await createCallerForUser(regularUser.id);

    await expect(caller.admin.requests.list({})).rejects.toThrow('Admin access required');
  });

  test('returns expected shape with items and pagination', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.requests.list({});

    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('pagination');
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.pagination).toHaveProperty('page');
    expect(result.pagination).toHaveProperty('limit');
    expect(result.pagination).toHaveProperty('total');
    expect(result.pagination).toHaveProperty('totalPages');
    expect(result.items.length).toBeGreaterThanOrEqual(3);
  });

  test('items have string id field', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.requests.list({ limit: 1 });

    expect(result.items.length).toBe(1);
    expect(typeof result.items[0].id).toBe('string');
  });

  test('filters by requestId (exact match)', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const allResult = await caller.admin.requests.list({ limit: 1 });
    const targetId = allResult.items[0].id;

    const filtered = await caller.admin.requests.list({ requestId: targetId });
    expect(filtered.items.length).toBe(1);
    expect(filtered.items[0].id).toBe(targetId);
  });

  test('filters by date range', async () => {
    const caller = await createCallerForUser(adminUser.id);

    // Use a future date to get all records
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const pastDate = new Date(Date.now() - 86400000).toISOString();

    const result = await caller.admin.requests.list({
      startTime: pastDate,
      endTime: futureDate,
    });
    expect(result.items.length).toBeGreaterThanOrEqual(3);

    // Use a very old date range to get no records
    const veryOld = '2000-01-01T00:00:00.000Z';
    const veryOldEnd = '2000-01-02T00:00:00.000Z';
    const emptyResult = await caller.admin.requests.list({
      startTime: veryOld,
      endTime: veryOldEnd,
    });
    expect(emptyResult.items.length).toBe(0);
  });

  test('filters by query search', async () => {
    const caller = await createCallerForUser(adminUser.id);

    const result = await caller.admin.requests.list({ query: 'anthropic' });
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items.every(item => item.provider === 'anthropic')).toBe(true);
  });

  test('respects pagination', async () => {
    const caller = await createCallerForUser(adminUser.id);

    const page1 = await caller.admin.requests.list({ page: 1, limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.pagination.page).toBe(1);
    expect(page1.pagination.limit).toBe(2);

    const page2 = await caller.admin.requests.list({ page: 2, limit: 2 });
    expect(page2.items.length).toBeGreaterThanOrEqual(1);
    expect(page2.pagination.page).toBe(2);
  });
});

describe('admin.requests.getById', () => {
  test('throws FORBIDDEN for non-admin users', async () => {
    const caller = await createCallerForUser(regularUser.id);

    await expect(caller.admin.requests.getById({ id: '1' })).rejects.toThrow(
      'Admin access required'
    );
  });

  test('returns a record by id', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const listResult = await caller.admin.requests.list({ limit: 1 });
    const targetId = listResult.items[0].id;

    const item = await caller.admin.requests.getById({ id: targetId });
    expect(item).not.toBeNull();
    expect(item?.id).toBe(targetId);
    expect(item).toHaveProperty('created_at');
    expect(item).toHaveProperty('provider');
  });

  test('returns null for non-existent id', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const item = await caller.admin.requests.getById({ id: '999999999' });
    expect(item).toBeNull();
  });
});
