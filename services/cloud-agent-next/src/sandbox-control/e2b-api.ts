import { z } from 'zod';
import { E2BProviderError, type E2BFailureCode } from '../byoc/e2b-errors.js';
import type { E2BAllocationConfig } from '../sandbox-state/model/allocation.js';
import {
  E2B_INITIAL_LEASE_MS,
  E2B_MAX_LIFETIME_MS,
  e2bCreateMetadata,
  e2bPhysicalIdSchema,
} from './e2b-runtime.js';

export const E2B_API_URL = 'https://api.e2b.app';
export const E2B_SANDBOX_URL = 'https://sandbox.e2b.app';
export const E2B_MANAGEMENT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const tokenSchema = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/)
  .refine(value => value === value.trim());
const sandboxInfoSchema = z.object({
  sandboxID: e2bPhysicalIdSchema,
  templateID: z.string().min(1).max(256),
  metadata: z.record(z.string().max(128), z.string().max(1024)),
  state: z.enum(['running', 'paused']),
  startedAt: z.iso.datetime({ offset: true }),
  endAt: z.iso.datetime({ offset: true }),
  envdVersion: z
    .string()
    .max(32)
    .regex(/^\d+\.\d+\.\d+$/)
    .refine(value => value === value.trim()),
  cpuCount: z.number().int().positive(),
  memoryMB: z.number().int().positive(),
});
const sandboxDetailSchema = sandboxInfoSchema.extend({
  envdAccessToken: tokenSchema.nullish(),
  allowInternetAccess: z.boolean().nullish(),
  network: z.object({ allowPublicTraffic: z.boolean().optional() }).optional(),
  lifecycle: z.object({ onTimeout: z.enum(['kill', 'pause']), autoResume: z.boolean() }).optional(),
});
const createdSandboxSchema = z.object({
  sandboxID: e2bPhysicalIdSchema,
  templateID: z.string().min(1).max(256),
});

export type E2BSandboxInfo = z.infer<typeof sandboxInfoSchema>;
export type E2BSandboxDetail = z.infer<typeof sandboxDetailSchema>;

export class E2BApiError extends E2BProviderError {
  constructor(
    code: E2BFailureCode,
    readonly status?: number
  ) {
    super(code);
  }
}

export function validateE2BApiKey(apiKey: string): void {
  if (!tokenSchema.safeParse(apiKey).success) {
    throw new E2BProviderError('byoc_e2b_credential_invalid');
  }
}

export async function readE2BResponseText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  if (!response.body) throw new E2BProviderError('byoc_e2b_unavailable');
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  try {
    signal.throwIfAborted();
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > maxBytes) {
      throw new E2BProviderError('byoc_e2b_unavailable');
    }
    for (;;) {
      const result = await reader.read();
      signal.throwIfAborted();
      if (result.done) break;
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array)) throw new E2BProviderError('byoc_e2b_unavailable');
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new E2BProviderError('byoc_e2b_unavailable');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    await reader.cancel().catch(() => {});
    throw new E2BProviderError('byoc_e2b_unavailable');
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

function failureCode(status: number, creating: boolean): E2BFailureCode {
  if (status === 401 || status === 403) return 'byoc_e2b_credential_invalid';
  if (status === 429) return 'byoc_e2b_capacity';
  if (creating && (status === 400 || status === 404)) return 'byoc_e2b_template_unavailable';
  return 'byoc_e2b_unavailable';
}

