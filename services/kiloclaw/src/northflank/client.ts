import { z } from 'zod';
import { ApiClient, ApiClientInMemoryContextProvider } from '@northflank/js-client';
import type {
  ApiCallResponse,
  CreateProjectRequest,
  CreateProjectResult,
  CreateSecretRequest,
  CreateSecretResult,
  CreateServiceDeploymentRequest,
  CreateServiceDeploymentResult,
  CreateVolumeRequest,
  CreateVolumeResult,
  DeleteProjectRequest,
  DeleteProjectResult,
  DeleteSecretRequest,
  DeleteSecretResult,
  DeleteServiceRequest,
  DeleteServiceResult,
  DeleteVolumeRequest,
  DeleteVolumeResult,
  GetSecretdetailsRequest,
  GetSecretdetailsResult,
  GetServiceRequest,
  GetServiceResult,
  GetVolumeRequest,
  GetVolumeResult,
  ListProjectsRequest,
  ListProjectsResult,
  ListSecretsRequest,
  ListSecretsResult,
  ListServicesRequest,
  ListServicesResult,
  ListVolumesRequest,
  ListVolumesResult,
  PatchServiceDeploymentRequest,
  PatchServiceDeploymentResult,
  PutSecretRequest,
  PutSecretResult,
  ScaleServiceRequest,
  ScaleServiceResult,
} from '@northflank/js-client';
import type { NorthflankConfig } from './config';

export type NorthflankSdk = {
  create: {
    project: (opts: CreateProjectRequest) => Promise<ApiCallResponse<CreateProjectResult>>;
    volume: (opts: CreateVolumeRequest) => Promise<ApiCallResponse<CreateVolumeResult>>;
    service: {
      deployment: (
        opts: CreateServiceDeploymentRequest
      ) => Promise<ApiCallResponse<CreateServiceDeploymentResult>>;
    };
    secret: (opts: CreateSecretRequest) => Promise<ApiCallResponse<CreateSecretResult>>;
  };
  list: {
    projects: {
      (opts: ListProjectsRequest): Promise<ApiCallResponse<ListProjectsResult>>;
      all: (opts: ListProjectsRequest) => Promise<ApiCallResponse<ListProjectsResult>>;
    };
    volumes: {
      (opts: ListVolumesRequest): Promise<ApiCallResponse<ListVolumesResult>>;
      all: (opts: ListVolumesRequest) => Promise<ApiCallResponse<ListVolumesResult>>;
    };
    services: {
      (opts: ListServicesRequest): Promise<ApiCallResponse<ListServicesResult>>;
      all: (opts: ListServicesRequest) => Promise<ApiCallResponse<ListServicesResult>>;
    };
    secrets: {
      (opts: ListSecretsRequest): Promise<ApiCallResponse<ListSecretsResult>>;
      all: (opts: ListSecretsRequest) => Promise<ApiCallResponse<ListSecretsResult>>;
    };
  };
  get: {
    project: (opts: { parameters: { projectId: string } }) => Promise<ApiCallResponse<unknown>>;
    volume: (opts: GetVolumeRequest) => Promise<ApiCallResponse<GetVolumeResult>>;
    service: (opts: GetServiceRequest) => Promise<ApiCallResponse<GetServiceResult>>;
    secretDetails: (
      opts: GetSecretdetailsRequest
    ) => Promise<ApiCallResponse<GetSecretdetailsResult>>;
  };
  patch: {
    service: {
      deployment: (
        opts: PatchServiceDeploymentRequest
      ) => Promise<ApiCallResponse<PatchServiceDeploymentResult>>;
    };
  };
  put: {
    secret: (opts: PutSecretRequest) => Promise<ApiCallResponse<PutSecretResult>>;
  };
  delete: {
    project: (opts: DeleteProjectRequest) => Promise<ApiCallResponse<DeleteProjectResult>>;
    volume: (opts: DeleteVolumeRequest) => Promise<ApiCallResponse<DeleteVolumeResult>>;
    service: (opts: DeleteServiceRequest) => Promise<ApiCallResponse<DeleteServiceResult>>;
    secret: (opts: DeleteSecretRequest) => Promise<ApiCallResponse<DeleteSecretResult>>;
  };
  scale: {
    service: (opts: ScaleServiceRequest) => Promise<ApiCallResponse<ScaleServiceResult>>;
  };
};

