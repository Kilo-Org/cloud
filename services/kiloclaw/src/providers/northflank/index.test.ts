import { beforeEach, describe, expect, it, vi } from 'vitest';
import { northflankProviderAdapter } from './index';
import type { RuntimeSpec } from '../types';
import {
  createDeploymentService,
  createProject,
  createProjectSecret,
  createVolume,
  findProjectByName,
  findServiceByName,
  findVolumeByName,
  getProject,
  getService,
  getVolume,
  patchDeploymentService,
  scaleService,
  waitForDeploymentCompleted,
} from '../../northflank/client';

vi.mock('../../northflank/client', () => ({
  createDeploymentService: vi.fn(),
  createProject: vi.fn(),
  createProjectSecret: vi.fn(),
  createVolume: vi.fn(),
  deleteProject: vi.fn(),
  deleteProjectSecret: vi.fn(),
  deleteService: vi.fn(),
  deleteVolume: vi.fn(),
  findProjectByName: vi.fn(),
  findProjectSecretByName: vi.fn(),
  findServiceByName: vi.fn(),
  findVolumeByName: vi.fn(),
  getProject: vi.fn(),
  getService: vi.fn(),
  getVolume: vi.fn(),
  isNorthflankConflict: vi.fn(() => false),
  isNorthflankNotFound: vi.fn(() => false),
  patchDeploymentService: vi.fn(),
  putProjectSecret: vi.fn(),
  scaleService: vi.fn(),
  waitForDeploymentCompleted: vi.fn(),
}));

const env = {
  NF_API_TOKEN: 'nf-token',
  NF_API_BASE: 'https://api.northflank.com/v1',
  NF_REGION: 'us-central',
  NF_DEPLOYMENT_PLAN: 'nf-compute-200',
  NF_STORAGE_CLASS_NAME: 'nf-multi-rw',
  NF_STORAGE_ACCESS_MODE: 'ReadWriteMany',
  NF_VOLUME_SIZE_MB: '10240',
  NF_EPHEMERAL_STORAGE_MB: '2048',
  NF_EDGE_HEADER_NAME: 'x-kiloclaw-edge',
  NF_EDGE_HEADER_VALUE: 'edge-secret',
  NF_IMAGE_PATH_TEMPLATE: 'ghcr.io/kilo-org/kiloclaw:{tag}',
};