async function request<T>(input: {
  apiKey: string;
  path: string;
  method: 'GET' | 'POST' | 'DELETE';
  status: 200 | 201 | 204;
  schema: z.ZodType<T>;
  body?: object;
  deadlineAt?: number;
}): Promise<{ data: T; nextToken?: string }> {
  try {
    validateE2BApiKey(input.apiKey);
    const deadlineAt = Math.min(
      Date.now() + E2B_MANAGEMENT_TIMEOUT_MS,
      input.deadlineAt ?? Infinity
    );
    if (deadlineAt <= Date.now()) throw new E2BApiError('byoc_e2b_unavailable');
    const signal = AbortSignal.timeout(deadlineAt - Date.now());
    const response = await fetch(
      new Request(`${E2B_API_URL}${input.path}`, {
        method: input.method,
        headers: {
          'X-API-Key': input.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        cache: 'no-store',
        redirect: 'manual',
        signal,
      })
    );
    if (response.status !== input.status || response.redirected) {
      await response.body?.cancel().catch(() => {});
      throw new E2BApiError(failureCode(response.status, input.status === 201), response.status);
    }
    let body: unknown;
    if (input.status === 204) {
      await response.body?.cancel().catch(() => {});
      body = undefined;
    } else {
      body = JSON.parse(await readE2BResponseText(response, MAX_RESPONSE_BYTES, signal));
    }
    if (Date.now() >= deadlineAt) throw new E2BApiError('byoc_e2b_unavailable');
    const parsed = input.schema.safeParse(body);
    if (!parsed.success || JSON.stringify(parsed.data)?.includes(input.apiKey)) {
      throw new E2BApiError('byoc_e2b_unavailable');
    }
    const nextToken = response.headers.get('X-Next-Token');
    if (
      nextToken &&
      (nextToken.length > 2048 ||
        !tokenSchema.safeParse(nextToken).success ||
        nextToken.includes(input.apiKey))
    ) {
      throw new E2BApiError('byoc_e2b_unavailable');
    }
    return { data: parsed.data, ...(nextToken ? { nextToken } : {}) };
  } catch (error) {
    if (error instanceof E2BApiError) throw error;
    if (error instanceof E2BProviderError) throw new E2BApiError(error.code);
    throw new E2BApiError('byoc_e2b_unavailable');
  }
}

function sandboxPath(physicalId: string): string {
  if (!e2bPhysicalIdSchema.safeParse(physicalId).success) {
    throw new E2BProviderError('byoc_e2b_policy_mismatch');
  }
  return `/sandboxes/${physicalId}`;
}

export async function createE2BSandbox(
  apiKey: string,
  config: E2BAllocationConfig,
  intentId: string
) {
  if (config.submissionState !== 'submitted') {
    throw new E2BProviderError('byoc_e2b_policy_mismatch');
  }
  return (
    await request({
      apiKey,
      path: '/sandboxes',
      method: 'POST',
      status: 201,
      schema: createdSandboxSchema,
      deadlineAt: config.createDeadlineAt,
      body: {
        templateID: config.templateReference,
        timeout: E2B_INITIAL_LEASE_MS / 1000,
        autoPause: false,
        autoResume: { enabled: false },
        secure: true,
        allow_internet_access: true,
        network: { allowPublicTraffic: false },
        metadata: e2bCreateMetadata(config, intentId),
      },
    })
  ).data;
}

export async function getE2BSandbox(
  apiKey: string,
  physicalId: string,
  deadlineAt?: number
): Promise<E2BSandboxDetail | null> {
  const path = sandboxPath(physicalId);
  try {
    return (
      await request({
        apiKey,
        path,
        method: 'GET',
        status: 200,
        schema: sandboxDetailSchema,
        deadlineAt,
      })
    ).data;
  } catch (error) {
    if (error instanceof E2BApiError && error.status === 404) return null;
    throw error;
  }
}

export async function listE2BSandboxes(
  apiKey: string,
  config: E2BAllocationConfig,
  intentId: string,
  options: { nextToken?: string; limit: number; deadlineAt: number }
): Promise<{ items: E2BSandboxInfo[]; nextToken?: string }> {
  const query = new URLSearchParams({
    metadata: new URLSearchParams(e2bCreateMetadata(config, intentId)).toString(),
    state: 'running,paused',
    template: config.templateId,
    limit: String(options.limit),
  });
  if (options.nextToken) query.set('nextToken', options.nextToken);
  const result = await request({
    apiKey,
    path: `/v2/sandboxes?${query.toString()}`,
    method: 'GET',
    status: 200,
    schema: z.array(sandboxInfoSchema).max(options.limit),
    deadlineAt: options.deadlineAt,
  });
  return { items: result.data, ...(result.nextToken ? { nextToken: result.nextToken } : {}) };
}

export async function setE2BSandboxTimeout(
  apiKey: string,
  physicalId: string,
  timeoutSeconds: number
): Promise<void> {
  if (
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds <= 0 ||
    timeoutSeconds > E2B_MAX_LIFETIME_MS / 1000
  ) {
    throw new E2BProviderError('byoc_e2b_lifetime_exceeded');
  }
  await request({
    apiKey,
    path: `${sandboxPath(physicalId)}/timeout`,
    method: 'POST',
    status: 204,
    schema: z.undefined(),
    body: { timeout: timeoutSeconds },
  });
}

export async function killE2BSandbox(apiKey: string, physicalId: string): Promise<void> {
  const path = sandboxPath(physicalId);
  try {
    await request({ apiKey, path, method: 'DELETE', status: 204, schema: z.undefined() });
  } catch (error) {
    if (error instanceof E2BApiError && error.status === 404) return;
    throw error;
  }
}
