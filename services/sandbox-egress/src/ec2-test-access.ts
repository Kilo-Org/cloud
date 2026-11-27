import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';

const clientIdHeader = 'cf-access-client-id';
const clientSecretHeader = 'cf-access-client-secret';
const assertionHeader = 'cf-access-jwt-assertion';
const segment = '[A-Za-z0-9_-]+';
const buildPath = `/environment-build/${segment}/${segment}`;
const hostPath = `(?:/aws-egress/${segment}|${buildPath}/aws-egress)`;
const transferPath = `/sandbox-transfer/${segment}/${segment}/${segment}`;
const logObject = `(?:${segment}|files\\.tar\\.gz)`;
const runtimeProxyPath =
  /^\/api\/runtime-credential-proxy\/(?:backend|provider|ingest|unified)\/.+$/;

const hostRoutes = [
  ['POST', new RegExp(`^${hostPath}/(?:policy|audit|scm)$`)],
  ['GET', new RegExp(`^${hostPath}/scm$`)],
] as const;
const workloadRoutes = [
  ['GET', new RegExp(`^/sandbox-control/${segment}$`)],
  ['GET', new RegExp(`^/sandbox-preview-tunnel/${segment}$`)],
  ['GET', new RegExp(`^/sandbox-terminal/${segment}/${segment}/${segment}$`)],
  ['POST', new RegExp(`^/sandbox-control/${segment}/startup-failure$`)],
  ['GET', /^\/sandbox-artifacts\/v1\/objects\/[a-f0-9]{64}$/],
  ['PUT', new RegExp(`^${transferPath}/(?:artifacts/objects|logs/${logObject})$`)],
  ['PUT', new RegExp(`^/sandbox-logs/${segment}/${segment}/${segment}/${logObject}$`)],
  ['DELETE', new RegExp(`^${transferPath}/artifacts/objects$`)],
  ['GET', new RegExp(`^${buildPath}/input$`)],
  ['POST', new RegExp(`^${buildPath}/(?:startup-failure|events|result|retire-scm)$`)],
  ['GET', runtimeProxyPath],
  ['POST', runtimeProxyPath],
  ['PUT', runtimeProxyPath],
  ['GET', /^\/api\/(?:user|profile(?:\/balance)?|defaults|users\/notifications)$/],
  ['GET', /^\/api\/organizations\/[A-Za-z0-9._-]+\/(?:models|defaults|modes)$/],
  ['POST', /^\/api\/organizations\/[A-Za-z0-9._-]+\/models\/validate$/],
  ['GET', /^\/api\/(?:openrouter|gateway)(?:\/(?:api\/)?organizations\/[A-Za-z0-9._-]+)?\/models$/],
  [
    'POST',
    /^\/api\/(?:openrouter|gateway)\/(?:models\/validate|chat\/completions|messages|responses|embeddings)$/,
  ],
  ['POST', /^\/api\/gateway\/v1\/(?:chat\/completions|responses)$/],
  ['GET', /^\/api\/session\/[A-Za-z0-9_-]+\/export$/],
  ['POST', /^\/api\/session(?:\/[A-Za-z0-9_-]+\/(?:ingest|title))?$/],
] as const;

const configSchema = z
  .object({
    origin: z.url(),
    clientId: z.string().regex(/^[A-Za-z0-9_-]+\.access$/),
    clientSecret: z.string().regex(/^[A-Za-z0-9_]+$/),
  })
  .strict();

export function createEc2TestAccess(config: unknown, launchOrigin: string) {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) throw new Error('Invalid EC2 test Access configuration');
  const { origin, clientId, clientSecret } = parsed.data;
  const target = new URL(origin);
  if (
    target.protocol !== 'https:' ||
    target.port ||
    target.origin !== origin ||
    origin !== launchOrigin
  )
    throw new Error('EC2 test Access origin mismatch');

  function authorize(
    url: URL,
    method: string,
    headers: Headers,
    routes: ReadonlyArray<readonly [string, RegExp]>
  ) {
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      !routes.some(([verb, path]) => verb === method && path.test(url.pathname))
    )
      return false;
    headers.delete(assertionHeader);
    headers.delete('cookie');
    headers.set(clientIdHeader, clientId);
    headers.set(clientSecretHeader, clientSecret);
    return true;
  }

  return {
    hostname: target.hostname,
    async fetchHost(request: Request, send: (request: Request) => Promise<Response>) {
      if (!authorize(new URL(request.url), request.method, request.headers, hostRoutes))
        throw new Error('EC2 test Access host request denied');
      return stripTestAccessResponse(await send(new Request(request, { redirect: 'manual' })));
    },
    authorizeWorkload(url: URL, method: string, headers: Headers) {
      return authorize(url, method, headers, workloadRoutes);
    },
  };
}

export type Ec2TestAccess = ReturnType<typeof createEc2TestAccess>;

export function stripTestAccessHeaders(headers: Headers) {
  headers.delete(clientIdHeader);
  headers.delete(clientSecretHeader);
  headers.delete(assertionHeader);
  headers.delete('set-cookie');
}

export function stripTestAccessResponse(response: Response) {
  const headers = new Headers(response.headers);
  stripTestAccessHeaders(headers);
  return new Response(response.body, { status: response.status, headers });
}

export async function loadEc2TestAccess(path: string, launchOrigin: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Error('Cannot open EC2 test Access credentials');
  });
  if (!file) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600 || stat.size > 4096)
      throw new Error('Invalid EC2 test Access credential file');
    return createEc2TestAccess(JSON.parse(await file.readFile('utf8')), launchOrigin);
  } catch {
    throw new Error('Invalid EC2 test Access credentials');
  } finally {
    await file.close();
  }
}
