import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type FixtureWrite = { method: string; url: string; body: string };

type FixtureMeta = {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
};

const DEFAULT_PORT = 8877;
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(scriptsDir, 'fixtures');
const githubDir = join(fixturesDir, 'github');
const bundlePath = join(fixturesDir, 'review-fixture.bundle');
const workRoot = join(fixturesDir, '.work');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function loadMeta(): FixtureMeta {
  const meta = readJson<FixtureMeta>(join(fixturesDir, 'meta.json'));
  if (!/^[0-9a-f]{40}$/i.test(meta.headSha) || !/^[0-9a-f]{40}$/i.test(meta.baseSha)) {
    throw new Error('fixture meta.json is missing full 40-hex SHAs');
  }
  return meta;
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function bareRepoPath(meta: FixtureMeta): string {
  return join(workRoot, meta.owner, `${meta.repo}.git`);
}

function needsUnpack(meta: FixtureMeta, bareRepo: string): boolean {
  if (!existsSync(bareRepo) || !existsSync(join(bareRepo, 'HEAD'))) return true;
  try {
    const head = git(['-C', bareRepo, 'rev-parse', 'refs/heads/pr-head']);
    const base = git(['-C', bareRepo, 'rev-parse', 'refs/heads/base']);
    if (head !== meta.headSha || base !== meta.baseSha) return true;
    return statSync(bundlePath).mtimeMs > statSync(bareRepo).mtimeMs;
  } catch {
    return true;
  }
}

function unpackBundle(meta: FixtureMeta): string {
  const bareRepo = bareRepoPath(meta);
  if (needsUnpack(meta, bareRepo)) {
    rmSync(bareRepo, { recursive: true, force: true });
    mkdirSync(dirname(bareRepo), { recursive: true });
    execFileSync('git', ['clone', '--bare', '--quiet', bundlePath, bareRepo], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  git(['-C', bareRepo, 'update-ref', 'refs/heads/pr-head', meta.headSha]);
  git(['-C', bareRepo, 'update-ref', 'refs/heads/base', meta.baseSha]);
  git(['-C', bareRepo, 'symbolic-ref', 'HEAD', 'refs/heads/pr-head']);
  git(['-C', bareRepo, 'config', 'uploadpack.allowTipSHA1InWant', 'true']);
  git(['-C', bareRepo, 'config', 'uploadpack.allowReachableSHA1InWant', 'true']);
  return bareRepo;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendFile(res: ServerResponse, path: string, contentType: string): void {
  sendText(res, 200, readFileSync(path, 'utf8'), contentType);
}

function isAddrInUse(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'EADDRINUSE'
  );
}

function parseCgiHeaders(headerText: string): { status: number; headers: Array<[string, string]> } {
  let status = 200;
  const headers: Array<[string, string]> = [];
  for (const line of headerText.split(/\r?\n/)) {
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.toLowerCase() === 'status') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) status = parsed;
      continue;
    }
    headers.push([key, value]);
  }
  return { status, headers };
}

function pipeCgi(child: ChildProcessWithoutNullStreams, res: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    let headerBuf = Buffer.alloc(0);
    let headersSent = false;
    const fail = (error: Error) => {
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end();
      reject(error);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (headersSent) {
        res.write(chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const crlf = headerBuf.indexOf('\r\n\r\n');
      const lf = headerBuf.indexOf('\n\n');
      const idx = crlf >= 0 ? crlf : lf;
      if (idx < 0) return;
      const sepLen = crlf >= 0 ? 4 : 2;
      const parsed = parseCgiHeaders(headerBuf.subarray(0, idx).toString('utf8'));
      for (const [key, value] of parsed.headers) res.setHeader(key, value);
      res.writeHead(parsed.status);
      headersSent = true;
      const body = headerBuf.subarray(idx + sepLen);
      if (body.length > 0) res.write(body);
    });
    child.stderr.on('data', () => undefined);
    child.on('error', fail);
    child.on('close', code => {
      if (!headersSent) {
        res.writeHead(code === 0 ? 200 : 500);
      }
      res.end();
      resolve();
    });
  });
}

