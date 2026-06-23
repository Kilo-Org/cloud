import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { createServer } from 'http';
import { extname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const storybookRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const staticRoot = resolve(storybookRoot, 'storybook-static');
const { host, port } = parseArgs(process.argv.slice(2));

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

const server = createServer(async (request, response) => {
  if (!request.url) {
    response.writeHead(400).end('Bad request');
    return;
  }

  const requestUrl = new URL(request.url, `http://${host}:${port}`);
  const fileResult = await resolveStaticPath(requestUrl.pathname);

  if (fileResult.status === 400) {
    response.writeHead(400).end('Bad request');
    return;
  }

  if (fileResult.status === 403) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  const { filePath } = fileResult;
  const fileStats = await stat(filePath).catch(() => null);

  if (!fileStats?.isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }

  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Length': fileStats.size,
    'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Storybook static preview running at http://${host}:${port}/`);
});

async function resolveStaticPath(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return { status: 400 };
  }

  const normalizedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const candidatePath = resolve(staticRoot, `.${normalizedPath}`);

  if (!isInsideStaticRoot(candidatePath)) {
    return { status: 403 };
  }

  const candidateStats = await stat(candidatePath).catch(() => null);
  if (candidateStats?.isDirectory()) {
    return { status: 200, filePath: join(candidatePath, 'index.html') };
  }
  if (candidateStats?.isFile()) {
    return { status: 200, filePath: candidatePath };
  }

  return {
    status: 200,
    filePath: extname(normalizedPath) ? candidatePath : join(staticRoot, 'index.html'),
  };
}

function isInsideStaticRoot(filePath) {
  return filePath === staticRoot || filePath.startsWith(`${staticRoot}${sep}`);
}

function parseArgs(args) {
  const parsed = {
    host: '127.0.0.1',
    port: 6006,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === '--host' || arg === '-h') && args[index + 1]) {
      parsed.host = args[index + 1];
      index += 1;
      continue;
    }
    if ((arg === '--port' || arg === '-p') && args[index + 1]) {
      parsed.port = Number(args[index + 1]);
      index += 1;
    }
  }

  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
    throw new Error(`Invalid port: ${parsed.port}`);
  }

  return parsed;
}
