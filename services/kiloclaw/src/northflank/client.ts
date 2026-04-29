import { z } from 'zod';
import type {
  CreateSecretRequest,
  CreateServiceDeploymentRequest,
  PatchSecretRequest,
  PatchServiceDeploymentRequest,
} from '@northflank/js-client';
import type { NorthflankConfig } from './config';

export type NorthflankClientConfig = NorthflankConfig & {
  redactValues?: string[];
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

const NorthflankProjectSchema = z.object({ id: z.string(), name: z.string() }).passthrough();
const NorthflankVolumeSchema = z.object({ id: z.string(), name: z.string() }).passthrough();
const NorthflankPortSchema = z
  .object({ name: z.string().optional(), dns: z.string().nullable().optional() })
  .passthrough();
const NorthflankServiceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    servicePaused: z.boolean().optional(),
    ports: z.array(NorthflankPortSchema).optional(),
    deployment: z.object({ instances: z.number().int().optional() }).passthrough().optional(),
    status: z
      .object({
        deployment: z.object({ status: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const NorthflankSecretDetailsSchema = z.object({ id: z.string(), name: z.string() }).passthrough();

const ProjectResponseSchema = z.object({ data: NorthflankProjectSchema });
const VolumeResponseSchema = z.object({ data: NorthflankVolumeSchema });
const VolumeListResponseSchema = z.object({ data: z.array(NorthflankVolumeSchema) });
const ServiceResponseSchema = z.object({ data: NorthflankServiceSchema });
const ServiceListResponseSchema = z.object({
  data: z.object({ services: z.array(NorthflankServiceSchema) }).passthrough(),
});
const SecretDetailsResponseSchema = z.object({ data: NorthflankSecretDetailsSchema });

export type NorthflankProject = z.infer<typeof NorthflankProjectSchema>;
export type NorthflankVolume = z.infer<typeof NorthflankVolumeSchema>;
export type NorthflankService = z.infer<typeof NorthflankServiceSchema>;
export type NorthflankSecretDetails = z.infer<typeof NorthflankSecretDetailsSchema>;

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
  if (value instanceof Error) {
    return redactText(
      JSON.stringify({ name: value.name, message: value.message, stack: value.stack }),
      config
    );
  }
  try {
    return redactText(JSON.stringify(redactUnknown(value)), config);
  } catch {
    return redactText(String(value), config);
  }
}

function rateLimitFromHeaders(headers: Headers): NorthflankRateLimitInfo {
  return {
    limit: headers.get('x-ratelimit-limit'),
    remaining: headers.get('x-ratelimit-remaining'),
    reset: headers.get('x-ratelimit-reset'),
  };
}

function northflankPath(config: NorthflankClientConfig, path: string, teamScoped = true): string {
  const base = config.apiBase.replace(/\/$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (!teamScoped || !config.teamId || normalizedPath.startsWith('/teams/')) {
    return `${base}${normalizedPath}`;
  }
  return `${base}/teams/${encodeURIComponent(config.teamId)}${normalizedPath}`;
}

function pathWithQuery(path: string, params: Record<string, string | number | boolean | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

function loggableNorthflankPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function northflankRequestLogFields(params: {
  context: string;
  method: string;
  url: string;
  teamScoped: boolean;
}): Record<string, unknown> {
  return {
    context: params.context,
    method: params.method,
    path: loggableNorthflankPath(params.url),
    teamScoped: params.teamScoped,
  };
}

async function requestJson<T>(
  config: NorthflankClientConfig,
  path: string,
  init: RequestInit | undefined,
  schema: z.ZodType<T>,
  expectedStatuses: number[],
  context: string,
  options?: { teamScoped?: boolean }
): Promise<T> {
  const method = init?.method ?? 'GET';
  const teamScoped = options?.teamScoped ?? true;
  const url = northflankPath(config, path, teamScoped);
  const startedAt = Date.now();
  const requestLogFields = northflankRequestLogFields({ context, method, url, teamScoped });

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch (err) {
    const body = redactForError(err, config);
    console.warn('[northflank] api_request_error', {
      ...requestLogFields,
      durationMs: Date.now() - startedAt,
      error: body.slice(0, 1024),
    });
    throw new NorthflankApiError(
      `Northflank API ${context} failed before response: ${body}`,
      503,
      body,
      null,
      { limit: null, remaining: null, reset: null }
    );
  }

  const durationMs = Date.now() - startedAt;
  const requestId = response.headers.get('x-request-id');
  const rateLimit = rateLimitFromHeaders(response.headers);

  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }

  if (!expectedStatuses.includes(response.status)) {
    const body = redactForError(json, config);
    console.warn('[northflank] api_request_failed', {
      ...requestLogFields,
      status: response.status,
      durationMs,
      requestId,
      rateLimit,
      body: body.slice(0, 1024),
    });
    throw new NorthflankApiError(
      `Northflank API ${context} failed (${response.status}): ${body}`,
      response.status,
      body,
      requestId,
      rateLimit
    );
  }

  try {
    return schema.parse(json);
  } catch (err) {
    const body = redactForError({ response: json, parseError: err }, config);
    console.warn('[northflank] api_response_parse_failed', {
      ...requestLogFields,
      status: response.status,
      durationMs,
      requestId,
      rateLimit,
      body: body.slice(0, 1024),
    });
    throw new NorthflankApiError(
      `Northflank API ${context} returned an unexpected response: ${body}`,
      502,
      body,
      requestId,
      rateLimit
    );
  }
}

async function requestJsonOrNull<T>(
  config: NorthflankClientConfig,
  path: string,
  schema: z.ZodType<T>,
  context: string,
  options?: { teamScoped?: boolean }
): Promise<T | null> {
  try {
    return await requestJson(config, path, undefined, schema, [200], context, options);
  } catch (err) {
    if (isNorthflankNotFound(err)) return null;
    throw err;
  }
}

async function requestVoid(
  config: NorthflankClientConfig,
  path: string,
  init: RequestInit | undefined,
  expectedStatuses: number[],
  context: string,
  options?: { teamScoped?: boolean }
): Promise<void> {
  await requestJson(config, path, init, z.unknown(), expectedStatuses, context, options);
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

export async function createProject(
  config: NorthflankClientConfig,
  input: { name: string; region: string; description?: string }
): Promise<NorthflankProject> {
  const response = await requestJson(
    config,
    '/projects',
    jsonInit('POST', input),
    ProjectResponseSchema,
    [200, 201],
    'createProject'
  );
  return response.data;
}

export async function findProjectByName(
  config: NorthflankClientConfig,
  name: string
): Promise<NorthflankProject | null> {
  const response = await requestJsonOrNull(
    config,
    `/projects/${encodeURIComponent(name)}`,
    ProjectResponseSchema,
    'findProjectByName'
  );
  return response?.data ?? null;
}

export async function getProject(
  config: NorthflankClientConfig,
  projectId: string
): Promise<NorthflankProject> {
  const response = await requestJson(
    config,
    `/projects/${encodeURIComponent(projectId)}`,
    undefined,
    ProjectResponseSchema,
    [200],
    'getProject'
  );
  return response.data;
}

export async function deleteProject(
  config: NorthflankClientConfig,
  projectId: string,
  deleteChildObjects = false
): Promise<void> {
  await requestVoid(
    config,
    pathWithQuery(`/projects/${encodeURIComponent(projectId)}`, {
      delete_child_objects: deleteChildObjects,
    }),
    { method: 'DELETE' },
    [200, 202, 204],
    'deleteProject'
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
  const response = await requestJson(
    config,
    `/projects/${encodeURIComponent(projectId)}/volumes`,
    jsonInit('POST', {
      name: input.name,
      mounts: [{ containerMountPath: input.mountPath }],
      spec: {
        accessMode: input.accessMode === 'ReadWriteOnce' ? 'ReadWriteOnce' : 'ReadWriteMany',
        storageClassName: input.storageClassName,
        storageSize: input.storageSizeMb,
      },
    }),
    VolumeResponseSchema,
    [200, 201],
    'createVolume'
  );
  return response.data;
}

export async function listVolumes(
  config: NorthflankClientConfig,
  projectId: string
): Promise<NorthflankVolume[]> {
  const response = await requestJson(
    config,
    `/projects/${encodeURIComponent(projectId)}/volumes`,
    undefined,
    VolumeListResponseSchema,
    [200],
    'listVolumes'
  );
  return response.data;
}

export async function findVolumeByName(
  config: NorthflankClientConfig,
  projectId: string,
  name: string
): Promise<NorthflankVolume | null> {
  const response = await requestJsonOrNull(
    config,
    `/projects/${encodeURIComponent(projectId)}/volumes/${encodeURIComponent(name)}`,
    VolumeResponseSchema,
    'findVolumeByName'
  );
  return response?.data ?? null;
}

export async function getVolume(
  config: NorthflankClientConfig,
  projectId: string,
  volumeIdOrName: string
): Promise<NorthflankVolume> {
  const response = await requestJson(
    config,
    `/projects/${encodeURIComponent(projectId)}/volumes/${encodeURIComponent(volumeIdOrName)}`,
    undefined,
    VolumeResponseSchema,
    [200],
    'getVolume'
  );
  return response.data;
}

export async function deleteVolume(
  config: NorthflankClientConfig,
  projectId: string,
  volumeIdOrName: string
): Promise<void> {
  await requestVoid(
    config,
    `/projects/${encodeURIComponent(projectId)}/volumes/${encodeURIComponent(volumeIdOrName)}`,
    { method: 'DELETE' },
    [200, 202, 204],
    'deleteVolume'
  );
}

export async function createDeploymentService(
  config: NorthflankClientConfig,
  projectId: string,
  payload: CreateServiceDeploymentRequest['data']
): Promise<NorthflankService> {
  const response = await requestJson(
    config,
    `/projects/${encodeURIComponent(projectId)}/services/deployment`,
    jsonInit('POST', payload),
    ServiceResponseSchema,
    [200, 201],
    'createDeploymentService'
  );
  return response.data;
}

export async function patchDeploymentService(
  config: NorthflankClientConfig,
  projectId: string,
  serviceId: string,
  payload: PatchServiceDeploymentRequest['data']
): Promise<NorthflankService> {
  const response = await requestJson(
    config,
    `/projects/${encodeURIComponent(projectId)}/services/deployment/${encodeURIComponent(serviceId)}`,
    jsonInit('PATCH', payload),
    ServiceResponseSchema,
    [200],
    'patchDeploymentService'
  );
  return response.data;
}

export async function listServices(
  config: NorthflankClientConfig,
  projectId: string
): Promise<{ services: NorthflankService[]; hasNextPage: boolean }> {
  const response = await requestJson(
    config,
    `/projects/${encodeURIComponent(projectId)}/services`,
    undefined,
    ServiceListResponseSchema,
    [200],
    'listServices'
  );
  return { services: response.data.services, hasNextPage: false };
}

export async function findServiceByName(
  config: NorthflankClientConfig,
  projectId: string,
  name: string
): Promise<NorthflankService | null> {
  const response = await requestJsonOrNull(
    config,
    `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(name)}`,
    ServiceResponseSchema,
    'findServiceByName'
  );
  return response?.data ?? null;
}

export async function getService(
  config: NorthflankClientConfig,
  projectId: string,
  serviceId: string
): Promise<NorthflankService> {
  const response = await requestJson(
    config,
    `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}`,
    undefined,
    ServiceResponseSchema,
    [200],
    'getService'
  );
  return response.data;
}

export async function deleteService(
  config: NorthflankClientConfig,
  projectId: string,
  serviceId: string,
  deleteChildObjects = false
): Promise<void> {
  await requestVoid(
    config,
    pathWithQuery(
      `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}`,
      {
        delete_child_objects: deleteChildObjects,
      }
    ),
    { method: 'DELETE' },
    [200, 202, 204],
    'deleteService'
  );
}

function northflankServiceDebug(service: NorthflankService): Record<string, unknown> {
  return {
    serviceId: service.id,
    serviceName: service.name,
    servicePaused: service.servicePaused ?? null,
    deploymentStatus: service.status?.deployment?.status ?? null,
    deploymentReason: service.status?.deployment?.reason ?? null,
    instances: service.deployment?.instances ?? null,
    ingressHost: service.ports?.find(port => port.dns)?.dns ?? null,
  };
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
    const deploymentStatus = lastService.status?.deployment?.status ?? null;
    if (deploymentStatus === 'COMPLETED') return lastService;
    if (deploymentStatus === 'FAILED') {
      console.warn('[northflank] deployment_wait_failed', {
        description: 'Northflank deployment reported FAILED while waiting for COMPLETED',
        apiOperation: 'GET /projects/{projectId}/services/{serviceId}',
        projectId,
        ...northflankServiceDebug(lastService),
      });
      throw new Error(`Northflank deployment failed for service ${serviceId}`);
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
    lastService = await getService(config, projectId, serviceId);
  }
  console.warn('[northflank] deployment_wait_timeout', {
    description: 'Timed out waiting for Northflank deployment to report COMPLETED',
    apiOperation: 'GET /projects/{projectId}/services/{serviceId}',
    projectId,
    timeoutSeconds,
    ...northflankServiceDebug(lastService),
  });
  throw new Error(`Timed out waiting for Northflank deployment ${serviceId} to complete`);
}

export async function createProjectSecret(
  config: NorthflankClientConfig,
  projectId: string,
  payload: CreateSecretRequest['data']
): Promise<NorthflankSecretDetails> {
  const response = await requestJson(
    config,
    `/projects/${encodeURIComponent(projectId)}/secrets`,
    jsonInit('POST', payload),
    SecretDetailsResponseSchema,
    [200, 201],
    'createProjectSecret',
    { teamScoped: false }
  );
  return response.data;
}

export async function findProjectSecretByName(
  config: NorthflankClientConfig,
  projectId: string,
  name: string
): Promise<NorthflankSecretDetails | null> {
  const response = await requestJsonOrNull(
    config,
    `/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(name)}`,
    SecretDetailsResponseSchema,
    'findProjectSecretByName',
    { teamScoped: false }
  );
  return response?.data ?? null;
}

export async function getProjectSecretDetails(
  config: NorthflankClientConfig,
  projectId: string,
  secretId: string
): Promise<NorthflankSecretDetails> {
  const response = await requestJson(
    config,
    `/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(secretId)}/details`,
    undefined,
    SecretDetailsResponseSchema,
    [200],
    'getProjectSecretDetails',
    { teamScoped: false }
  );
  return response.data;
}

export async function putProjectSecret(
  config: NorthflankClientConfig,
  projectId: string,
  secretId: string,
  payload: CreateSecretRequest['data']
): Promise<NorthflankSecretDetails> {
  const { name: _name, ...patchPayload } = payload satisfies CreateSecretRequest['data'];
  const response = await requestJson(
    config,
    `/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(secretId)}`,
    jsonInit('PATCH', patchPayload satisfies PatchSecretRequest['data']),
    SecretDetailsResponseSchema,
    [200],
    'putProjectSecret',
    { teamScoped: false }
  );
  return response.data;
}

export async function deleteProjectSecret(
  config: NorthflankClientConfig,
  projectId: string,
  secretId: string
): Promise<void> {
  await requestVoid(
    config,
    `/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(secretId)}`,
    { method: 'DELETE' },
    [200, 202, 204],
    'deleteProjectSecret',
    { teamScoped: false }
  );
}

export function isNorthflankNotFound(err: unknown): boolean {
  return err instanceof NorthflankApiError && err.status === 404;
}

export function isNorthflankConflict(err: unknown): boolean {
  return err instanceof NorthflankApiError && err.status === 409;
}
