const mockRead = jest.fn(),
  mockInsert = jest.fn(),
  mockUpdate = jest.fn(),
  mockDownload = jest.fn();
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mockRead }) }) }),
    insert: () => ({
      values: (data: unknown) => ({
        onConflictDoNothing: () => ({ returning: () => mockInsert(data) }),
      }),
    }),
    update: () => ({
      set: (data: unknown) => ({
        where: () => ({
          then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(mockUpdate(data)).then(resolve, reject),
          returning: () => Promise.resolve(mockUpdate(data)),
        }),
      }),
    }),
  },
}));
jest.mock('./watch-pr-github-client', () => ({
  assertWatchPrGitHubCall: jest.fn(),
  watchPrGitHubClient: async () => ({ actions: { downloadJobLogsForWorkflowRun: mockDownload } }),
}));
jest.mock('./watch-pr-replies', () => ({ publishWatchPrReplies: jest.fn() }));
jest.mock('./watch-pr-assessment', () => ({
  watchPrRepository: () => ({ owner: 'test', repo: 'repo' }),
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  toGitHubRateLimitError: (error: { status?: number }) =>
    error?.status === 429 ? { resetAt: new Date('2026-11-12T13:00:00Z') } : null,
}));
jest.mock('@/lib/integrations/platforms/github/pr-refresh-budget', () => ({
  deferPrRefresh: jest.fn(),
  recordPrMaintenanceApiCall: jest.fn(),
  PrMaintenanceDeferredError: class extends Error {
    constructor(
      public reason: string,
      public retryAt: Date
    ) {
      super(reason);
    }
  },
}));
import type { CloudAgentPrWatch } from '@kilocode/db/schema';
import type { WatchPrProblem } from '@kilocode/db/cloud-agent-pr-maintenance';
import { readWatchPrFailingLogs, watchPrFailingJobId } from './watch-pr-github';
const head = 'a'.repeat(40),
  old = 'b'.repeat(40);
