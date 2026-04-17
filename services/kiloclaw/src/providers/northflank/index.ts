import type { CreateSecretRequest, CreateServiceDeploymentRequest } from '@northflank/js-client';
import type { NorthflankProviderState } from '../../schemas/instance-config';
import { STARTUP_TIMEOUT_SECONDS } from '../../config';
import { getNorthflankProviderState } from '../../durable-objects/kiloclaw-instance/state';
import type { RuntimeSpec, InstanceProviderAdapter } from '../types';
import { getNorthflankConfig } from '../../northflank/config';
import {
  createDeploymentService,
  createProject,
  createProjectSecret,
  createVolume,
  deleteProject,
  deleteProjectSecret,
  deleteService,
  deleteVolume,
  findProjectByName,
  findProjectSecretByName,
  findServiceByName,
  findVolumeByName,
  getProject,
  getService,
  getVolume,
  isNorthflankConflict,
  isNorthflankNotFound,
  patchDeploymentService,
  putProjectSecret,
  scaleService,
  waitForDeploymentCompleted,
  type NorthflankClientConfig,
  type NorthflankProject,
  type NorthflankService,
  type NorthflankVolume,
} from '../../northflank/client';
import { northflankResourceNames } from './names';

const NORTHFLANK_PORT_NAME = 'p01';

type NorthflankProvisioningNames = Awaited<ReturnType<typeof northflankResourceNames>>;

function requireSandboxId(state: { sandboxId: string | null }): string {
  if (!state.sandboxId) {
    throw new Error('Provider northflank requires a sandboxId');
  }
  return state.sandboxId;
}

function northflankClientConfig(
  env: Parameters<typeof getNorthflankConfig>[0]
): NorthflankClientConfig {
  return getNorthflankConfig(env);
}

async function getProvisioningNames(state: {
  sandboxId: string | null;
}): Promise<NorthflankProvisioningNames> {
  return northflankResourceNames(requireSandboxId(state));
}

async function ensureProject(
  config: NorthflankClientConfig,
  providerState: NorthflankProviderState,
  names: NorthflankProvisioningNames,
  region: string
): Promise<NorthflankProject> {
  if (providerState.projectId) {
    try {
      return await getProject(config, providerState.projectId);
    } catch (err) {
      if (!isNorthflankNotFound(err)) throw err;
    }
  }

  const existing = await findProjectByName(config, providerState.projectName ?? names.projectName);
  if (existing) return existing;

  try {
    return await createProject(config, {
      name: names.projectName,
      region,
      description: 'KiloClaw Northflank sandbox project',
    });
  } catch (err) {
    if (!isNorthflankConflict(err)) throw err;
    const recovered = await findProjectByName(config, names.projectName);
    if (recovered) return recovered;
    throw err;
  }
}

async function ensureVolumeResource(
  config: NorthflankClientConfig,
  projectId: string,
  providerState: NorthflankProviderState,
  names: NorthflankProvisioningNames,
  options: {
    storageSizeMb: number;
    storageClassName: string;
    accessMode: string;
  }
): Promise<NorthflankVolume> {
  if (providerState.volumeId) {
    try {
      return await getVolume(config, projectId, providerState.volumeId);
    } catch (err) {
      if (!isNorthflankNotFound(err)) throw err;
    }
  }

  const existing = await findVolumeByName(
    config,
    projectId,
    providerState.volumeName ?? names.volumeName
  );
  if (existing) return existing;

  try {
    return await createVolume(config, projectId, {
      name: names.volumeName,
      mountPath: '/root',
      storageSizeMb: options.storageSizeMb,
      storageClassName: options.storageClassName,
      accessMode: options.accessMode,
    });
  } catch (err) {
    if (!isNorthflankConflict(err)) throw err;
    const recovered = await findVolumeByName(config, projectId, names.volumeName);
    if (recovered) return recovered;
    throw err;
  }
}

function mergeProviderState(
  providerState: NorthflankProviderState,
  names: NorthflankProvisioningNames,
  project: NorthflankProject,
  volume: NorthflankVolume,
  region: string
): NorthflankProviderState {
  return {
    ...providerState,
    projectId: project.id,
    projectName: project.name || names.projectName,
    volumeId: volume.id,
    volumeName: volume.name || names.volumeName,
    region,
  };
}

function firstIngressHost(service: NorthflankService): string | null {
  return service.ports?.find(port => port.dns)?.dns ?? null;
}

