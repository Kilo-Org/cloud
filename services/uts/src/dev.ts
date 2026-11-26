import { withDORetry } from '@kilocode/worker-utils';
import { z } from 'zod';
import { getSignerStub } from './dos/stubs';
import type { SignResult } from './dos/UtsSignerDO';
import { readConfig, type Env } from './env';
import { handleRequest } from './http';
import { signerForGrant } from './keys/signer-choice';
import { jsonResponse } from './responses';

/**
 * Signs a caller-supplied claim set, for the local end-to-end check of the signer and the key set.
 * Only `src/dev-index.ts` routes here, and only `wrangler.dev.jsonc` uses that entry: its build
 * command fails every Wrangler command but `dev`, so no deploy or version upload can bundle it,
 * and `test/repo` fails any other config that runs it. The route also answers 404 unless
 * `UTS_ENVIRONMENT` is `development`, and a token signed here names the development issuer, which
 * no staging or production verifier accepts.
 */
export const DEV_SIGN_PATH = '/__dev/sign';

const DevSignRequestSchema = z.strictObject({
  grantId: z.string().min(1),
  claims: z.unknown(),
});

export async function handleDevRequest(request: Request, env: Env): Promise<Response> {
  const config = readConfig(env);
  if (new URL(request.url).pathname !== DEV_SIGN_PATH || config.environment !== 'development') {
    return await handleRequest(request, env);
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  }
  const body = DevSignRequestSchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success) return jsonResponse({ error: 'invalid_request' }, 400);
  const signer = await signerForGrant(body.data.grantId);
  const result = await withDORetry(
    () => getSignerStub(env, config, signer),
    async (stub): Promise<SignResult> => await stub.sign(body.data.claims),
    'uts.dev.sign'
  );
  if (result.status === 'refused') return jsonResponse({ error: result.reason }, 400);
  if (result.status === 'misconfigured') return jsonResponse({ error: 'server_error' }, 500);
  return jsonResponse({ signer, kid: result.kid, token: result.token }, 200);
}