const watch = {
  id: 'watch-test',
  generation: 1,
  pending_revision: 1,
  head_sha: head,
  repo_url: 'https://github.com/test/repo',
} as CloudAgentPrWatch;
function problem(job: number, headSha = head): Extract<WatchPrProblem, { kind: 'failed_check' }> {
  return {
    kind: 'failed_check',
    problemKey: `check:${job}`,
    contentFingerprint: `fingerprint-${job}`,
    headSha,
    checkId: String(job),
    name: 'tests',
    detailsUrl: `https://github.com/test/repo/actions/runs/20/job/${job}`,
    log: null,
    logUnavailableReason: null,
  };
}
beforeEach(() => {
  jest.resetAllMocks();
  mockRead.mockResolvedValue([]);
  mockInsert.mockResolvedValue([{ id: 'log-intent' }]);
  mockUpdate.mockResolvedValue(undefined);
  mockDownload.mockResolvedValue({ headers: {}, data: 'x'.repeat(20_000) });
});
afterEach(() => jest.useRealTimers());
describe('bounded current-head job diagnostics', () => {
  it('retries a durably rate-limited read only after cooldown, then caches the log', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-12T12:00:00Z'));
    let receipt: { id: string; data: unknown } | null = null;
    mockRead.mockImplementation(async () => (receipt ? [receipt] : []));
    mockInsert.mockImplementation(async () => {
      receipt = { id: 'log-intent', data: {} };
      return [{ id: 'log-intent' }];
    });
    mockUpdate.mockImplementation(async (values: { data: unknown }) => {
      receipt = { id: 'log-intent', data: values.data };
      return [{ id: 'log-intent' }];
    });
    mockDownload
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValue({ headers: {}, data: 'retried log' });
    await expect(readWatchPrFailingLogs({ watch, problems: [problem(1)] })).rejects.toMatchObject({
      reason: 'rate_limited',
      retryAt: new Date('2026-11-12T13:00:00Z'),
    });
    expect(receipt).toMatchObject({
      data: { state: 'rate_limited', retryAt: '2026-11-12T13:00:00.000Z' },
    });
    await expect(readWatchPrFailingLogs({ watch, problems: [problem(1)] })).rejects.toMatchObject({
      reason: 'rate_limited',
    });
    expect(mockDownload).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date('2026-11-12T13:00:00Z'));
    expect(await readWatchPrFailingLogs({ watch, problems: [problem(1)] })).toMatchObject([
      { log: 'retried log', logUnavailableReason: null },
    ]);
    expect(await readWatchPrFailingLogs({ watch, problems: [problem(1)] })).toMatchObject([
      { log: 'retried log' },
    ]);
    expect(mockDownload).toHaveBeenCalledTimes(2);
  });
  it('reads at most three distinct failing jobs and never reads superseded jobs', async () => {
    const output = await readWatchPrFailingLogs({
      watch,
      problems: [problem(1), problem(2), problem(3), problem(4), problem(5, old)],
    });
    expect(mockDownload).toHaveBeenCalledTimes(3);
    expect(output.filter(item => item.kind === 'failed_check' && item.log !== null)).toHaveLength(
      3
    );
    expect(output[0]).toMatchObject({ log: 'x'.repeat(12000) });
    expect(output[3]).toMatchObject({
      log: null,
      logUnavailableReason: expect.stringContaining('three-job'),
    });
    expect(mockDownload).not.toHaveBeenCalledWith(expect.objectContaining({ job_id: 5 }));
  });
  it('uses the durable read receipt instead of reading a job again after transport recovery', async () => {
    mockRead.mockResolvedValue([{ data: { log: 'cached log', reason: null } }]);
    expect(
      await readWatchPrFailingLogs({ watch, problems: [problem(1), problem(1)] })
    ).toMatchObject([{ log: 'cached log' }, { log: 'cached log' }]);
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(mockDownload).not.toHaveBeenCalled();
  });
  it('counts retained logs toward the same three-job brief limit', async () => {
    const existing = [1, 2, 3].map(job => ({ ...problem(job), log: 'x'.repeat(20000) }));
    const output = await readWatchPrFailingLogs({ watch, problems: [...existing, problem(4)] });
    expect(mockDownload).not.toHaveBeenCalled();
    expect(output.filter(item => item.kind === 'failed_check' && item.log !== null)).toHaveLength(
      3
    );
    expect(output[0]).toMatchObject({ log: 'x'.repeat(12000) });
  });
  it('does not retry an uncertain prior read', async () => {
    mockRead.mockResolvedValue([{ data: {} }]);
    expect(await readWatchPrFailingLogs({ watch, problems: [problem(1)] })).toMatchObject([
      { log: null, logUnavailableReason: expect.stringContaining('unknown') },
    ]);
    expect(mockDownload).not.toHaveBeenCalled();
  });
  it('does not duplicate an expired rate-limit read claimed by another dispatcher', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-12T13:00:00Z'));
    mockRead.mockResolvedValue([
      { id: 'log-intent', data: { state: 'rate_limited', retryAt: '2026-11-12T13:00:00.000Z' } },
    ]);
    mockUpdate.mockResolvedValue([]);
    await expect(readWatchPrFailingLogs({ watch, problems: [problem(1)] })).rejects.toMatchObject({
      reason: 'unavailable',
      retryAt: new Date('2026-11-12T13:00:15Z'),
    });
    expect(mockDownload).not.toHaveBeenCalled();
  });
  it('uses only validated same-repository GitHub Actions job URLs', () => {
    expect(watchPrFailingJobId(watch, problem(33))).toBe(33);
    for (const detailsUrl of [
      'https://github.com/other/repo/actions/runs/20/job/33',
      'https://evil.test/test/repo/actions/runs/20/job/33',
      'https://github.com/test/repo/actions/runs/20',
    ]) {
      expect(watchPrFailingJobId(watch, { ...problem(33), detailsUrl })).toBeNull();
    }
  });
  it('surfaces missing logs instead of treating missing diagnostics as success', async () => {
    mockDownload.mockRejectedValue(new Error('expired log'));
    expect(await readWatchPrFailingLogs({ watch, problems: [problem(1)] })).toMatchObject([
      { log: null, logUnavailableReason: expect.stringContaining('permissions') },
    ]);
  });
  it('keeps a trimmed Unicode log valid for PostgreSQL JSON storage', async () => {
    mockDownload.mockResolvedValue({ headers: {}, data: '😀' + 'x'.repeat(11999) });
    const [result] = await readWatchPrFailingLogs({ watch, problems: [problem(1)] });
    if (result?.kind !== 'failed_check' || result.log === null) throw new Error('Missing log');
    expect(result.log.charCodeAt(0)).toBe(120);
    expect(result.log.length).toBe(11999);
  });
});