function northflankOrigin(host: string): string {
  return host.startsWith('http://') || host.startsWith('https://') ? host : `https://${host}`;
}

function buildPortSecurity(config: NorthflankClientConfig) {
  const nfConfig = config;
  return {
    verificationMode: 'and' as const,
    securePathConfiguration: {
      enabled: true,
      skipSecurityPoliciesForInternalTrafficViaPublicDns: false,
      rules: [
        {
          paths: [],
          accessMode: 'protected' as const,
          securityPolicies: {
            requiredPolicies: {
              headers: [
                {
                  name: nfConfig.edgeHeaderName,
                  value: nfConfig.edgeHeaderValue,
                  regexMode: false,
                },
              ],
            },
          },
        },
      ],
    },
  };
}

function deploymentImage(config: NorthflankClientConfig, imageRef: string) {
  return config.imageCredentialsId
    ? { imagePath: imageRef, credentials: config.imageCredentialsId }
    : { imagePath: imageRef };
}

function buildServicePayload(
  config: NorthflankClientConfig,
  runtimeSpec: RuntimeSpec,
  serviceName: string,
  volumeName: string,
  instances: number
): CreateServiceDeploymentRequest['data'] {
  return {
    name: serviceName,
    billing: {
      deploymentPlan: config.deploymentPlan,
    },
    deployment: {
      instances,
      external: deploymentImage(config, runtimeSpec.imageRef),
      storage: {
        ephemeralStorage: {
          storageSize: config.ephemeralStorageMb,
        },
      },
      strategy: {
        type: 'recreate',
      },
    },
    ports: [
      {
        name: NORTHFLANK_PORT_NAME,
        internalPort: runtimeSpec.controllerPort,
        protocol: 'HTTP',
        public: true,
        security: buildPortSecurity(config),
      },
    ],
    createOptions: {
      volumesToAttach: [volumeName],
    },
    runtimeEnvironment: runtimeSpec.env,
    healthChecks: [
      {
        protocol: 'HTTP',
        type: 'readinessProbe',
        path: runtimeSpec.controllerHealthCheckPath,
        port: runtimeSpec.controllerPort,
        initialDelaySeconds: 10,
        periodSeconds: 30,
        timeoutSeconds: 5,
        failureThreshold: 10,
        successThreshold: 1,
      },
    ],
  };
}

function buildSecretPayload(
  serviceId: string,
  secretName: string,
  bootstrapEnv: Record<string, string>
): CreateSecretRequest['data'] {
  return {
    name: secretName,
    type: 'secret',
    secretType: 'environment',
    priority: 100,
    restrictions: {
      restricted: true,
      nfObjects: [{ id: serviceId, type: 'service' }],
    },
    secrets: {
      variables: bootstrapEnv,
    },
  };
}

async function ensureSecret(
  config: NorthflankClientConfig,
  projectId: string,
  serviceId: string,
  providerState: NorthflankProviderState,
  names: NorthflankProvisioningNames,
  runtimeSpec: RuntimeSpec
) {
  const payload = buildSecretPayload(serviceId, names.secretName, runtimeSpec.bootstrapEnv);

  if (providerState.secretId) {
    try {
      const secret = await putProjectSecret(config, projectId, providerState.secretId, payload);
      return secret;
    } catch (err) {
      if (!isNorthflankNotFound(err)) throw err;
    }
  }

  try {
    return await createProjectSecret(config, projectId, payload);
  } catch (err) {
    if (!isNorthflankConflict(err)) throw err;
    const recovered = await findProjectSecretByName(config, projectId, names.secretName);
    if (recovered) {
      return await putProjectSecret(config, projectId, recovered.id, payload);
    }
    throw err;
  }
}

function mapRuntimeState(
  service: NorthflankService
): 'starting' | 'running' | 'stopped' | 'failed' {
  if (service.servicePaused) return 'stopped';
  const instances = service.deployment?.instances;
  if (instances === 0) return 'stopped';

  const deploymentStatus = service.status?.deployment?.status;
  if (deploymentStatus === 'FAILED') return 'failed';
  if (deploymentStatus === 'PENDING' || deploymentStatus === 'IN_PROGRESS') return 'starting';
  if (deploymentStatus === 'COMPLETED')
    return instances === undefined || instances > 0 ? 'running' : 'stopped';
  return instances && instances > 0 ? 'starting' : 'stopped';
}

