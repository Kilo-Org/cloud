import {
  canReuseDownloadCodeChallenge,
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
    expiresAt: 10_000,
  };

  it('reuses a live challenge for the same export', () => {
    expect(canReuseDownloadCodeChallenge(challenge, 'export-1', 9_999)).toBe(true);
  });

  it('requests a new challenge for another export or after expiry', () => {
    expect(canReuseDownloadCodeChallenge(challenge, 'export-2', 9_999)).toBe(false);
    expect(canReuseDownloadCodeChallenge(challenge, 'export-1', 10_000)).toBe(false);
    expect(canReuseDownloadCodeChallenge(null, 'export-1', 9_999)).toBe(false);
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
