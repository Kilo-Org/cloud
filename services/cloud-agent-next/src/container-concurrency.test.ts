import { describe, expect, it, vi } from 'vitest';
import type { WorkerDb } from '@kilocode/db/client';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  assertContainerCapacity,
  countLiveContainers,
  ContainerConcurrencyLimitError,
  isContainerConcurrencyLimitError,
  ORGANIZATION_CONTAINER_LIMIT,
  PERSONAL_CONTAINER_LIMIT,
  type ContainerCapacityRequest,
} from './container-concurrency.js';
import { logger } from './logger.js';
import type { Env } from './types.js';

const env = {} as Pick<Env, 'HYPERDRIVE'>;

function request(overrides: Partial<ContainerCapacityRequest> = {}): ContainerCapacityRequest {
  return {
    subject: { type: 'user', id: 'user_1' },
    instanceId: 'ses-abcdef',
    checkpoint: 'control-plane-create',
    ...overrides,
  };
}

describe('countLiveContainers', () => {
  it('excludes code reviews by service and instance ID, including the shared Sandbox pool', async () => {
    const where = vi.fn(async (_condition: SQL) => [{ live: 19 }]);
    const db = {
      select: () => ({ from: () => ({ where }) }),
    } as unknown as WorkerDb;

    await expect(countLiveContainers(db, request())).resolves.toBe(19);

    const query = new PgDialect().sqlToQuery(where.mock.calls[0][0]);
    expect(query.sql).toContain('"container_usage_interval"."service" not like $5');
    expect(query.sql).toContain('"container_usage_interval"."instance_id" not like $6');
    expect(query.params).toEqual([
      'user',
      'user_1',
      'open',
      'cloud-agent-next-%',
      '%code-review%',
      'crv-%',
      'ses-abcdef',
    ]);
  });
});

describe('assertContainerCapacity', () => {
  it('admits a personal start below the personal limit', async () => {
    const countLive = vi.fn(async () => PERSONAL_CONTAINER_LIMIT - 1);
    await expect(assertContainerCapacity(env, request(), { countLive })).resolves.toBeUndefined();
    expect(countLive).toHaveBeenCalledWith(request());
  });

  it('rejects a personal start at the personal limit', async () => {
    const countLive = vi.fn(async () => PERSONAL_CONTAINER_LIMIT);
    const rejection = assertContainerCapacity(env, request(), { countLive });
    await expect(rejection).rejects.toBeInstanceOf(ContainerConcurrencyLimitError);
    await expect(rejection).rejects.toMatchObject({
      accountType: 'personal',
      limit: PERSONAL_CONTAINER_LIMIT,
    });
  });

  it('applies the organization limit to organization subjects', async () => {
    const org = request({ subject: { type: 'org', id: 'org_1' } });
    await expect(
      assertContainerCapacity(env, org, { countLive: async () => PERSONAL_CONTAINER_LIMIT })
    ).resolves.toBeUndefined();
    await expect(
      assertContainerCapacity(env, org, { countLive: async () => ORGANIZATION_CONTAINER_LIMIT })
    ).rejects.toMatchObject({ accountType: 'organization', limit: ORGANIZATION_CONTAINER_LIMIT });
  });

  it('never counts code review sandboxes', async () => {
    const countLive = vi.fn(async () => 1_000);
    await expect(
      assertContainerCapacity(env, request({ instanceId: 'crv-abcdef' }), { countLive })
    ).resolves.toBeUndefined();
    expect(countLive).not.toHaveBeenCalled();
  });

  it('admits the start when the count is unavailable', async () => {
    await expect(
      assertContainerCapacity(env, request(), {
        countLive: async () => {
          throw new Error('connection refused');
        },
      })
    ).resolves.toBeUndefined();
  });

  it('logs a tagged error with the account and counts when the limit is reached', async () => {
    const error = vi.fn();
    const withFields = vi.fn(() => ({ error }));
    const withTags = vi
      .spyOn(logger, 'withTags')
      .mockReturnValue({ withFields } as unknown as ReturnType<typeof logger.withTags>);
    try {
      await expect(
        assertContainerCapacity(env, request(), { countLive: async () => PERSONAL_CONTAINER_LIMIT })
      ).rejects.toBeInstanceOf(ContainerConcurrencyLimitError);
      expect(withTags).toHaveBeenCalledWith({
        logTag: 'container_limit_reached',
        sandboxId: 'ses-abcdef',
      });
      expect(withFields).toHaveBeenCalledWith({
        checkpoint: 'control-plane-create',
        subjectType: 'user',
        subjectId: 'user_1',
        live: PERSONAL_CONTAINER_LIMIT,
        limit: PERSONAL_CONTAINER_LIMIT,
      });
      expect(error).toHaveBeenCalledWith('Container concurrency limit reached');
    } finally {
      withTags.mockRestore();
    }
  });

  it('admits the start when no database binding is configured', async () => {
    await expect(assertContainerCapacity(env, request())).resolves.toBeUndefined();
  });
});

describe('isContainerConcurrencyLimitError', () => {
  it('recognizes the denial directly and after RPC flattening', () => {
    const denial = new ContainerConcurrencyLimitError('personal', PERSONAL_CONTAINER_LIMIT);
    expect(isContainerConcurrencyLimitError(denial)).toBe(true);
    expect(isContainerConcurrencyLimitError(new Error(`remote: ${denial.message}`))).toBe(true);
    expect(isContainerConcurrencyLimitError({ code: 'container_limit_reached' })).toBe(true);
    expect(isContainerConcurrencyLimitError(denial.message)).toBe(true);
  });

  it('does not match unrelated failures', () => {
    expect(isContainerConcurrencyLimitError(new Error('meter unavailable'))).toBe(false);
    expect(isContainerConcurrencyLimitError(undefined)).toBe(false);
  });
});