export const northflankProviderAdapter: InstanceProviderAdapter = {
  id: 'northflank',
  capabilities: {
    volumeSnapshots: false,
    candidateVolumes: false,
    volumeReassociation: false,
    snapshotRestore: false,
    directMachineDestroy: false,
  },

  async getRoutingTarget({ env, state }) {
    const config = northflankClientConfig(env);
    const providerState = getNorthflankProviderState(state);
    const ingressHost = providerState.ingressHost;
    if (!ingressHost) {
      throw new Error('No Northflank ingress host for this instance');
    }

    return {
      origin: northflankOrigin(ingressHost),
      headers: {
        [config.edgeHeaderName]: config.edgeHeaderValue,
      },
    };
  },

  async ensureProvisioningResources({ env, state, region }) {
    const config = northflankClientConfig(env);
    const names = await getProvisioningNames(state);
    const providerState = getNorthflankProviderState(state);
    const targetRegion = region ?? providerState.region ?? config.region;
    const project = await ensureProject(config, providerState, names, targetRegion);
    const volume = await ensureVolumeResource(config, project.id, providerState, names, {
      storageSizeMb: config.volumeSizeMb,
      storageClassName: config.storageClassName,
      accessMode: config.storageAccessMode,
    });

    return {
      providerState: mergeProviderState(providerState, names, project, volume, targetRegion),
    };
  },

  async ensureStorage({ env, state }) {
    const config = northflankClientConfig(env);
    const names = await getProvisioningNames(state);
    let providerState = getNorthflankProviderState(state);
    const targetRegion = providerState.region ?? config.region;
    const project = await ensureProject(config, providerState, names, targetRegion);
    providerState = { ...providerState, projectId: project.id, projectName: project.name };

    const existingVolume = await findVolumeByName(
      config,
      project.id,
      providerState.volumeName ?? names.volumeName
    );
    if (
      !existingVolume &&
      (state.status === 'running' || state.status === 'starting' || state.status === 'restarting')
    ) {
      throw new Error('Northflank volume is missing for an active instance');
    }

    const volume =
      existingVolume ??
      (await ensureVolumeResource(config, project.id, providerState, names, {
        storageSizeMb: config.volumeSizeMb,
        storageClassName: config.storageClassName,
        accessMode: config.storageAccessMode,
      }));

    return {
      providerState: mergeProviderState(providerState, names, project, volume, targetRegion),
    };
  },

  async startRuntime({ env, state, runtimeSpec, onProviderResult }) {
    const config = northflankClientConfig(env);
    const names = await getProvisioningNames(state);
    let providerState = getNorthflankProviderState(state);
    const projectId = providerState.projectId;
    const volumeName = providerState.volumeName ?? names.volumeName;
    if (!projectId || !providerState.volumeId) {
      throw new Error('Northflank startRuntime requires project and volume provisioning first');
    }

    let service: NorthflankService;
    if (providerState.serviceId) {
      try {
        service = await getService(config, projectId, providerState.serviceId);
      } catch (err) {
        if (!isNorthflankNotFound(err)) throw err;
        const recovered = await findServiceByName(config, projectId, names.serviceName);
        if (!recovered) throw err;
        service = recovered;
      }
    } else {
      const existing = await findServiceByName(config, projectId, names.serviceName);
      service =
        existing ??
        (await createDeploymentService(
          config,
          projectId,
          buildServicePayload(config, runtimeSpec, names.serviceName, volumeName, 0)
        ));
    }

    providerState = {
      ...providerState,
      serviceId: service.id,
      serviceName: service.name || names.serviceName,
      ingressHost: firstIngressHost(service) ?? providerState.ingressHost,
    };
    await onProviderResult?.({ providerState });

    const secret = await ensureSecret(
      config,
      projectId,
      service.id,
      providerState,
      names,
      runtimeSpec
    );
    providerState = {
      ...providerState,
      secretId: secret.id,
      secretName: secret.name || names.secretName,
    };
    await onProviderResult?.({ providerState });

    await patchDeploymentService(
      config,
      projectId,
      service.id,
      buildServicePayload(config, runtimeSpec, names.serviceName, volumeName, 0)
    );
    await scaleService(config, projectId, service.id, 1);
    const started = await waitForDeploymentCompleted(
      config,
      projectId,
      service.id,
      STARTUP_TIMEOUT_SECONDS
    );

    return {
      providerState: {
        ...providerState,
        ingressHost: firstIngressHost(started) ?? providerState.ingressHost,
      },
      observation: {
        runtimeState: 'running',
      },
    };
  },

  async stopRuntime({ env, state }) {
    const config = northflankClientConfig(env);
    const providerState = getNorthflankProviderState(state);
    if (!providerState.projectId || !providerState.serviceId) {
      return { providerState };
    }

    await scaleService(config, providerState.projectId, providerState.serviceId, 0);
    return {
      providerState,
      observation: {
        runtimeState: 'stopped',
      },
    };
  },

  async restartRuntime({ env, state, runtimeSpec, onProviderResult }) {
    const config = northflankClientConfig(env);
    const names = await getProvisioningNames(state);
    let providerState = getNorthflankProviderState(state);
    if (!providerState.projectId || !providerState.serviceId) {
      throw new Error('No Northflank service exists');
    }
    const projectId = providerState.projectId;
    const serviceId = providerState.serviceId;

    const volumeName = providerState.volumeName ?? names.volumeName;
    await patchDeploymentService(
      config,
      projectId,
      serviceId,
      buildServicePayload(
        config,
        runtimeSpec,
        providerState.serviceName ?? names.serviceName,
        volumeName,
        0
      )
    );
    await onProviderResult?.({ providerState, corePatch: { restartUpdateSent: true } });

    const secret = await ensureSecret(
      config,
      projectId,
      serviceId,
      providerState,
      names,
      runtimeSpec
    );
    providerState = {
      ...providerState,
      secretId: secret.id,
      secretName: secret.name || names.secretName,
    };
    await onProviderResult?.({ providerState });

    await scaleService(config, projectId, serviceId, 1);
    const restarted = await waitForDeploymentCompleted(
      config,
      projectId,
      serviceId,
      STARTUP_TIMEOUT_SECONDS
    );

    return {
      providerState: {
        ...providerState,
        ingressHost: firstIngressHost(restarted) ?? providerState.ingressHost,
      },
      observation: {
        runtimeState: 'running',
      },
    };
  },

  async inspectRuntime({ env, state }) {
    const config = northflankClientConfig(env);
    const providerState = getNorthflankProviderState(state);
    if (!providerState.projectId || !providerState.serviceId) {
      return {
        providerState,
        observation: {
          runtimeState: 'missing',
        },
      };
    }

    try {
      const service = await getService(config, providerState.projectId, providerState.serviceId);
      return {
        providerState: {
          ...providerState,
          ingressHost: firstIngressHost(service) ?? providerState.ingressHost,
        },
        observation: {
          runtimeState: mapRuntimeState(service),
        },
      };
    } catch (err) {
      if (isNorthflankNotFound(err)) {
        return {
          providerState,
          observation: {
            runtimeState: 'missing',
          },
        };
      }
      throw err;
    }
  },

  async destroyRuntime({ env, state }) {
    const config = northflankClientConfig(env);
    const providerState = getNorthflankProviderState(state);
    if (!providerState.projectId) return { providerState };

    if (providerState.serviceId) {
      try {
        await deleteService(config, providerState.projectId, providerState.serviceId, false);
      } catch (err) {
        if (!isNorthflankNotFound(err)) throw err;
      }
    }

    if (providerState.secretId) {
      try {
        await deleteProjectSecret(config, providerState.projectId, providerState.secretId);
      } catch (err) {
        if (!isNorthflankNotFound(err)) throw err;
      }
    }

    return {
      providerState: {
        ...providerState,
        serviceId: null,
        serviceName: null,
        secretId: null,
        secretName: null,
        ingressHost: null,
      },
    };
  },

  async destroyStorage({ env, state }) {
    const config = northflankClientConfig(env);
    const providerState = getNorthflankProviderState(state);
    if (!providerState.projectId) return { providerState };

    if (providerState.volumeId) {
      try {
        await deleteVolume(config, providerState.projectId, providerState.volumeId);
      } catch (err) {
        if (!isNorthflankNotFound(err)) throw err;
      }
    }

    try {
      await deleteProject(config, providerState.projectId, true);
    } catch (err) {
      if (!isNorthflankNotFound(err)) throw err;
    }

    return {
      providerState: {
        ...providerState,
        projectId: null,
        projectName: null,
        volumeId: null,
        volumeName: null,
        region: null,
      },
    };
  },
};
