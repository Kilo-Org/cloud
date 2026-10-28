import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { KmsRequestError, type KmsApi } from './kms';

const KMS_KEY_VERSION = '1';

const contextSchema = z.object({
  key_id: z.string().min(1),
  owner_type: z.enum(['user', 'organization']),
  owner_id: z.string().min(1),
  provider_id: z.string().min(1),
});

const createDataKeyRequestSchema = contextSchema.extend({
  actor_user_id: z.string().min(1).optional(),
});

const getDataKeyRequestSchema = contextSchema.extend({
  wrapped_dek: z.string().min(1),
  kms_key_id: z.string().min(1),
  kms_key_version: z.string().min(1),
});

type Context = z.infer<typeof contextSchema>;

export type LogEvent = {
  operation: 'create' | 'get';
  status: number;
  identifiers_verified: boolean;
  key_id?: string;
  user_id?: string;
  organization_id?: string;
  actor_user_id?: string;
  owner_type?: string;
  owner_id?: string;
  provider_id?: string;
};

export type HandlerDeps = {
  kms: KmsApi;
  kmsKeyId: string;
  serviceToken: string;
  log: (event: LogEvent) => void;
};

export type HandlerRequest = {
  method: string;
  path: string;
  authorization: string | undefined;
  query: Record<string, string>;
  body: unknown;
};

export type HandlerResult = { status: number; body: unknown };

const fail = (status: number, error: string): HandlerResult => ({ status, body: { error } });

function isAuthorized(authorization: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(authorization ?? '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function kmsContext(context: Context) {
  return {
    key_id: context.key_id,
    owner_type: context.owner_type,
    owner_id: context.owner_id,
    provider_id: context.provider_id,
  };
}

function ownerIdentifiers(context: Context) {
  return {
    key_id: context.key_id,
    owner_type: context.owner_type,
    owner_id: context.owner_id,
    provider_id: context.provider_id,
    ...(context.owner_type === 'organization'
      ? { organization_id: context.owner_id }
      : { user_id: context.owner_id }),
  };
}

async function createDataKey(
  deps: HandlerDeps,
  request: z.infer<typeof createDataKeyRequestSchema>
): Promise<HandlerResult> {
  const dataKey = await deps.kms.generateDataKey({
    keyId: deps.kmsKeyId,
    context: kmsContext(request),
  });
  try {
    return {
      status: 200,
      body: {
        data_key: dataKey.plaintext.toString('base64'),
        wrapped_dek: dataKey.ciphertextBlob,
        kms_key_id: dataKey.keyId,
        kms_key_version: KMS_KEY_VERSION,
      },
    };
  } finally {
    dataKey.plaintext.fill(0);
  }
}

async function getDataKey(
  deps: HandlerDeps,
  request: z.infer<typeof getDataKeyRequestSchema>
): Promise<HandlerResult> {
  const dataKey = await deps.kms.decrypt({
    ciphertextBlob: request.wrapped_dek,
    keyId: request.kms_key_id,
    context: kmsContext(request),
  });
  try {
    return { status: 200, body: { data_key: dataKey.toString('base64') } };
  } finally {
    dataKey.fill(0);
  }
}

function failureStatus(error: unknown): number {
  return error instanceof KmsRequestError && error.status >= 400 && error.status < 500 ? 403 : 502;
}

async function createDataKeyRoute(deps: HandlerDeps, input: unknown): Promise<HandlerResult> {
  const parsed = createDataKeyRequestSchema.safeParse(input);
  if (!parsed.success) {
    deps.log({ operation: 'create', status: 400, identifiers_verified: false });
    return fail(400, 'invalid request');
  }

  const event = {
    operation: 'create',
    identifiers_verified: false,
    ...ownerIdentifiers(parsed.data),
    actor_user_id: parsed.data.actor_user_id,
  } as const;
  try {
    const result = await createDataKey(deps, parsed.data);
    deps.log({ ...event, status: result.status });
    return result;
  } catch (error) {
    const status = failureStatus(error);
    deps.log({ ...event, status });
    return fail(status, 'kms request failed');
  }
}

async function getDataKeyRoute(deps: HandlerDeps, input: unknown): Promise<HandlerResult> {
  const parsed = getDataKeyRequestSchema.safeParse(input);
  if (!parsed.success) {
    deps.log({ operation: 'get', status: 400, identifiers_verified: false });
    return fail(400, 'invalid request');
  }

  const event = { operation: 'get', ...ownerIdentifiers(parsed.data) } as const;
  try {
    const result = await getDataKey(deps, parsed.data);
    deps.log({ ...event, status: result.status, identifiers_verified: true });
    return result;
  } catch (error) {
    const status = failureStatus(error);
    deps.log({ ...event, status, identifiers_verified: false });
    return fail(status, 'kms request failed');
  }
}

export async function handleRequest(
  deps: HandlerDeps,
  request: HandlerRequest
): Promise<HandlerResult> {
  if (request.path !== '/data-key') return fail(404, 'not found');
  if (request.method !== 'POST' && request.method !== 'GET') {
    return fail(405, 'method not allowed');
  }
  if (!isAuthorized(request.authorization, deps.serviceToken)) return fail(401, 'unauthorized');

  return request.method === 'POST'
    ? createDataKeyRoute(deps, request.body)
    : getDataKeyRoute(deps, request.query);
}
