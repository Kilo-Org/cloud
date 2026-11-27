import { vi } from 'vitest';

export type MockSecret = { path: string; name: string; value: string; version: number; id: string };

export function secret(
  path: string,
  name: string,
  value: string,
  options?: { version?: number; id?: string }
): MockSecret {
  return {
    path,
    name,
    value,
    version: options?.version ?? 1,
    id: options?.id ?? `id:${path}/${name}`,
  };
}

type Folder = '/workloads' | '/shared' | '/ci';

export type ManagerMock = {
  loginBodies: unknown[];
  reads: Array<{
    folder: string;
    url: URL;
    ifNoneMatch: string | null;
    authorization: string | null;
  }>;
  setSecrets: (secrets: MockSecret[]) => void;
  setReadStatus: (status: number, headers?: Record<string, string>) => void;
  /** Answers this status to reads of one folder only; 200 restores it. */
  setFolderStatus: (folder: Folder, status: number) => void;
  setLoginStatus: (status: number) => void;
  removeFolder: (folder: Folder) => void;
};

/**
 * Stands in for Infisical Cloud for one test: JWT Auth login and `GET /api/v4/secrets` with
 * `recursive=true`. Each folder has an ETag that changes when its content does, so a matching
 * `If-None-Match` gets 304, as the real route does. Values are synthetic.
 */
export function installManager(options: {
  secrets: MockSecret[];
  loginStatus?: number;
  readStatus?: number;
  expiresIn?: number;
  /**
   * Answers every request this many milliseconds late, so concurrent callers overlap. A delay,
   * not a test-controlled gate: workerd hangs a promise resolved from another request context.
   */
  latencyMs?: number;
}): ManagerMock {
  let secrets = options.secrets;
  let generation = 1;
  let loginStatus = options.loginStatus ?? 200;
  let readStatus = options.readStatus ?? 200;
  let readHeaders: Record<string, string> = {};
  const absent = new Set<Folder>();
  const folderStatus = new Map<string, number>();

  const etagFor = (folder: string): string => `"${folder.slice(1)}-${generation}"`;

  const mock: ManagerMock = {
    loginBodies: [],
    reads: [],
    setSecrets: next => {
      secrets = next;
      generation += 1;
    },
    setReadStatus: (status, headers) => {
      readStatus = status;
      readHeaders = headers ?? {};
    },
    setFolderStatus: (folder, status) => {
      folderStatus.set(folder, status);
    },
    setLoginStatus: status => {
      loginStatus = status;
    },
    removeFolder: folder => {
      absent.add(folder);
      generation += 1;
    },
  };

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    if (options.latencyMs !== undefined) await scheduler.wait(options.latencyMs);
    if (url.pathname === '/api/v1/auth/jwt-auth/login') {
      const raw = init?.body;
      mock.loginBodies.push(typeof raw === 'string' ? JSON.parse(raw) : null);
      if (loginStatus !== 200) return new Response('login refused', { status: loginStatus });
      return Response.json({
        accessToken: 'manager-access-token',
        expiresIn: options.expiresIn ?? 600,
        accessTokenMaxTTL: 600,
        tokenType: 'Bearer',
      });
    }
    if (url.pathname === '/api/v4/secrets') {
      const headers = new Headers(init?.headers);
      const folder = url.searchParams.get('secretPath') ?? '/';
      const ifNoneMatch = headers.get('if-none-match');
      mock.reads.push({ folder, url, ifNoneMatch, authorization: headers.get('authorization') });
      const status = folderStatus.get(folder) ?? readStatus;
      if (status !== 200) {
        return new Response('read failed', { status, headers: readHeaders });
      }
      if (absent.has(folder === '/shared' || folder === '/ci' ? folder : '/workloads')) {
        return Response.json(
          {
            reqId: 'req-1',
            statusCode: 404,
            message: `Folder with path '${folder}' was not found.`,
            error: 'SecretPathNotFound',
          },
          { status: 404 }
        );
      }
      const etag = etagFor(folder);
      if (ifNoneMatch === etag) return new Response(null, { status: 304, headers: { etag } });
      const listed = secrets
        .filter(entry => entry.path === folder || entry.path.startsWith(`${folder}/`))
        .map(entry => ({
          id: entry.id,
          _id: entry.id,
          workspace: 'test-project-id',
          environment: 'development',
          version: entry.version,
          type: 'shared',
          secretKey: entry.name,
          secretValue: entry.value,
          secretComment: '',
          secretPath: entry.path,
          secretValueHidden: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
      return Response.json({ secrets: listed, imports: [] }, { headers: { etag } });
    }
    return new Response('not found', { status: 404 });
  };

  vi.stubGlobal('fetch', fetchImpl);
  return mock;
}

/**
 * The default for a test that installs no manager: every outbound request fails fast with 503.
 * Background refresher alarms still run: each manager read fails, the refresher records a failure
 * and re-arms with backoff. `setup.ts` disarms it after every test.
 */
export function stubOfflineNetwork(): void {
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', async () => new Response('offline', { status: 503 }));
}
