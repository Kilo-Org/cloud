import type { Context } from 'hono';
import type { HonoContext } from '../hono-context.js';
import { resolveSecret } from '../auth.js';
import {
  controlLogIdentitySchema,
  type ControlLogIdentity,
  type SandboxTransferScope,
} from '../shared/control-diagnostics.js';
import {
  validateControlLogUploadGrant,
  validateSandboxTransferGrant,
} from './sandbox-transfer-grant.js';

export type SandboxTransferAuthorization = {
  identity: ControlLogIdentity;
  scopes: readonly SandboxTransferScope[];
};

export function mediaType(header: string | null | undefined): string | undefined {
  return header?.split(';')[0].trim();
}

export async function readBoundedBytes(
  request: Request,
  maxBytes: number
): Promise<Uint8Array | undefined> {
  const stream: ReadableStream<Uint8Array> | null = request.body;
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) return undefined;
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function declaredLength(header: string | null | undefined): number | undefined | 'invalid' {
  if (header === undefined || header === null) return undefined;
  if (!/^\d+$/.test(header)) return 'invalid';
  return Number(header);
}

function routeIdentity(c: Context<HonoContext>) {
  return controlLogIdentitySchema.safeParse({
    sandboxId: c.req.param('sandboxId'),
    allocationId: c.req.param('allocationId'),
    wrapperInstanceId: c.req.param('wrapperInstanceId'),
  });
}

function matchesIdentity(grant: ControlLogIdentity, identity: ControlLogIdentity): boolean {
  return (
    grant.sandboxId === identity.sandboxId &&
    grant.allocationId === identity.allocationId &&
    grant.wrapperInstanceId === identity.wrapperInstanceId
  );
}

/**
 * Validates the transfer grant against the route identity and the scope the
 * route serves. Legacy log grants are accepted only where a caller opts in.
 */
export async function authorizeTransfer(
  c: Context<HonoContext>,
  scope: SandboxTransferScope,
  options: { allowLegacyControlLogGrant?: boolean } = {}
): Promise<SandboxTransferAuthorization | Response> {
  const identity = routeIdentity(c);
  if (!identity.success) return c.text('Invalid transfer identity', 400);
  const authorization = c.req.header('Authorization') ?? null;
  const secret = await resolveSecret(c.env.NEXTAUTH_SECRET);
  const grant = validateSandboxTransferGrant(authorization, secret);
  if (grant) {
    if (!matchesIdentity(grant.identity, identity.data)) {
      return c.text('Transfer identity mismatch', 403);
    }
    if (!grant.scopes.includes(scope)) return c.text('Transfer scope mismatch', 403);
    return { identity: identity.data, scopes: grant.scopes };
  }
  if (scope === 'logs' && options.allowLegacyControlLogGrant) {
    const legacy = validateControlLogUploadGrant(authorization, secret);
    if (!legacy) return c.text('Unauthorized', 401);
    if (!matchesIdentity(legacy, identity.data)) return c.text('Transfer identity mismatch', 403);
    return { identity: identity.data, scopes: ['logs'] };
  }
  return c.text('Unauthorized', 401);
}

export type StreamToBucketOptions = {
  maxBytes: number;
  sha256: string;
  contentType: string;
  customMetadata?: Record<string, string>;
};

export type StreamToBucketResult =
  | { status: 'stored'; object: R2Object }
  | { status: 'missing_length' }
  | { status: 'invalid_length' }
  | { status: 'too_large' }
  | { status: 'missing_body' }
  | { status: 'hash_mismatch' }
  | { status: 'storage_unavailable' };

/**
 * Streams a request body into R2 without buffering. R2 verifies the declared
 * SHA-256, so a body that does not match the header is rejected by storage.
 */
export async function streamToBucket(
  bucket: R2Bucket,
  key: string,
  request: Request,
  options: StreamToBucketOptions
): Promise<StreamToBucketResult> {
  const length = declaredLength(request.headers.get('Content-Length'));
  if (length === undefined) return { status: 'missing_length' };
  if (length === 'invalid') return { status: 'invalid_length' };
  if (length > options.maxBytes) return { status: 'too_large' };
  if (request.body === null) return { status: 'missing_body' };
  try {
    const object = await bucket.put(key, request.body, {
      sha256: options.sha256,
      httpMetadata: { contentType: options.contentType },
      onlyIf: { etagDoesNotMatch: '*' },
      ...(options.customMetadata === undefined ? {} : { customMetadata: options.customMetadata }),
    });
    return object === null ? { status: 'storage_unavailable' } : { status: 'stored', object };
  } catch (error) {
    if (error instanceof Error && /sha-?256|checksum/i.test(error.message)) {
      return { status: 'hash_mismatch' };
    }
    return { status: 'storage_unavailable' };
  }
}
