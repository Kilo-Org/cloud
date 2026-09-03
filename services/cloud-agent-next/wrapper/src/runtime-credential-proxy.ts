import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export type RuntimeCredentialProxyTargets = {
  backendBaseUrl: string;
  providerBaseUrl: string;
  sessionIngestBaseUrl: string;
};

const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const targetSchema = z
  .string()
  .max(2048)
  .transform(value => new URL(value))
  .refine(
    url => ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash
  );

const configSchema = z
  .object({
    authorizationId: z.string().min(1).max(256),
    authorizationFingerprint: z.string().min(1).max(512),
    alias: z
      .string()
      .min(32)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/),
    credential: z.string().min(1).max(8192),
    targets: z.object({
      backendBaseUrl: targetSchema,
      providerBaseUrl: targetSchema,
      sessionIngestBaseUrl: targetSchema,
    }),
    authorizedSessionIds: z.array(sessionIdSchema).min(1).max(128),
    organizationId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
      .optional(),
    fence: z.string().min(1).max(512),
  })
  .strict();

export type RuntimeCredentialProxyConfig = Omit<z.input<typeof configSchema>, 'targets'> & {
  targets: RuntimeCredentialProxyTargets;
};

export type RuntimeCredentialProxy = {
  readonly backendBaseUrl: string;
  readonly providerBaseUrl: string;
  readonly sessionIngestBaseUrl: string;
  update(input: {
    credential: string;
    authorizationId: string;
    authorizationFingerprint: string;
    fence: string;
    scope?: string;
  }): boolean;
  addSession(input: {
    kiloSessionId: string;
    authorizationId: string;
    authorizationFingerprint: string;
    fence: string;
  }): boolean;
  stop(): Promise<void>;
};

export function parseRuntimeCredentialProxyConfig(
  value: string | undefined
): RuntimeCredentialProxyConfig | null {
  if (!value || value.length > 32_768) return null;
  try {
    const parsed = configSchema.safeParse(JSON.parse(value) as unknown);
    if (!parsed.success) return null;
    return {
      ...parsed.data,
      targets: {
        backendBaseUrl: parsed.data.targets.backendBaseUrl.toString(),
        providerBaseUrl: parsed.data.targets.providerBaseUrl.toString(),
        sessionIngestBaseUrl: parsed.data.targets.sessionIngestBaseUrl.toString(),
      },
      authorizedSessionIds: [...new Set(parsed.data.authorizedSessionIds)],
    };
  } catch {
    return null;
  }
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function decodedPath(pathname: string): string | null {
  try {
    const decoded = decodeURIComponent(pathname);
    return decoded.includes('..') || decoded.includes('\\') ? null : decoded;
  } catch {
    return null;
  }
}

function join(base: URL, pathname: string, search: string): URL {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`;
  url.search = search;
  return url;
}

function providerPath(pathname: string, provider: URL): string | null {
  const prefix = provider.pathname.replace(/\/+$/, '');
  if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`)))
    pathname = pathname.slice(prefix.length) || '/';
  return [
    '/models',
    '/models/validate',
    '/chat/completions',
    '/messages',
    '/responses',
    '/embeddings',
  ].includes(pathname)
    ? pathname
    : null;
}

function backendAllowed(method: string, path: string, organizationId: string | undefined): boolean {
  if (method !== 'GET') return false;
  if (['/api/user', '/api/profile', '/api/profile/balance', '/api/defaults'].includes(path))
    return true;
  const match = /^\/api\/organizations\/([A-Za-z0-9._-]+)\/(models|defaults|modes)$/.exec(path);
  return match !== null && organizationId !== undefined && match[1] === organizationId;
}

async function sessionAllowed(
  request: Request,
  path: string,
  sessions: ReadonlySet<string>,
  authorizeSession: ((id: string) => Promise<boolean>) | undefined
): Promise<boolean> {
  const allowedId = async (id: string): Promise<boolean> =>
    sessions.has(id) ||
    (authorizeSession !== undefined &&
      sessionIdSchema.safeParse(id).success &&
      (await authorizeSession(id)));
  if (request.method === 'POST' && path === '/api/session') {
    if ((request.headers.get('content-type') ?? '').split(';')[0] !== 'application/json')
      return false;
    const length = Number(request.headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length < 2 || length > 8192) return false;
    try {
      const body = z
        .object({ sessionId: sessionIdSchema })
        .strict()
        .safeParse(await request.clone().json());
      return body.success && allowedId(body.data.sessionId);
    } catch {
      return false;
    }
  }
  const match = /^\/api\/session\/([A-Za-z0-9_-]+)\/(export|ingest|title)$/.exec(path);
  if (!match || !(await allowedId(match[1]))) return false;
  return (
    (match[2] === 'export' && request.method === 'GET') ||
    (match[2] !== 'export' && request.method === 'POST')
  );
}

