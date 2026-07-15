import { waitForOwnedCliSession, READINESS_INTERVAL_MS, READINESS_MAX_ATTEMPTS } from './readiness';

const SESSION_ID = 'ses_a1b2c3d4e5f67890123456789a';
const USER_ID = 'usr_alice';
const ORG_ID = 'org_123e4567-e89b-12d3-a456-426614174000';

function makeQuery(rows: Array<{ organizationId: string | null } | null>) {
  const calls: Array<{ sessionId: string; kiloUserId: string }> = [];
  let next = 0;
  return {
    calls,
    query: jest.fn(async (sessionId: string, kiloUserId: string) => {
      calls.push({ sessionId, kiloUserId });
      if (next >= rows.length) return null;
      const row = rows[next++] ?? null;
      return row;
    }),
  };
}

function makePassThroughAccess() {
  return jest.fn(async () => undefined);
}

describe('READINESS_INTERVAL_MS and READINESS_MAX_ATTEMPTS', () => {
  it('uses a 250ms interval and a 40-attempt bound (10s total) in production', () => {
    expect(READINESS_INTERVAL_MS).toBe(250);
    expect(READINESS_MAX_ATTEMPTS).toBe(40);
  });
});

describe('waitForOwnedCliSession', () => {
  it('scopes the DB query to BOTH session_id AND kilo_user_id (no other-user leak)', async () => {
    const { query, calls } = makeQuery([null]);
    const result = await waitForOwnedCliSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      deps: {
        query,
        ensureOrganizationAccess: makePassThroughAccess(),
        sleep: jest.fn(async () => undefined),
        intervalMs: 10,
        maxAttempts: 3,
      },
    });

    expect(result).toBeNull();
    expect(calls).toEqual([
      { sessionId: SESSION_ID, kiloUserId: USER_ID },
      { sessionId: SESSION_ID, kiloUserId: USER_ID },
      { sessionId: SESSION_ID, kiloUserId: USER_ID },
    ]);
    // No call ever uses a different user id — non-leaking shape
    expect(calls.every(c => c.kiloUserId === USER_ID)).toBe(true);
  });

  it('returns the organizationId and makes no extra query when found on the first attempt', async () => {
    const { query, calls } = makeQuery([{ organizationId: ORG_ID }]);
    const ensureOrganizationAccess = makePassThroughAccess();
    const sleep = jest.fn(async () => undefined);

    const result = await waitForOwnedCliSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      deps: { query, ensureOrganizationAccess, sleep },
    });

    expect(result).toEqual({ organizationId: ORG_ID });
    expect(calls).toHaveLength(1);
    expect(sleep).toHaveBeenCalledTimes(0);
  });

  it('polls at the injected interval and returns on attempt N (sleep count = N-1, query count = N)', async () => {
    const { query, calls } = makeQuery([
      null,
      null,
      null,
      { organizationId: null },
    ]);
    const ensureOrganizationAccess = makePassThroughAccess();
    const sleep = jest.fn(async () => undefined);

    const result = await waitForOwnedCliSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      deps: { query, ensureOrganizationAccess, sleep, intervalMs: 25, maxAttempts: 10 },
    });

    expect(result).toEqual({ organizationId: null });
    expect(calls).toHaveLength(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 25);
    expect(sleep).toHaveBeenNthCalledWith(2, 25);
    expect(sleep).toHaveBeenNthCalledWith(3, 25);
  });

  it('uses the production defaults (250ms interval, 40 attempts) when no override is provided', async () => {
    const rows: Array<{ organizationId: string | null } | null> = Array.from({ length: 39 }, () => null);
    rows.push({ organizationId: null });
    const { query, calls } = makeQuery(rows);
    const ensureOrganizationAccess = makePassThroughAccess();
    const sleep = jest.fn(async () => undefined);

    const result = await waitForOwnedCliSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      deps: { query, ensureOrganizationAccess, sleep },
    });

    expect(result).toEqual({ organizationId: null });
    expect(calls).toHaveLength(40);
    expect(sleep).toHaveBeenCalledTimes(39);
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
  });

  it('returns null and exhausts the attempt bound when the row never appears', async () => {
    const { query, calls } = makeQuery(Array.from({ length: 5 }, () => null));
    const ensureOrganizationAccess = makePassThroughAccess();
    const sleep = jest.fn(async () => undefined);

    const result = await waitForOwnedCliSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      deps: { query, ensureOrganizationAccess, sleep, intervalMs: 10, maxAttempts: 5 },
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(5);
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it('validates current user membership when the row has a non-null organizationId', async () => {
    const { query } = makeQuery([{ organizationId: ORG_ID }]);
    const ensureOrganizationAccess = jest.fn(async (orgId: string) => {
      expect(orgId).toBe(ORG_ID);
    });
    const sleep = jest.fn(async () => undefined);

    const result = await waitForOwnedCliSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      deps: { query, ensureOrganizationAccess, sleep },
    });

    expect(result).toEqual({ organizationId: ORG_ID });
    expect(ensureOrganizationAccess).toHaveBeenCalledTimes(1);
    expect(ensureOrganizationAccess).toHaveBeenCalledWith(ORG_ID);
  });

  it('does NOT validate membership when the row has a null organizationId (personal session)', async () => {
    const { query } = makeQuery([{ organizationId: null }]);
    const ensureOrganizationAccess = makePassThroughAccess();
    const sleep = jest.fn(async () => undefined);

    const result = await waitForOwnedCliSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      deps: { query, ensureOrganizationAccess, sleep },
    });

    expect(result).toEqual({ organizationId: null });
    expect(ensureOrganizationAccess).not.toHaveBeenCalled();
  });

  it('propagates an ensureOrganizationAccess failure (the caller decides the recovery)', async () => {
    const { query } = makeQuery([{ organizationId: ORG_ID }]);
    const accessError = new Error('not a member');
    const ensureOrganizationAccess = jest.fn(async () => {
      throw accessError;
    });
    const sleep = jest.fn(async () => undefined);

    await expect(
      waitForOwnedCliSession({
        sessionId: SESSION_ID,
        userId: USER_ID,
        deps: { query, ensureOrganizationAccess, sleep },
      })
    ).rejects.toBe(accessError);
    expect(ensureOrganizationAccess).toHaveBeenCalledTimes(1);
  });

  it('propagates a query failure rather than retrying', async () => {
    const query = jest.fn(async () => {
      throw new Error('db is down');
    });
    const ensureOrganizationAccess = makePassThroughAccess();
    const sleep = jest.fn(async () => undefined);

    await expect(
      waitForOwnedCliSession({
        sessionId: SESSION_ID,
        userId: USER_ID,
        deps: { query, ensureOrganizationAccess, sleep, intervalMs: 10, maxAttempts: 5 },
      })
    ).rejects.toThrow('db is down');
    expect(query).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
