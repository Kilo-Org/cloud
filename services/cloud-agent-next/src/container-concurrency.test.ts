import { getWorkerDb } from '@kilocode/db/client';
import { describe, expect, it, vi } from 'vitest';
import {
  assertContainerCapacity,
  ContainerAccountBlockedError,
  ContainerCapacityUnavailableError,
  ContainerConcurrencyLimitError,
  FUNDED_CONTAINER_MINIMUM_MICRODOLLARS,
  getContainerCapacityFailureReason,
  LOW_BALANCE_CONTAINER_LIMIT,
  ORGANIZATION_CONTAINER_LIMIT,
  readContainerCapacity,
  USER_CONTAINER_LIMIT,
  type ContainerCapacityCheck,
  type ContainerCapacityCheckpoint,
  type ContainerCapacityRequest,
  type ContainerCapacityState,
  type ContainerConcurrencySubject,
} from './container-concurrency.js';
import { messageFailureText } from './control-plane/session/failure-messages.js';
import { logger } from './logger.js';
import type { Env } from './types.js';

const env = {} as Pick<Env, 'HYPERDRIVE'>;
const CHECKPOINTS: ContainerCapacityCheckpoint[] = ['control-plane-create', 'sandbox-start'];

function request(overrides: Partial<ContainerCapacityRequest> = {}): ContainerCapacityRequest {
  return {
    subject: { type: 'user', id: 'user_1' },
    actor: { type: 'user', id: 'user_1' },
    instanceId: 'ses-abcdef',
    checkpoint: 'control-plane-create',
    ...overrides,
  };
}

function state(
  checks: ContainerCapacityCheck[],
  blocked: ContainerConcurrencySubject | null = null
): ContainerCapacityState {
  return { blocked, checks };
}

function userCapacity(live: number, limit = USER_CONTAINER_LIMIT): ContainerCapacityState {
  return state([{ subject: { type: 'user', id: 'user_1' }, live, limit }]);
}

type AccountRow = {
  balance: number | null;
  actorBlocked: boolean | null;
  subjectBlocked: boolean | null;
};

/**
 * A real Drizzle client whose pg pool answers queries in memory. The builder,
 * SQL generation and row mapping run unchanged; only the wire is replaced.
 */
function fakeDatabase(account: Partial<AccountRow> = {}, live = 0) {
  const db = getWorkerDb('postgres://capacity-test@127.0.0.1:1/unused');
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const row: AccountRow = {
    balance: FUNDED_CONTAINER_MINIMUM_MICRODOLLARS,
    actorBlocked: null,
    subjectBlocked: null,
    ...account,
  };
  const query = vi.fn(async (config: { text: string }, values: unknown[]) => {
    queries.push({ text: config.text, values });
    if (config.text.includes('"container_usage_interval"')) return { rows: [[live]] };
    if (config.text.includes('as admission')) {
      return {
        rows: [
          [row.balance === null ? null : String(row.balance), row.actorBlocked, row.subjectBlocked],
        ],
      };
    }
    throw new Error(`unexpected query: ${config.text}`);
  });
  (db.$client as unknown as { query: typeof query }).query = query;
  const accountQueries = () => queries.filter(entry => entry.text.includes('as admission'));
  const countQueries = () =>
    queries.filter(entry => entry.text.includes('"container_usage_interval"'));
  return {
    queries,
    accountQueries,
    countQueries,
    assert: (input: ContainerCapacityRequest, flags: Partial<Env> = {}) =>
      assertContainerCapacity({ ...env, ...flags }, input, {
        readCapacity: current => readContainerCapacity(db, current),
      }),
  };
}