export function createRuntimeCredentialProxy(
  input: RuntimeCredentialProxyConfig,
  options: { authorizeSession?: (id: string) => Promise<boolean> } = {}
): RuntimeCredentialProxy {
  const parsed = configSchema.parse(input);
  const config = { ...parsed, targets: { ...parsed.targets } };
  let credential = config.credential;
  const sessions = new Set(config.authorizedSessionIds);
  const serve = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const requestUrl = new URL(request.url);
      const segments = requestUrl.pathname.split('/');
      const target = segments[1];
      const path = decodedPath(`/${segments.slice(2).join('/')}`);
      if (!path || request.headers.get('upgrade'))
        return new Response('Not found', { status: 404 });
      if (!equal(request.headers.get('authorization') ?? '', `Bearer ${config.alias}`)) {
        return new Response('Unauthorized', { status: 401 });
      }
      let upstream: URL | null = null;
      if (target === 'backend' && backendAllowed(request.method, path, config.organizationId))
        upstream = join(config.targets.backendBaseUrl, path, requestUrl.search);
      if (target === 'provider') {
        const providerPathname = providerPath(path, config.targets.providerBaseUrl);
        if (
          providerPathname &&
          ((request.method === 'GET' &&
            ['/models', '/models/validate'].includes(providerPathname)) ||
            (request.method === 'POST' &&
              !['/models', '/models/validate'].includes(providerPathname)))
        ) {
          upstream = join(config.targets.providerBaseUrl, providerPathname, requestUrl.search);
        }
        const organizationModels = /^\/api\/organizations\/([A-Za-z0-9._-]+)\/models$/.exec(path);
        if (request.method === 'GET' && organizationModels?.[1] === config.organizationId) {
          upstream = join(config.targets.backendBaseUrl, path, requestUrl.search);
        }
      }
      if (
        target === 'ingest' &&
        (await sessionAllowed(request, path, sessions, options.authorizeSession))
      ) {
        upstream = join(config.targets.sessionIngestBaseUrl, path, requestUrl.search);
      }
      if (!upstream) return new Response('Not found', { status: 404 });
      const headers = new Headers(request.headers);
      headers.delete('cookie');
      headers.delete('host');
      headers.delete('x-kilocode-organizationid');
      headers.set('authorization', `Bearer ${credential}`);
      if (config.organizationId) headers.set('x-kilocode-organizationid', config.organizationId);
      try {
        return await fetch(upstream, {
          method: request.method,
          headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
          redirect: 'manual',
          duplex: 'half',
        } as RequestInit);
      } catch {
        return new Response('Upstream unavailable', { status: 502 });
      }
    },
  });
  const origin = `http://127.0.0.1:${serve.port}`;
  return {
    backendBaseUrl: `${origin}/backend`,
    providerBaseUrl: `${origin}/provider`,
    sessionIngestBaseUrl: `${origin}/ingest`,
    update(value) {
      if (
        value.credential.length === 0 ||
        value.credential.length > 8192 ||
        !equal(value.authorizationId, config.authorizationId) ||
        !equal(value.authorizationFingerprint, config.authorizationFingerprint) ||
        !equal(value.fence, config.fence) ||
        (value.scope !== undefined && !sessions.has(value.scope))
      )
        return false;
      credential = value.credential;
      return true;
    },
    addSession(value) {
      if (
        !sessionIdSchema.safeParse(value.kiloSessionId).success ||
        !equal(value.authorizationId, config.authorizationId) ||
        !equal(value.authorizationFingerprint, config.authorizationFingerprint) ||
        !equal(value.fence, config.fence)
      )
        return false;
      sessions.add(value.kiloSessionId);
      return true;
    },
    async stop() {
      await serve.stop(true);
    },
  };
}
