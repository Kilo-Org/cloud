import { Hono } from 'hono';
import {
  ON_PREM_CREDENTIAL_MAX_BODY_BYTES,
  onPremCredentialResolutionSchema,
  onPremCredentialResolveRequestSchema,
  type OnPremCredentialResolution,
  type OnPremCredentialRpcInput,
} from '../shared/onprem-credential-protocol.js';
import { decodeOnPremProviderRef, onPremProviderBindingSchema } from '../shared/onprem-protocol.js';
import { isValidSandboxId } from '../sandbox-id.js';
import { parseBearerCredential } from '../sandbox-control/credential.js';
import type { Env } from '../types.js';
import { projectOnPremError, withOnPremInstallation } from './client.js';

type CredentialRouteEnv = Pick<Env, 'ONPREM_INSTALLATION' | 'SANDBOX_CONTROL'>;

async function readCredentialRequest(request: Request): Promise<unknown> {
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      'application/json' ||
    !request.body
  ) {
    throw new Error('onprem_invalid_request');
  }
  const reader: ReadableStreamDefaultReader<unknown> = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let text = '';
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('onprem_invalid_request');
      size += value.byteLength;
      if (size > ON_PREM_CREDENTIAL_MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('onprem_body_too_large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof Error && error.message === 'onprem_body_too_large') throw error;
    throw new Error('onprem_invalid_request');
  } finally {
    reader.releaseLock();
  }
}

export function createOnPremCredentialRoutes(
  resolveCredential: (
    env: CredentialRouteEnv,
    sandboxId: string,
    input: OnPremCredentialRpcInput
  ) => Promise<OnPremCredentialResolution | null>
) {
  const routes = new Hono<{ Bindings: CredentialRouteEnv }>();
  const path =
    '/onprem/organizations/:organizationId/installations/:installationId/credentials/resolve';

  routes.use(path, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  routes.post(path, async c => {
    const organizationId = onPremProviderBindingSchema.shape.organizationId.safeParse(
      c.req.param('organizationId')
    );
    const installationId = onPremProviderBindingSchema.shape.installationId.safeParse(
      c.req.param('installationId')
    );
    if (!organizationId.success || !installationId.success) {
      return c.json({ error: 'onprem_invalid_request' }, 400);
    }
    const credential = parseBearerCredential(c.req.header('Authorization') ?? null);
    if (!credential || !/^[A-Za-z0-9_-]{32,256}$/.test(credential)) {
      return c.json({ error: 'onprem_unauthorized' }, 401);
    }
    const parsed = onPremCredentialResolveRequestSchema.safeParse(
      await readCredentialRequest(c.req.raw)
    );
    if (!parsed.success) return c.json({ error: 'onprem_invalid_request' }, 400);
    const input = parsed.data;
    const ref = decodeOnPremProviderRef(input.providerRef);
    if (!ref || ref.installationId !== installationId.data) {
      return c.json({ error: 'onprem_unauthorized' }, 401);
    }
    const authorize = () =>
      withOnPremInstallation(
        c.env,
        organizationId.data,
        stub =>
          stub.authorizeAllocation({
            installationId: installationId.data,
            credential,
            providerRef: input.providerRef,
            podUid: input.podUid,
          }),
        'authorizeOnPremCredential'
      );
    const allocation = await authorize();
    const binding = onPremProviderBindingSchema.safeParse(allocation.binding);
    if (
      !binding.success ||
      binding.data.organizationId !== organizationId.data ||
      binding.data.installationId !== installationId.data ||
      allocation.allocationId !== ref.allocationId ||
      !isValidSandboxId(allocation.sandboxId) ||
      allocation.sandboxId.startsWith('dind-')
    ) {
      return c.json({ error: 'onprem_unauthorized' }, 401);
    }
    const result = await resolveCredential(c.env, allocation.sandboxId, {
      binding: binding.data,
      ...input,
    });
    if (!result) return c.json({ error: 'onprem_credential_denied' }, 403);
    const resolved = onPremCredentialResolutionSchema.safeParse(result);
    if (!resolved.success || resolved.data.expiresAt <= Date.now()) {
      return c.json({ error: 'onprem_credential_denied' }, 403);
    }
    const current = await authorize();
    if (
      current.sandboxId !== allocation.sandboxId ||
      current.allocationId !== allocation.allocationId ||
      current.binding.organizationId !== binding.data.organizationId ||
      current.binding.installationId !== binding.data.installationId ||
      current.binding.profileId !== binding.data.profileId ||
      resolved.data.expiresAt <= Date.now()
    ) {
      return c.json({ error: 'onprem_unauthorized' }, 401);
    }
    return c.json(resolved.data);
  });

  routes.onError((error, c) => {
    if (error.message === 'onprem_body_too_large') {
      return c.json({ error: 'onprem_body_too_large' }, 413);
    }
    const { code, status } = projectOnPremError(error);
    return c.json({ error: code }, status);
  });
  return routes;
}
