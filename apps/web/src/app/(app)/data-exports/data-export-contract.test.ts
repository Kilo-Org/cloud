import {
  canReuseDownloadCodeChallenge,
  findActiveExport,
  findReadyExport,
  getDisplayStatus,
  getRefetchInterval,
  hasActiveExports,
  isActiveUserExportStatus,
  USER_EXPORTS_POLL_INTERVAL_MS,
  type UserExport,
} from './data-export-contract';

describe('canReuseDownloadCodeChallenge', () => {
  const challenge = {
    exportId: 'export-1',
    challengeId: 'challenge-1',
    expiresAt: 60_000,
  };

  it('reuses a challenge for the same export with more than 30 seconds remaining', () => {
    expect(canReuseDownloadCodeChallenge(challenge, 'export-1', 29_999)).toBe(true);
  });

  it('requests a new challenge for another export or with 30 seconds or less remaining', () => {
    expect(canReuseDownloadCodeChallenge(challenge, 'export-2', 29_999)).toBe(false);
    expect(canReuseDownloadCodeChallenge(challenge, 'export-1', 30_000)).toBe(false);
    expect(canReuseDownloadCodeChallenge(challenge, 'export-1', 60_000)).toBe(false);
    expect(canReuseDownloadCodeChallenge(null, 'export-1', 29_999)).toBe(false);
  });
});

function makeUserExport(overrides: Partial<UserExport> = {}): UserExport {
  return {
    id: 'export-1',
    subjectType: 'user',
    organizationId: null,
    organizationName: null,
    status: 'queued',
    requestedAt: '2026-08-01T12:00:00.000Z',
    startedAt: null,
    completedAt: null,
    expiresAt: null,
    sizeBytes: null,
    rowCount: null,
    failureMessage: null,
    ...overrides,
  };
}

describe('getDisplayStatus', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');

  it.each([
    ['queued', 'queued'],
    ['processing', 'processing'],
    ['finalizing', 'processing'],
    ['failed', 'failed'],
    ['expired', 'expired'],
  ] as const)('maps %s to %s', (status, expected) => {
    expect(getDisplayStatus(makeUserExport({ status }), now)).toBe(expected);
  });

  it('keeps a ready export with a future expiry as ready', () => {
    expect(
      getDisplayStatus(
        makeUserExport({ status: 'ready', expiresAt: '2026-08-08T12:00:00.000Z' }),
        now
      )
    ).toBe('ready');
  });

  it('shows a ready export at or past its expiry as expired', () => {
    expect(
      getDisplayStatus(
        makeUserExport({ status: 'ready', expiresAt: '2026-08-05T12:00:00.000Z' }),
        now
      )
    ).toBe('expired');
    expect(
      getDisplayStatus(
        makeUserExport({ status: 'ready', expiresAt: '2026-08-01T12:00:00.000Z' }),
        now
      )
    ).toBe('expired');
  });

  it('keeps a ready export without an expiry timestamp as ready', () => {
    expect(getDisplayStatus(makeUserExport({ status: 'ready' }), now)).toBe('ready');
  });
});

describe('active export detection and polling', () => {
  it.each([
    ['queued', true],
    ['processing', true],
    ['finalizing', true],
    ['ready', false],
    ['failed', false],
    ['expired', false],
  ] as const)('treats %s as active=%s', (status, expected) => {
    expect(isActiveUserExportStatus(status)).toBe(expected);
  });

  it('detects any active export in the visible list', () => {
    expect(hasActiveExports([makeUserExport({ status: 'ready' })])).toBe(false);
    expect(
      hasActiveExports([
        makeUserExport({ status: 'ready' }),
        makeUserExport({ id: 'export-2', status: 'processing' }),
      ])
    ).toBe(true);
    expect(hasActiveExports([])).toBe(false);
    expect(hasActiveExports(undefined)).toBe(false);
  });

  it('polls every 5 seconds only while an export is active', () => {
    expect(
      getRefetchInterval({
        exports: [makeUserExport({ status: 'queued' })],
        nextCursor: null,
      })
    ).toBe(USER_EXPORTS_POLL_INTERVAL_MS);
    expect(USER_EXPORTS_POLL_INTERVAL_MS).toBe(5000);
    expect(
      getRefetchInterval({
        exports: [makeUserExport({ status: 'failed' })],
        nextCursor: null,
      })
    ).toBe(false);
    expect(getRefetchInterval(undefined)).toBe(false);
  });
});

describe('per-subject export lookup', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');

  const personal = (overrides: Partial<UserExport> = {}) =>
    makeUserExport({ id: 'personal', subjectType: 'user', organizationId: null, ...overrides });
  const organization = (organizationId: string, overrides: Partial<UserExport> = {}) =>
    makeUserExport({
      id: `org-${organizationId}`,
      subjectType: 'organization',
      organizationId,
      ...overrides,
    });

  // One subject rule decides both lookups, so an active export of one subject
  // must never disable or hide the other.
  it('matches an active export only for its own subject', () => {
    const records = [
      organization('org-a', { status: 'processing' }),
      personal({ status: 'queued' }),
    ];

    expect(findActiveExport(records, null)?.id).toBe('personal');
    expect(findActiveExport(records, 'org-a')?.id).toBe('org-org-a');
    expect(findActiveExport(records, 'org-b')).toBeUndefined();
  });

  it('matches a ready export only for its own subject', () => {
    const records = [
      organization('org-a', { status: 'ready', expiresAt: '2026-09-01T00:00:00.000Z' }),
      personal({ status: 'ready', expiresAt: '2026-09-01T00:00:00.000Z' }),
    ];

    expect(findReadyExport(records, null, now)?.id).toBe('personal');
    expect(findReadyExport(records, 'org-a', now)?.id).toBe('org-org-a');
    expect(findReadyExport(records, 'org-b', now)).toBeUndefined();
  });

  it('does not treat a personal export as an organization export', () => {
    const records = [personal({ status: 'processing' })];

    expect(findActiveExport(records, 'org-a')).toBeUndefined();
    expect(findReadyExport(records, 'org-a', now)).toBeUndefined();
  });

  it('applies its own status test for each subject', () => {
    const records = [
      organization('org-a', { status: 'ready', expiresAt: '2026-09-01T00:00:00.000Z' }),
      personal({ status: 'processing' }),
    ];

    // The organization export is ready but not active; the personal one is
    // active but not ready. Neither finder may borrow the other's status.
    expect(findActiveExport(records, 'org-a')).toBeUndefined();
    expect(findReadyExport(records, null, now)).toBeUndefined();
    expect(findActiveExport(records, null)?.id).toBe('personal');
    expect(findReadyExport(records, 'org-a', now)?.id).toBe('org-org-a');
  });

  it('returns undefined for an empty or missing list', () => {
    expect(findActiveExport([], null)).toBeUndefined();
    expect(findReadyExport([], null, now)).toBeUndefined();
    expect(findActiveExport(null, 'org-a')).toBeUndefined();
    expect(findReadyExport(undefined, null, now)).toBeUndefined();
  });
});
