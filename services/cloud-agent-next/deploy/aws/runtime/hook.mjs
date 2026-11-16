import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { parseLaunchEnvelope } from './launch-document.mjs';

const prefix = '/aws/lambda-microvms/runtime/v1/';
let child;
const server = createServer(async (request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  if (request.url === prefix + 'ready' || request.url === prefix + 'validate') {
    response.writeHead(200).end();
    return;
  }
  if (request.url === prefix + 'terminate') {
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* The owned process may have exited. */
      }
    }
    response.writeHead(200).end();
    return;
  }
  if (request.url !== prefix + 'run') {
    response.writeHead(404).end();
    return;
  }
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 32_768) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const envelope = parseLaunchEnvelope(JSON.parse(body.runHookPayload));
    if (child) {
      response.writeHead(409).end();
      return;
    }
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root', LANG: 'en_US.UTF-8' };
    if (envelope.proxy)
      Object.assign(env, {
        HTTP_PROXY: envelope.proxy,
        HTTPS_PROXY: envelope.proxy,
        NODE_USE_ENV_PROXY: '1',
        NO_PROXY: 'localhost,127.0.0.1,::1',
      });
    // Node reads proxy settings at startup, before the full launch environment exists.
    child = spawn(
      '/usr/local/bin/node',
      [
        '--input-type=module',
        '-e',
        `import {startLaunchDocument} from ${JSON.stringify(new URL('./launch-document.mjs', import.meta.url).href)};` +
          'startLaunchDocument(JSON.parse(process.argv[1])).catch(()=>{console.error("AWS launch failed");process.exit(1)});',
        JSON.stringify(envelope),
      ],
      { env, stdio: 'inherit', detached: true }
    );
    child.on('error', () => console.error('AWS launch process failed'));
    response.writeHead(200).end();
  } catch {
    response.writeHead(400).end('Invalid launch');
  }
});
server.headersTimeout = 10_000;
server.requestTimeout = 10_000;
server.maxHeadersCount = 32;
server.listen(8080, '0.0.0.0');