export type NorthflankClientConfig = NorthflankConfig & {
  redactValues?: string[];
  sdk?: NorthflankSdk;
};

export type NorthflankRateLimitInfo = {
  limit: string | null;
  remaining: string | null;
  reset: string | null;
};

export class NorthflankApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly requestId: string | null,
    readonly rateLimit: NorthflankRateLimitInfo
  ) {
    super(message);
    this.name = 'NorthflankApiError';
  }
}

const NorthflankProjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .passthrough();

const NorthflankVolumeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .passthrough();

const NorthflankPortSchema = z
  .object({
    name: z.string().optional(),
    dns: z.string().nullable().optional(),
  })
  .passthrough();

const NorthflankServiceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    servicePaused: z.boolean().optional(),
    ports: z.array(NorthflankPortSchema).optional(),
    deployment: z
      .object({
        instances: z.number().int().optional(),
      })
      .passthrough()
      .optional(),
    status: z
      .object({
        deployment: z
          .object({
            status: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const NorthflankSecretDetailsSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .passthrough();

const ListProjectsDataSchema = z.object({ projects: z.array(NorthflankProjectSchema) });
const ListServicesDataSchema = z.object({ services: z.array(NorthflankServiceSchema) });
const ListSecretsDataSchema = z.object({ secrets: z.array(NorthflankSecretDetailsSchema) });

export type NorthflankProject = z.infer<typeof NorthflankProjectSchema>;
export type NorthflankVolume = z.infer<typeof NorthflankVolumeSchema>;
export type NorthflankService = z.infer<typeof NorthflankServiceSchema>;
export type NorthflankSecretDetails = z.infer<typeof NorthflankSecretDetailsSchema>;

function normalizeSdkHost(apiBase: string): string {
  return apiBase.replace(/\/$/, '').replace(/\/v1$/, '');
}

export function createNorthflankSdk(config: NorthflankClientConfig): NorthflankSdk {
  if (config.sdk) return config.sdk;

  const contextProvider = new ApiClientInMemoryContextProvider();
  contextProvider.addContext({
    name: 'kiloclaw',
    token: config.apiToken,
    host: normalizeSdkHost(config.apiBase),
  });

  return new ApiClient(contextProvider, { throwErrorOnHttpErrorCode: true });
}

function teamParameters(
  config: Pick<NorthflankClientConfig, 'teamId'>
): { teamId: string } | undefined {
  return config.teamId ? { teamId: config.teamId } : undefined;
}

function projectParameters(
  config: Pick<NorthflankClientConfig, 'teamId'>,
  projectId: string
): { projectId: string } | { teamId: string; projectId: string } {
  return config.teamId ? { teamId: config.teamId, projectId } : { projectId };
}

function serviceParameters(
  config: Pick<NorthflankClientConfig, 'teamId'>,
  projectId: string,
  serviceId: string
):
  | { projectId: string; serviceId: string }
  | { teamId: string; projectId: string; serviceId: string } {
  return config.teamId ? { teamId: config.teamId, projectId, serviceId } : { projectId, serviceId };
}

function volumeParameters(
  config: Pick<NorthflankClientConfig, 'teamId'>,
  projectId: string,
  volumeId: string
):
  | { projectId: string; volumeId: string }
  | { teamId: string; projectId: string; volumeId: string } {
  return config.teamId ? { teamId: config.teamId, projectId, volumeId } : { projectId, volumeId };
}

function secretParameters(
  projectId: string,
  secretId: string
): { projectId: string; secretId: string } {
  return { projectId, secretId };
}

function headersToRateLimit(headers: Headers | undefined): NorthflankRateLimitInfo {
  return {
    limit: headers?.get('x-ratelimit-limit') ?? null,
    remaining: headers?.get('x-ratelimit-remaining') ?? null,
    reset: headers?.get('x-ratelimit-reset') ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  return /(authorization|password|token|secret|api[_-]?key|credential)/i.test(key);
}

function redactUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => redactUnknown(item));
  if (!isRecord(value)) return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key) ? '[REDACTED]' : redactUnknown(nestedValue);
  }
  return redacted;
}

function redactText(text: string, config: NorthflankClientConfig): string {
  let redacted = text;
  const values = [config.apiToken, ...(config.redactValues ?? [])].filter(
    value => value.length > 0
  );
  for (const value of values) {
    redacted = redacted.split(value).join('[REDACTED]');
  }
  return redacted;
}

function redactForError(value: unknown, config: NorthflankClientConfig): string {
  try {
    return redactText(JSON.stringify(redactUnknown(value)), config);
  } catch {
    return redactText(String(value), config);
  }
}

function maybeStatus(err: unknown): number {
  if (!isRecord(err)) return 500;
  const status = err.status;
  return typeof status === 'number' ? status : 500;
}

function maybeMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (!isRecord(err)) return String(err);
  const message = err.message;
  if (typeof message === 'string') return message;
  try {
    return JSON.stringify(redactUnknown(err));
  } catch {
    return 'Northflank SDK error';
  }
}