describe('assertContainerCapacity', () => {
  it.each([LOW_BALANCE_CONTAINER_LIMIT, USER_CONTAINER_LIMIT])(
    'admits a user below %i containers and rejects another start at the limit',
    async limit => {
      const readCapacity = vi.fn(async () => userCapacity(limit - 1, limit));
      await expect(
        assertContainerCapacity(env, request(), { readCapacity })
      ).resolves.toBeUndefined();
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
    const user = (live: number) => userCapacity(live).checks;
    const readCapacity = vi.fn(async () =>
      state([...user(USER_CONTAINER_LIMIT - 1), organizationCapacity])
    );
    await expect(assertContainerCapacity(env, org, { readCapacity })).resolves.toBeUndefined();

    readCapacity.mockResolvedValue(
      state([...user(0), { ...organizationCapacity, live: ORGANIZATION_CONTAINER_LIMIT }])
    );
    await expect(assertContainerCapacity(env, org, { readCapacity })).rejects.toMatchObject({
      accountType: 'organization',
      limit: ORGANIZATION_CONTAINER_LIMIT,
    });

    readCapacity.mockResolvedValue(state([...user(USER_CONTAINER_LIMIT), organizationCapacity]));
    await expect(assertContainerCapacity(env, org, { readCapacity })).rejects.toMatchObject({
      accountType: 'personal',
      limit: USER_CONTAINER_LIMIT,
    });
  });

  it.each([
    { instanceId: 'crv-abcdef' },
    { instanceId: `sbx-${'a'.repeat(48)}`, billingOrigin: 'code-review' },
  ])('exempts Code Reviewer containers from the counts: %j', async overrides => {
    const database = fakeDatabase({}, 1_000);
    await expect(database.assert(request(overrides))).resolves.toBeUndefined();
    expect(database.countQueries()).toHaveLength(0);
    expect(database.accountQueries()).toHaveLength(1);
  });

  it('does not read the database for an exempt bot start billed to an organization', async () => {
    const readCapacity = vi.fn(async () => userCapacity(1_000));
    await expect(
      assertContainerCapacity(
        env,
        request({
          subject: { type: 'org', id: 'org_1' },
          actor: { type: 'bot', id: 'code-review' },
          instanceId: 'crv-abcdef',
        }),
        { readCapacity }
      )
    ).resolves.toBeUndefined();
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
    const readCapacity = vi.fn(async (): Promise<ContainerCapacityState> => {
      throw new Error('connection refused');
    });
    await expect(assertContainerCapacity(env, request(), { readCapacity })).rejects.toMatchObject({
      code: 'container_capacity_unavailable',
      message: expect.stringContaining('Try again shortly'),
    });
    expect(readCapacity).toHaveBeenCalledTimes(2);
  });

  it('refuses an exempt human start when the block state cannot be read', async () => {
    const readCapacity = vi.fn(async (): Promise<ContainerCapacityState> => {
      throw new Error('connection refused');
    });
    await expect(
      assertContainerCapacity(env, request({ instanceId: 'crv-abcdef' }), { readCapacity })
    ).rejects.toBeInstanceOf(ContainerCapacityUnavailableError);
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
      const readCapacity = () => new Promise<ContainerCapacityState>(() => {});
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

describe('account block admission', () => {
  it.each(CHECKPOINTS)('rejects a blocked user at %s', async checkpoint => {
    const database = fakeDatabase({ actorBlocked: true });
    const rejection = database.assert(request({ checkpoint }));
    await expect(rejection).rejects.toBeInstanceOf(ContainerAccountBlockedError);
    await expect(rejection).rejects.toMatchObject({
      code: 'account_blocked',
      message: 'account_blocked: This account is blocked.',
    });
  });

  it('reads balance and block state in one query', async () => {
    const database = fakeDatabase();
    await expect(database.assert(request())).resolves.toBeUndefined();
    const [account, ...others] = database.accountQueries();
    expect(others).toHaveLength(0);
    expect(database.queries).toHaveLength(2);
    expect(account.text).toBe(
      'select (select "total_microdollars_acquired" - "microdollars_used" from "kilocode_users" where "id" = $1), ' +
        '(select "blocked_at" is not null or "blocked_reason" is not null from "kilocode_users" where "id" = $2), null from (select 1) as admission'
    );
    expect(account.values).toEqual(['user_1', 'user_1']);
  });

  it.each(CHECKPOINTS)(
    'leaves an unblocked user under the existing limits at %s',
    async checkpoint => {
      const funded = fakeDatabase({}, USER_CONTAINER_LIMIT - 1);
      await expect(funded.assert(request({ checkpoint }))).resolves.toBeUndefined();

      const fundedAtLimit = fakeDatabase({}, USER_CONTAINER_LIMIT);
      await expect(fundedAtLimit.assert(request({ checkpoint }))).rejects.toMatchObject({
        code: 'container_limit_reached',
        limit: USER_CONTAINER_LIMIT,
      });

      const lowBalance = fakeDatabase({ balance: 0 }, LOW_BALANCE_CONTAINER_LIMIT);
      await expect(lowBalance.assert(request({ checkpoint }))).rejects.toMatchObject({
        code: 'container_limit_reached',
        limit: LOW_BALANCE_CONTAINER_LIMIT,
      });
    }
  );

  it('treats a missing balance row as zero balance and not blocked', async () => {
    const database = fakeDatabase({ balance: null }, LOW_BALANCE_CONTAINER_LIMIT - 1);
    await expect(database.assert(request())).resolves.toBeUndefined();
  });

  it.each(CHECKPOINTS)(
    'checks the acting user when the subject is an organization at %s',
    async checkpoint => {
      const input = request({ subject: { type: 'org', id: 'org_1' }, checkpoint });
      const database = fakeDatabase({ actorBlocked: true });
      await expect(database.assert(input)).rejects.toBeInstanceOf(ContainerAccountBlockedError);
      const [account] = database.accountQueries();
      expect(account.text).toBe(
        'select (select "total_microdollars_acquired" - "microdollars_used" from "organizations" where "id" = $1), ' +
          '(select "blocked_at" is not null or "blocked_reason" is not null from "kilocode_users" where "id" = $2), null from (select 1) as admission'
      );
      expect(account.values).toEqual(['org_1', 'user_1']);

      await expect(fakeDatabase().assert(input)).resolves.toBeUndefined();
    }
  );

  it('rejects a bot start billed to a blocked user', async () => {
    const database = fakeDatabase({ subjectBlocked: true });
    await expect(
      database.assert(request({ actor: { type: 'bot', id: 'automation' } }))
    ).rejects.toBeInstanceOf(ContainerAccountBlockedError);
    expect(database.accountQueries()[0].values).toEqual(['user_1', 'user_1']);
  });

  it.each([
    { instanceId: 'crv-abcdef' },
    { instanceId: `sbx-${'a'.repeat(48)}`, billingOrigin: 'code-review' },
  ])('does not let a Code Reviewer exemption admit a blocked human: %j', async overrides => {
    const database = fakeDatabase({ actorBlocked: true });
    await expect(database.assert(request(overrides))).rejects.toBeInstanceOf(
      ContainerAccountBlockedError
    );
    expect(database.countQueries()).toHaveLength(0);
  });

  it('reports a block before a reached limit', async () => {
    const database = fakeDatabase({ actorBlocked: true }, USER_CONTAINER_LIMIT);
    await expect(database.assert(request())).rejects.toBeInstanceOf(ContainerAccountBlockedError);
  });

  it('keeps the test-Worker bypass for blocked accounts', async () => {
    const database = fakeDatabase({ actorBlocked: true });
    await expect(
      database.assert(request(), { CLOUD_AGENT_CONTAINER_CONCURRENCY_DISABLED: 'true' })
    ).resolves.toBeUndefined();
    expect(database.queries).toHaveLength(0);
  });
});

describe('getContainerCapacityFailureReason', () => {
  it.each([
    [
      new ContainerConcurrencyLimitError('personal', USER_CONTAINER_LIMIT),
      'container_limit_reached',
    ],
    [new ContainerCapacityUnavailableError(), 'billing_unavailable'],
    [new ContainerAccountBlockedError(), 'account_blocked'],
  ] as const)('preserves the reason for %s directly and after RPC flattening', (error, reason) => {
    expect(getContainerCapacityFailureReason(error)).toBe(reason);
    expect(getContainerCapacityFailureReason(new Error(`remote: ${error.message}`))).toBe(reason);
    expect(getContainerCapacityFailureReason({ code: error.code })).toBe(reason);
    expect(getContainerCapacityFailureReason(error.message)).toBe(reason);
  });

  it('gives a blocked account a specific user-facing message', () => {
    const reason = getContainerCapacityFailureReason(
      new Error(`remote: ${new ContainerAccountBlockedError().message}`)
    );
    expect(reason).toBe('account_blocked');
    expect(messageFailureText(reason ?? '')).toBe('This account is blocked.');
  });

  it('does not match unrelated failures', () => {
    expect(getContainerCapacityFailureReason(new Error('meter unavailable'))).toBeUndefined();
    expect(getContainerCapacityFailureReason(undefined)).toBeUndefined();
  });
});
