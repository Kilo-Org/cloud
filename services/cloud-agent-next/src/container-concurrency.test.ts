import { describe, expect, it, vi } from 'vitest';
import {
  assertContainerCapacity,
  ContainerCapacityUnavailableError,
  ContainerConcurrencyLimitError,
  getContainerCapacityFailureReason,
  LOW_BALANCE_CONTAINER_LIMIT,
  ORGANIZATION_CONTAINER_LIMIT,
  USER_CONTAINER_LIMIT,
  type ContainerCapacityCheck,
  type ContainerCapacityRequest,
} from './container-concurrency.js';
import { logger } from './logger.js';
import type { Env } from './types.js';

const env = {} as Pick<Env, 'HYPERDRIVE'>;

function request(overrides: Partial<ContainerCapacityRequest> = {}): ContainerCapacityRequest {
  return {
    subject: { type: 'user', id: 'user_1' },
    actor: { type: 'user', id: 'user_1' },
    instanceId: 'ses-abcdef',
    checkpoint: 'control-plane-create',
    ...overrides,
  };
}

function userCapacity(live: number, limit = USER_CONTAINER_LIMIT): ContainerCapacityCheck[] {
  return [{ subject: { type: 'user', id: 'user_1' }, live, limit }];
}

describe('assertContainerCapacity', () => {
  it.each([LOW_BALANCE_CONTAINER_LIMIT, USER_CONTAINER_LIMIT])(
    'returns the admitted user limit %i and rejects another start at the limit',
    async limit => {
      const readCapacity = vi.fn(async () => userCapacity(limit - 1, limit));
      await expect(
        assertContainerCapacity(env, request(), { readCapacity })
      ).resolves.toBe(limit);
      expect(readCapacity).toHaveBeenCalledWith(request());

      readCapacity.mockResolvedValue(userCapacity(limit, limit));
      await expect(assertContainerCapacity(env, request(), { readCapacity })).rejects.toMatchObject(
        {
          accountType: 'personal',
          limit,
        }
      );
    }
  );

  it('admits any start when the account concurrency cap is disabled', async () => {
    const readCapacity = vi.fn(async () => userCapacity(USER_CONTAINER_LIMIT));
    await expect(
      assertContainerCapacity(
        { ...env, CLOUD_AGENT_CONTAINER_CONCURRENCY_DISABLED: 'true' },
        request(),
        { readCapacity }
      )
    ).resolves.toBeUndefined();
    expect(readCapacity).not.toHaveBeenCalled();
  });

  it('requires both the user and organization to have capacity', async () => {
    const org = request({ subject: { type: 'org', id: 'org_1' } });
    const organizationCapacity = {
      subject: org.subject,
      live: ORGANIZATION_CONTAINER_LIMIT - 1,
      limit: ORGANIZATION_CONTAINER_LIMIT,
    };
    const readCapacity = vi.fn(async () => [
      ...userCapacity(USER_CONTAINER_LIMIT - 1),
      organizationCapacity,
    ]);
    await expect(assertContainerCapacity(env, org, { readCapacity })).resolves.toBe(
      USER_CONTAINER_LIMIT
    );

    readCapacity.mockResolvedValue([
      ...userCapacity(0),
      { ...organizationCapacity, live: ORGANIZATION_CONTAINER_LIMIT },
    ]);
    await expect(assertContainerCapacity(env, org, { readCapacity })).rejects.toMatchObject({
      accountType: 'organization',
      limit: ORGANIZATION_CONTAINER_LIMIT,
    });

    readCapacity.mockResolvedValue([...userCapacity(USER_CONTAINER_LIMIT), organizationCapacity]);
    await expect(assertContainerCapacity(env, org, { readCapacity })).rejects.toMatchObject({
      accountType: 'personal',
      limit: USER_CONTAINER_LIMIT,
    });
  });

  it.each([
    { instanceId: 'crv-abcdef' },
    { instanceId: `sbx-${'a'.repeat(48)}`, billingOrigin: 'code-review' },
  ])('exempts Code Reviewer containers: %j', async overrides => {
    const readCapacity = vi.fn(async () => userCapacity(1_000));
    await expect(
      assertContainerCapacity(env, request(overrides), { readCapacity })
    ).resolves.toBe(USER_CONTAINER_LIMIT);
    expect(readCapacity).not.toHaveBeenCalled();
  });

  it('enforces ordinary neutral sandbox keys', async () => {
    await expect(
      assertContainerCapacity(
        env,
        request({ instanceId: `sbx-${'a'.repeat(48)}`, billingOrigin: 'cloud-agent-web' }),
        { readCapacity: async () => userCapacity(USER_CONTAINER_LIMIT) }
      )
    ).rejects.toBeInstanceOf(ContainerConcurrencyLimitError);
  });

  it('refuses the start when capacity remains unavailable after a retry', async () => {
    const readCapacity = vi.fn(async () => {
      throw new Error('connection refused');
    });
    await expect(assertContainerCapacity(env, request(), { readCapacity })).rejects.toMatchObject({
      code: 'container_capacity_unavailable',
      message: expect.stringContaining('Try again shortly'),
    });
    expect(readCapacity).toHaveBeenCalledTimes(2);
  });

  it('retries a transient read failure before admitting a start', async () => {
    const readCapacity = vi.fn(async () => userCapacity(0));
    readCapacity.mockRejectedValueOnce(new Error('connection reset'));
    await expect(
      assertContainerCapacity(env, request(), { readCapacity })
    ).resolves.toBeUndefined();
    expect(readCapacity).toHaveBeenCalledTimes(2);
  });

  it('refuses the start after the shared ten-second check deadline', async () => {
    vi.useFakeTimers();
    try {
      const readCapacity = () => new Promise<ContainerCapacityCheck[]>(() => {});
      const rejection = expect(
        assertContainerCapacity(env, request(), { readCapacity })
      ).rejects.toBeInstanceOf(ContainerCapacityUnavailableError);
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs the user whose global limit rejects an organization start', async () => {
    const error = vi.fn();
    const withFields = vi.fn(() => ({ error }));
    const withTags = vi
      .spyOn(logger, 'withTags')
      .mockReturnValue({ withFields } as unknown as ReturnType<typeof logger.withTags>);
    try {
      await expect(
        assertContainerCapacity(env, request({ subject: { type: 'org', id: 'org_1' } }), {
          readCapacity: async () =>
            userCapacity(LOW_BALANCE_CONTAINER_LIMIT, LOW_BALANCE_CONTAINER_LIMIT),
        })
      ).rejects.toBeInstanceOf(ContainerConcurrencyLimitError);
      expect(withTags).toHaveBeenCalledWith({
        logTag: 'container_limit_reached',
        sandboxId: 'ses-abcdef',
      });
      expect(withFields).toHaveBeenCalledWith({
        checkpoint: 'control-plane-create',
        subjectType: 'user',
        subjectId: 'user_1',
        live: LOW_BALANCE_CONTAINER_LIMIT,
        limit: LOW_BALANCE_CONTAINER_LIMIT,
      });
      expect(error).toHaveBeenCalledWith('Container concurrency limit reached');
    } finally {
      withTags.mockRestore();
    }
  });

  it('refuses the start when no database binding is configured', async () => {
    await expect(assertContainerCapacity(env, request())).rejects.toBeInstanceOf(
      ContainerCapacityUnavailableError
    );
  });
});

describe('getContainerCapacityFailureReason', () => {
  it.each([
    [
      new ContainerConcurrencyLimitError('personal', USER_CONTAINER_LIMIT),
      'container_limit_reached',
    ],
    [new ContainerCapacityUnavailableError(), 'billing_unavailable'],
  ] as const)('preserves the reason for %s directly and after RPC flattening', (error, reason) => {
    expect(getContainerCapacityFailureReason(error)).toBe(reason);
    expect(getContainerCapacityFailureReason(new Error(`remote: ${error.message}`))).toBe(reason);
    expect(getContainerCapacityFailureReason({ code: error.code })).toBe(reason);
    expect(getContainerCapacityFailureReason(error.message)).toBe(reason);
  });

  it('does not match unrelated failures', () => {
    expect(getContainerCapacityFailureReason(new Error('meter unavailable'))).toBeUndefined();
    expect(getContainerCapacityFailureReason(undefined)).toBeUndefined();
  });
});