async function callSdk<TResponse, TParsed>(
  config: NorthflankClientConfig,
  context: string,
  call: () => Promise<ApiCallResponse<TResponse>>,
  parser: (value: unknown) => TParsed
): Promise<TParsed> {
  try {
    const response = await call();
    if (response.error) {
      const body = redactForError(response.error, config);
      throw new NorthflankApiError(
        `Northflank API ${context} failed (${response.error.status}): ${body}`,
        response.error.status,
        body,
        response.rawResponse.headers.get('x-request-id'),
        headersToRateLimit(response.rawResponse.headers)
      );
    }
    return parser(response.data);
  } catch (err) {
    if (err instanceof NorthflankApiError) throw err;
    const status = maybeStatus(err);
    const body = redactForError(err, config);
    throw new NorthflankApiError(
      `Northflank API ${context} failed (${status}): ${body}`,
      status,
      body,
      null,
      headersToRateLimit(undefined)
    );
  }
}

export async function createProject(
  config: NorthflankClientConfig,
  input: { name: string; region: string; description?: string }
): Promise<NorthflankProject> {
  const sdk = createNorthflankSdk(config);
  const parameters = teamParameters(config);
  return callSdk(
    config,
    'createProject',
    () => sdk.create.project({ parameters, data: input }),
    value => NorthflankProjectSchema.parse(value)
  );
}

export async function listProjects(
  config: NorthflankClientConfig,
  pagination?: { page?: number; perPage?: number }
): Promise<{ projects: NorthflankProject[]; hasNextPage: boolean }> {
  const sdk = createNorthflankSdk(config);
  const response = await callSdk(
    config,
    'listProjects',
    () =>
      sdk.list.projects({
        parameters: teamParameters(config),
        options: { page: pagination?.page, per_page: pagination?.perPage },
      }),
    value => ListProjectsDataSchema.parse(value)
  );
  return { projects: response.projects, hasNextPage: false };
}

export async function findProjectByName(
  config: NorthflankClientConfig,
  name: string
): Promise<NorthflankProject | null> {
  const sdk = createNorthflankSdk(config);
  const response = await callSdk(
    config,
    'findProjectByName',
    () => sdk.list.projects.all({ parameters: teamParameters(config) }),
    value => ListProjectsDataSchema.parse(value)
  );
  return response.projects.find(project => project.name === name) ?? null;
}

export async function getProject(
  config: NorthflankClientConfig,
  projectId: string
): Promise<NorthflankProject> {
  const sdk = createNorthflankSdk(config);
  return callSdk(
    config,
    'getProject',
    () => sdk.get.project({ parameters: { projectId } }),
    value => NorthflankProjectSchema.parse(value)
  );
}

export async function deleteProject(
  config: NorthflankClientConfig,
  projectId: string,
  deleteChildObjects = false
): Promise<void> {
  const sdk = createNorthflankSdk(config);
  await callSdk(
    config,
    'deleteProject',
    () =>
      sdk.delete.project({
        parameters: projectParameters(config, projectId),
        options: { delete_child_objects: deleteChildObjects },
      }),
    () => undefined
  );
}

