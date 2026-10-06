import { describe, expect, it, vi } from 'vitest';
import {
  assertContainerCapacity,
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
