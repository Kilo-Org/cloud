import { TRPCError } from '@trpc/server';
import type { Owner } from '@/lib/integrations/core/types';
import type { DeploymentSource } from './types';
import { markAsPlaintext } from './env-vars-validation';
import { createDeployment, redeployByDeploymentId } from './deployments-service';

const mockDb = {
  select: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  transaction: jest.fn(),
};

const mockBuilderClient = {
  createDeployment: jest.fn(),
  getDeploymentStatus: jest.fn(),
  getDeploymentEvents: jest.fn(),
  cancelBuild: jest.fn(),
  deleteWorker: jest.fn(),
};

const mockDispatcherClient = {
  setSlugMapping: jest.fn(),
  deleteSlugMapping: jest.fn(),
  getPasswordStatus: jest.fn(),
  setPassword: jest.fn(),
  removePassword: jest.fn(),
  enableBanner: jest.fn(),
  disableBanner: jest.fn(),
};

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  get db() {
    return mockDb;
  },
}));

jest.mock('./deployment-builder-client', () => ({
  get apiClient() {
    return mockBuilderClient;
  },
}));

jest.mock('./dispatcher-client', () => ({
  DispatcherSlugTakenError: class extends Error {},
  get dispatcherClient() {
    return mockDispatcherClient;
  },
}));

const owners: Owner[] = [
  { type: 'user', id: 'oauth/test-user' },
  { type: 'org', id: 'a7e4dc29-74bf-4a75-a390-187a7ee0fdfb' },
];

const sources: DeploymentSource[] = [
  { type: 'git', gitUrl: 'https://git.example.com/owner/repo.git', authToken: 'test-token' },
  {
    type: 'github',
    platformIntegrationId: '2e620882-53c7-456b-93b6-ef39e15c646e',
    repositoryFullName: 'owner/repo',
  },
  {
    type: 'app-builder',
    gitUrl: 'https://app-builder.example.com/apps/a7e4dc29-74bf-4a75-a390-187a7ee0fdfb.git',
  },
];

const creationOrigins: ('deploy' | 'app-builder')[] = ['deploy', 'app-builder'];
const eolError = {
  code: 'METHOD_NOT_SUPPORTED',
  message:
    'Deploy has reached end of life. New deployments and redeployments are no longer available.',
};

describe.each(owners)('Deploy end of life for $type owners', owner => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    for (const effect of [
      ...Object.values(mockDb),
      ...Object.values(mockBuilderClient),
      ...Object.values(mockDispatcherClient),
    ]) {
      expect(effect).not.toHaveBeenCalled();
    }
  });

  describe.each(creationOrigins)('creation from %s', createdFrom => {
    it.each(sources)('rejects $type sources without side effects', async source => {
      const result = createDeployment({
        owner,
        source,
        branch: 'main',
        createdByUserId: 'oauth/test-user',
        createdFrom,
        envVars: [markAsPlaintext({ key: 'API_TOKEN', value: 'test-value', isSecret: true })],
      });

      await expect(result).rejects.toBeInstanceOf(TRPCError);
      await expect(result).rejects.toMatchObject(eolError);
    });
  });

  it('rejects redeployment without looking up the deployment or dispatching a build', async () => {
    const result = redeployByDeploymentId('4a3f238b-5e9e-4761-8d7b-1e025b30fb54', owner);

    await expect(result).rejects.toBeInstanceOf(TRPCError);
    await expect(result).rejects.toMatchObject(eolError);
  });
});