const runtimeSpec = {
  imageRef: 'ghcr.io/kilo-org/kiloclaw:test',
  env: { KILOCLAW_ENC_KILOCODE_API_KEY: 'enc:v1:value' },
  bootstrapEnv: { KILOCLAW_ENV_KEY: 'env-key' },
  machineSize: null,
  rootMountPath: '/root',
  controllerPort: 18789,
  controllerHealthCheckPath: '/_kilo/health',
  metadata: { kiloclaw_user_id: 'user-1', kiloclaw_sandbox_id: 'ki_123' },
} satisfies RuntimeSpec;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('northflankProviderAdapter', () => {
  it('returns routing target with configured trusted edge header', async () => {
    const target = await northflankProviderAdapter.getRoutingTarget({
      env: env as never,
      state: {
        providerState: {
          provider: 'northflank',
          projectId: 'project-1',
          projectName: 'kc-ki-123',
          serviceId: 'service-1',
          serviceName: 'kc-ki-123',
          volumeId: 'volume-1',
          volumeName: 'kc-ki-123',
          secretId: 'secret-1',
          secretName: 'kc-ki-123',
          ingressHost: 'kc-ki-123.code.run',
          region: 'us-central',
        },
      } as never,
    });

    expect(target).toEqual({
      origin: 'https://kc-ki-123.code.run',
      headers: { 'x-kiloclaw-edge': 'edge-secret' },
    });
  });

  it('creates project and root volume during provisioning', async () => {
    vi.mocked(findProjectByName).mockResolvedValue(null);
    vi.mocked(createProject).mockResolvedValue({ id: 'project-1', name: 'kc-ki-123' });
    vi.mocked(findVolumeByName).mockResolvedValue(null);
    vi.mocked(createVolume).mockResolvedValue({ id: 'volume-1', name: 'kc-ki-123' });

    const result = await northflankProviderAdapter.ensureProvisioningResources({
      env: env as never,
      state: { sandboxId: 'ki_123', providerState: null, status: null } as never,
      orgId: null,
      machineSize: null,
    });

    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({ apiToken: 'nf-token' }),
      expect.objectContaining({ name: 'kc-ki-123', region: 'us-central' })
    );
    expect(createVolume).toHaveBeenCalledWith(
      expect.objectContaining({ apiToken: 'nf-token' }),
      'project-1',
      expect.objectContaining({ mountPath: '/root', storageSizeMb: 10240 })
    );
    expect(result.providerState).toEqual(
      expect.objectContaining({
        provider: 'northflank',
        projectId: 'project-1',
        volumeId: 'volume-1',
        region: 'us-central',
      })
    );
  });

  it('creates service at zero instances, writes restricted secret, then scales up', async () => {
    vi.mocked(findServiceByName).mockResolvedValue(null);
    vi.mocked(createDeploymentService).mockResolvedValue({
      id: 'service-1',
      name: 'kc-ki-123',
      ports: [{ name: 'p01', dns: 'kc-ki-123.code.run' }],
    });
    vi.mocked(createProjectSecret).mockResolvedValue({ id: 'secret-1', name: 'kc-ki-123' });
    vi.mocked(patchDeploymentService).mockResolvedValue({ id: 'service-1', name: 'kc-ki-123' });
    vi.mocked(scaleService).mockResolvedValue(undefined);
    vi.mocked(waitForDeploymentCompleted).mockResolvedValue({
      id: 'service-1',
      name: 'kc-ki-123',
      ports: [{ name: 'p01', dns: 'kc-ki-123.code.run' }],
    });
    const onProviderResult = vi.fn();

    const result = await northflankProviderAdapter.startRuntime({
      env: env as never,
      state: {
        sandboxId: 'ki_123',
        providerState: {
          provider: 'northflank',
          projectId: 'project-1',
          projectName: 'kc-ki-123',
          serviceId: null,
          serviceName: null,
          volumeId: 'volume-1',
          volumeName: 'kc-ki-123',
          secretId: null,
          secretName: null,
          ingressHost: null,
          region: 'us-central',
        },
      } as never,
      runtimeSpec,
      onProviderResult,
    });

    const servicePayload = vi.mocked(createDeploymentService).mock.calls[0]?.[2];
    expect(servicePayload?.deployment.instances).toBe(0);
    expect(servicePayload?.createOptions?.volumesToAttach).toEqual(['kc-ki-123']);
    expect(servicePayload?.runtimeEnvironment).toEqual(runtimeSpec.env);
    expect(createProjectSecret).toHaveBeenCalledWith(
      expect.objectContaining({ apiToken: 'nf-token' }),
      'project-1',
      expect.objectContaining({
        restrictions: { restricted: true, nfObjects: [{ id: 'service-1', type: 'service' }] },
        secrets: { variables: runtimeSpec.bootstrapEnv },
      })
    );
    expect(scaleService).toHaveBeenCalledWith(
      expect.objectContaining({ apiToken: 'nf-token' }),
      'project-1',
      'service-1',
      1
    );
    expect(result.providerState).toEqual(
      expect.objectContaining({
        serviceId: 'service-1',
        secretId: 'secret-1',
        ingressHost: 'kc-ki-123.code.run',
      })
    );
    expect(onProviderResult).toHaveBeenCalledTimes(2);
  });

  it('maps missing service IDs to missing runtime observation', async () => {
    const result = await northflankProviderAdapter.inspectRuntime({
      env: env as never,
      state: { providerState: { provider: 'northflank' } } as never,
    });

    expect(getService).not.toHaveBeenCalled();
    expect(result.observation?.runtimeState).toBe('missing');
  });

  it('verifies persisted volumes without recreating active missing storage', async () => {
    vi.mocked(getProject).mockResolvedValue({ id: 'project-1', name: 'kc-ki-123' });
    vi.mocked(findProjectByName).mockResolvedValue({ id: 'project-1', name: 'kc-ki-123' });
    vi.mocked(findVolumeByName).mockResolvedValue(null);
    vi.mocked(getVolume).mockResolvedValue({ id: 'volume-1', name: 'kc-ki-123' });

    await expect(
      northflankProviderAdapter.ensureStorage({
        env: env as never,
        state: {
          sandboxId: 'ki_123',
          status: 'running',
          providerState: {
            provider: 'northflank',
            projectId: 'project-1',
            projectName: 'kc-ki-123',
            volumeId: 'volume-1',
            volumeName: 'kc-ki-123',
          },
        } as never,
        reason: 'test',
      })
    ).rejects.toThrow('Northflank volume is missing for an active instance');
  });
});