export async function createVolume(
  config: NorthflankClientConfig,
  projectId: string,
  input: {
    name: string;
    mountPath: '/root';
    storageSizeMb: number;
    storageClassName: string;
    accessMode: string;
  }
): Promise<NorthflankVolume> {
  const sdk = createNorthflankSdk(config);
  return callSdk(
    config,
    'createVolume',
    () =>
      sdk.create.volume({
        parameters: projectParameters(config, projectId),
        data: {
          name: input.name,
          mounts: [{ containerMountPath: input.mountPath }],
          spec: {
            accessMode: input.accessMode === 'ReadWriteOnce' ? 'ReadWriteOnce' : 'ReadWriteMany',
            storageClassName: input.storageClassName,
            storageSize: input.storageSizeMb,
          },
        },
      }),
    value => NorthflankVolumeSchema.parse(value)
  );
}

export async function listVolumes(
  config: NorthflankClientConfig,
  projectId: string
): Promise<NorthflankVolume[]> {
  const sdk = createNorthflankSdk(config);
  return callSdk(
    config,
    'listVolumes',
    () => sdk.list.volumes.all({ parameters: projectParameters(config, projectId) }),
    value => z.array(NorthflankVolumeSchema).parse(value)
  );
}

export async function findVolumeByName(
  config: NorthflankClientConfig,
  projectId: string,
  name: string
): Promise<NorthflankVolume | null> {
  const volumes = await listVolumes(config, projectId);
  return volumes.find(volume => volume.name === name) ?? null;
}

export async function getVolume(
  config: NorthflankClientConfig,
  projectId: string,
  volumeIdOrName: string
): Promise<NorthflankVolume> {
  const sdk = createNorthflankSdk(config);
  return callSdk(
    config,
    'getVolume',
    () => sdk.get.volume({ parameters: volumeParameters(config, projectId, volumeIdOrName) }),
    value => NorthflankVolumeSchema.parse(value)
  );
}

export async function deleteVolume(
  config: NorthflankClientConfig,
  projectId: string,
  volumeIdOrName: string
): Promise<void> {
  const sdk = createNorthflankSdk(config);
  await callSdk(
    config,
    'deleteVolume',
    () => sdk.delete.volume({ parameters: volumeParameters(config, projectId, volumeIdOrName) }),
    () => undefined
  );
}

export async function createDeploymentService(
  config: NorthflankClientConfig,
  projectId: string,
  payload: CreateServiceDeploymentRequest['data']
): Promise<NorthflankService> {
  const sdk = createNorthflankSdk(config);
  return callSdk(
    config,
    'createDeploymentService',
    () =>
      sdk.create.service.deployment({
        parameters: projectParameters(config, projectId),
        data: payload,
      }),
    value => NorthflankServiceSchema.parse(value)
  );
}

export async function patchDeploymentService(
  config: NorthflankClientConfig,
  projectId: string,
  serviceId: string,
  payload: PatchServiceDeploymentRequest['data']
): Promise<NorthflankService> {
  const sdk = createNorthflankSdk(config);
  return callSdk(
    config,
    'patchDeploymentService',
    () =>
      sdk.patch.service.deployment({
        parameters: serviceParameters(config, projectId, serviceId),
        data: payload,
      }),
    value => NorthflankServiceSchema.parse(value)
  );
}

export async function scaleService(
  config: NorthflankClientConfig,
  projectId: string,
  serviceId: string,
  instances: number
): Promise<void> {
  const sdk = createNorthflankSdk(config);
  await callSdk(
    config,
    'scaleService',
    () =>
      sdk.scale.service({
        parameters: serviceParameters(config, projectId, serviceId),
        data: { instances },
      }),
    () => undefined
  );
}

export async function listServices(
  config: NorthflankClientConfig,
  projectId: string
): Promise<{ services: NorthflankService[]; hasNextPage: boolean }> {
  const sdk = createNorthflankSdk(config);
  const response = await callSdk(
    config,
    'listServices',
    () => sdk.list.services.all({ parameters: projectParameters(config, projectId) }),
    value => ListServicesDataSchema.parse(value)
  );
  return { services: response.services, hasNextPage: false };
}

