const mockBackfill = jest.fn(async () => ({ scanned: 0, skipped: 0 }));
const mockReport = jest.fn(async () => []);
const mockClose = jest.fn(async () => {});

jest.mock('@/lib/load-env', () => ({}));
jest.mock('@/lib/drizzle', () => ({ closeAllDrizzleConnections: mockClose }));
jest.mock('@/lib/integrations/db/github-installations-backfill', () => ({
  backfillGitHubInstallations: mockBackfill,
  reportGitHubConnectionRoleReconciliation: mockReport,
}));

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

it.each(['--reportRoles', '--reportRoles=true'])(
  '%s runs only the read-only report',
  async flag => {
    process.argv = ['node', 'backfill-github-installations', flag, '--limit=2'];
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const closed = new Promise<void>(resolve =>
      mockClose.mockImplementation(async () => resolve())
    );
    await jest.isolateModulesAsync(async () => {
      await import('@/scripts/backfill-github-installations');
      await closed;
    });
    expect(mockReport).toHaveBeenCalledWith(2, undefined);
    expect(mockBackfill).not.toHaveBeenCalled();
  }
);

it('retains explicit backfill mode when no report flag is supplied', async () => {
  process.argv = ['node', 'backfill-github-installations', '--limit=2'];
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const closed = new Promise<void>(resolve => mockClose.mockImplementation(async () => resolve()));
  await jest.isolateModulesAsync(async () => {
    await import('@/scripts/backfill-github-installations');
    await closed;
  });
  expect(mockBackfill).toHaveBeenCalledWith(2, undefined);
  expect(mockReport).not.toHaveBeenCalled();
});