function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  pathInfo: string,
  body: Buffer
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const child = spawn('git', ['http-backend'], {
    env: {
      ...process.env,
      GIT_HTTP_EXPORT_ALL: '1',
      GIT_PROJECT_ROOT: workRoot,
      PATH_INFO: pathInfo,
      QUERY_STRING: url.search.startsWith('?') ? url.search.slice(1) : url.search,
      REQUEST_METHOD: req.method ?? 'GET',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      CONTENT_LENGTH: String(body.length),
      REMOTE_ADDR: req.socket.remoteAddress ?? '127.0.0.1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(body);
  return pipeCgi(child, res);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('fixture server failed to bind'));
        return;
      }
      resolve(address.port);
    });
  });
}

export async function startFixture(options?: { port?: number }): Promise<{
  origin: string;
  port: number;
  getWriteLog: () => FixtureWrite[];
  getWrites: () => FixtureWrite[];
  stop: () => Promise<void>;
}> {
  const meta = loadMeta();
  unpackBundle(meta);
  const writeLog: FixtureWrite[] = [];
  const gitPrefix = `/${meta.owner}/${meta.repo}.git`;
  const repoApi = `/repos/${meta.owner}/${meta.repo}`;
  const pullApi = `${repoApi}/pulls/${meta.pullNumber}`;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      const method = (req.method ?? 'GET').toUpperCase();

      if (pathname === gitPrefix || pathname.startsWith(`${gitPrefix}/`)) {
        const authorization = req.headers.authorization;
        const credentials = authorization?.startsWith('Basic ')
          ? Buffer.from(authorization.slice(6), 'base64').toString('utf8')
          : '';
        if (!credentials.startsWith('x-access-token:') || credentials === 'x-access-token:') {
          sendJson(res, 401, {
            message: 'Git requests require GitHub installation Basic authentication',
          });
          return;
        }

        const rawPath = url.pathname.startsWith(gitPrefix)
          ? url.pathname
          : `${gitPrefix}${url.pathname.slice(pathname.length)}`;
        const body =
          method === 'GET' || method === 'HEAD'
            ? Buffer.alloc(0)
            : Buffer.from(await readBody(req));
        await handleGit(req, res, rawPath, body);
        return;
      }

      if (method === 'POST' || method === 'PATCH') {
        const body = await readBody(req);
        writeLog.push({ method, url: req.url ?? pathname, body });
        sendJson(res, 200, { id: 1 });
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { message: 'method not allowed' });
        return;
      }

      if (pathname === repoApi) {
        sendFile(res, join(githubDir, 'repo.json'), 'application/json');
        return;
      }
      if (pathname === `${pullApi}/files`) {
        sendFile(res, join(githubDir, 'files.json'), 'application/json');
        return;
      }
      if (pathname === `${pullApi}/comments`) {
        sendFile(res, join(githubDir, 'comments.json'), 'application/json');
        return;
      }
      if (pathname === `${pullApi}/reviews`) {
        sendFile(res, join(githubDir, 'reviews.json'), 'application/json');
        return;
      }
      if (pathname === `${repoApi}/issues/${meta.pullNumber}/comments`) {
        sendFile(res, join(githubDir, 'issue-comments.json'), 'application/json');
        return;
      }
      if (pathname === pullApi) {
        const accept = String(req.headers.accept ?? '').toLowerCase();
        if (accept.includes('diff')) {
          sendFile(res, join(githubDir, 'pull.diff'), 'text/plain');
          return;
        }
        sendFile(res, join(githubDir, 'pull.json'), 'application/json');
        return;
      }

      sendJson(res, 404, { message: 'not found' });
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end();
    });
  });

  const requested = options?.port;
  let port: number;
  try {
    port = await listen(server, requested ?? DEFAULT_PORT);
  } catch (error) {
    if (requested === undefined && isAddrInUse(error)) {
      port = await listen(server, 0);
    } else {
      throw error;
    }
  }

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    getWriteLog: () => writeLog.slice(),
    getWrites: () => writeLog.slice(),
    stop: () =>
      new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  const fixture = await startFixture({ port: DEFAULT_PORT });
  process.stdout.write(`origin=${fixture.origin}\n`);
  const shutdown = () => {
    void fixture.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