export async function findServiceByName(
  config: NorthflankClientConfig,
  projectId: string,
  name: string
): Promise<NorthflankService | null> {
  const result = await listServices(config, projectId);
  return result.services.find(service => service.name === name) ?? null;
}

export async function getService(
  config: NorthflankClientConfig,
  projectId: string,
  serviceId: string
): Promise<NorthflankService> {
  const sdk = createNorthflankSdk(config);
  return callSdk(
    config,
    'getService',
    () => sdk.get.service({ parameters: serviceParameters(config, projectId, serviceId) }),
    value => NorthflankServiceSchema.parse(value)
  );
}

export async function deleteService(
  config: NorthflankClientConfig,
  projectId: string,
  serviceId: string,
  deleteChildObjects = false
): Promise<void> {
  const sdk = createNorthflankSdk(config);
  await callSdk(
    config,
    'deleteService',
    () =>
      sdk.delete.service({
        parameters: serviceParameters(config, projectId, serviceId),
        options: { delete_child_objects: deleteChildObjects },
      }),
    () => undefined
  );
}

export async function waitForDeploymentCompleted(
  config: NorthflankClientConfig,
  projectId: string,
  serviceId: string,
  timeoutSeconds: number
): Promise<NorthflankService> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastService = await getService(config, projectId, serviceId);
  while (Date.now() < deadline) {
    const deploymentStatus = lastService.status?.deployment?.status;
    if (deploymentStatus === 'COMPLETED') return lastService;
    if (deploymentStatus === 'FAILED') {
      throw new Error(`Northflank deployment failed for service ${serviceId}`);
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
    lastService = await getService(config, projectId, serviceId);
  }
  throw new Error(`Timed out waiting for Northflank deployment ${serviceId} to complete`);
}

export async function createProjectSecret(
  config: NorthflankClientConfig,
  projectId: string,
  payload: CreateSecretRequest['data']
): Promise<NorthflankSecretDetails> {
  const sdk = createNorthflankSdk(config);
  return callSdk(
    config,
    'createProjectSecret',
    () => sdk.create.secret({ parameters: { projectId }, data: payload }),
    value => NorthflankSecretDetailsSchema.parse(value)
  );
}

export async function findProjectSecretByName(
  config: NorthflankClientConfig,
  projectId: string,
  name: string
): Promise<NorthflankSecretDetails | null> {
  const sdk = createNorthflankSdk(config);
  const response = await callSdk(
    config,
    'findProjectSecretByName',
    () => sdk.list.secrets.all({ parameters: { projectId } }),
    value => ListSecretsDataSchema.parse(value)
  );
  return response.secrets.find(secret => secret.name === name) ?? null;
}

export async function getProjectSecretDetails(
  config: NorthflankClientConfig,
  projectId: string,
  secretId: string
): Promise<NorthflankSecretDetails> {
  const sdk = createNorthflankSdk(config);
  return callSdk(
    config,
    'getProjectSecretDetails',
    () => sdk.get.secretDetails({ parameters: secretParameters(projectId, secretId) }),
    value => NorthflankSecretDetailsSchema.parse(value)
  );
}

export async function putProjectSecret(
  config: NorthflankClientConfig,
  projectId: string,
  secretId: string,
  payload: PutSecretRequest['data']
): Promise<NorthflankSecretDetails> {
  const sdk = createNorthflankSdk(config);
  return callSdk(
    config,
    'putProjectSecret',
    () => sdk.put.secret({ parameters: secretParameters(projectId, secretId), data: payload }),
    value => NorthflankSecretDetailsSchema.parse(value)
  );
}

export async function deleteProjectSecret(
  config: NorthflankClientConfig,
  projectId: string,
  secretId: string
): Promise<void> {
  const sdk = createNorthflankSdk(config);
  await callSdk(
    config,
    'deleteProjectSecret',
    () => sdk.delete.secret({ parameters: secretParameters(projectId, secretId) }),
    () => undefined
  );
}

export function isNorthflankNotFound(err: unknown): boolean {
  return err instanceof NorthflankApiError && err.status === 404;
}

export function isNorthflankConflict(err: unknown): boolean {
  return err instanceof NorthflankApiError && err.status === 409;
}

export function northflankErrorMessage(err: unknown): string {
  return maybeMessage(err);
}
