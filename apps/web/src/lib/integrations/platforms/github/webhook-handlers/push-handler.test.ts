import { captureException } from '@sentry/nextjs';
import { app_builder_projects, type PlatformIntegration } from '@kilocode/db/schema';
import { triggerBuild } from '@/lib/app-builder/app-builder-client';
import { handlePushEvent } from './push-handler';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  get db() {
    return mockDb;
  },
}));
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({ logExceptInTest: jest.fn() }));
jest.mock('@/lib/app-builder/app-builder-client', () => ({ triggerBuild: jest.fn() }));

const integration = {
  id: 'github-integration',
  github_connection_role: 'workflow',
} as PlatformIntegration;

const pushEvent = {
  ref: 'refs/heads/main',
  repository: { full_name: 'acme/app' },
  deleted: false,
};
const mockWhere = jest.fn();
const mockFrom = jest.fn(() => ({ where: mockWhere }));
const mockDb = { select: jest.fn(() => ({ from: mockFrom })) };

describe('GitHub push handling after Deploy EOL', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWhere.mockResolvedValue([{ id: 'project-1' }, { id: 'project-2' }]);
    jest.mocked(triggerBuild).mockResolvedValue(undefined);
  });

  it('only queries App Builder projects and rebuilds previews for main pushes', async () => {
    await handlePushEvent(pushEvent, integration);

    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledWith(app_builder_projects);
    expect(triggerBuild).toHaveBeenCalledTimes(2);
    expect(triggerBuild).toHaveBeenCalledWith('project-1');
    expect(triggerBuild).toHaveBeenCalledWith('project-2');
  });

  it('does not look up deployments or build previews for other branches', async () => {
    await handlePushEvent({ ...pushEvent, ref: 'refs/heads/feature' }, integration);

    expect(mockDb.select).not.toHaveBeenCalled();
    expect(triggerBuild).not.toHaveBeenCalled();
  });

  it('ignores agent-only integrations', async () => {
    await handlePushEvent(pushEvent, { ...integration, github_connection_role: 'agent_only' });

    expect(mockDb.select).not.toHaveBeenCalled();
    expect(triggerBuild).not.toHaveBeenCalled();
  });

  it('does not start a build when no preview projects match', async () => {
    mockWhere.mockResolvedValue([]);

    await handlePushEvent(pushEvent, integration);

    expect(mockFrom).toHaveBeenCalledWith(app_builder_projects);
    expect(triggerBuild).not.toHaveBeenCalled();
  });

  it('continues rebuilding other previews when one build fails', async () => {
    const error = new Error('Preview build failed');
    jest.mocked(triggerBuild).mockRejectedValueOnce(error);

    await handlePushEvent(pushEvent, integration);

    expect(triggerBuild).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ tags: expect.objectContaining({ projectId: 'project-1' }) })
    );
  });
});
