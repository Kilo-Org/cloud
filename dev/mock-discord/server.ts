// A dev-only stand-in for the one Discord REST call the guild-membership
// verify path makes: `GET /api/v10/guilds/<guildId>/members/<userId>`.
// Nothing here is imported by `apps/web`: this is test tooling that answers
// from `fixtures/answer.json`, so Profile's "Verify membership" action and
// `checkDiscordGuildMembership` can be exercised without bot credentials.
//
// The base URL in `apps/web/src/lib/discord-guild-membership.ts` is the fixed
// `https://discord.com/api/v10/`, so the server has to answer on port 443 for
// the host name `discord.com`: an `/etc/hosts` line plus root (or a capability)
// to bind the privileged port. The setup steps are printed on start.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chownSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { caCertPath, loadTls, tlsDir as snowflakeTlsDir } from '../mock-snowflake/tls-env';

const HOST = '127.0.0.1';
const PORT = Number(process.env.MOCK_DISCORD_PORT ?? 443);
const BASE_URL = `https://discord.com${PORT === 443 ? '' : `:${PORT}`}`;

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');
const tlsDir = join(fixturesDir, 'tls');
const leafKeyPath = join(tlsDir, 'discord.key');
const leafCertPath = join(tlsDir, 'discord.crt');
const answerPath = join(fixturesDir, 'answer.json');

/** The real Discord payloads for the two non-200 answers, so error paths read truthfully. */
const DEFAULT_BODIES: Record<number, unknown> = {
  200: { roles: [], joined_at: new Date(0).toISOString() },
  404: { message: 'Unknown Member', code: 10007 },
  500: { message: 'Internal Server Error', code: 0 },
};

const SUPPORTED_STATUSES = Object.keys(DEFAULT_BODIES).map(Number);

type Answer = { status: number; body: unknown };

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/**
 * The answer is a file the developer edits between requests, so a wrong shape
 * must name what is wrong instead of answering something plausible.
 */
function parseAnswer(raw: string): Answer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${answerPath} is not valid JSON: ${String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${answerPath} must hold a JSON object such as {"status": 404}`);
  }
  const status = 'status' in parsed ? parsed.status : 200;
  if (typeof status !== 'number' || !SUPPORTED_STATUSES.includes(status)) {
    throw new Error(
      `${answerPath} has status ${JSON.stringify(status)}; use one of ${SUPPORTED_STATUSES.join(', ')}`
    );
  }
  const body = 'body' in parsed ? parsed.body : DEFAULT_BODIES[status];
  return { status, body };
}

/** Re-read on every request, so switching the answer needs no restart. */
function readAnswer(): Answer {
  if (!existsSync(answerPath)) {
    return { status: 200, body: DEFAULT_BODIES[200] };
  }
  return parseAnswer(readFileSync(answerPath, 'utf8'));
}

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', BASE_URL);
  const method = request.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/health') {
    console.log(`${method} ${url.pathname} 200`);
    send(response, 200, { status: 'ok' });
    return;
  }

  if (method === 'GET' && /^\/api\/v10\/guilds\/[^/]+\/members\/[^/]+$/.test(url.pathname)) {
    let answer: Answer;
    try {
      answer = readAnswer();
    } catch (error) {
      console.error(`${method} ${url.pathname} unreadable control file: ${String(error)}`);
      send(response, 500, { message: String(error), code: 0 });
      return;
    }
    console.log(`${method} ${url.pathname} ${answer.status}`);
    send(response, answer.status, answer.body);
    return;
  }

  console.log(`${method} ${url.pathname} 404`);
  send(response, 404, { message: `No mock route for ${url.pathname}.`, code: 0 });
}

/**
 * A leaf certificate for `discord.com` signed by the snowflake mock's
 * self-signed CA, which the local stack already trusts for the web app. The
 * pair is reused until it stops verifying against the current CA, so a
 * regenerated CA reissues it instead of leaving a certificate nothing trusts.
 */
function loadLeafTls(): { key: Buffer; cert: Buffer } {
  const caKeyPath = join(snowflakeTlsDir, 'key.pem');
  const caCert = caCertPath();
  loadTls();

  if (existsSync(leafKeyPath) && existsSync(leafCertPath) && verifiesAgainstCa(caCert)) {
    return { key: readFileSync(leafKeyPath), cert: readFileSync(leafCertPath) };
  }

  mkdirSync(tlsDir, { recursive: true });
  const serial = `0x${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 16)}`;
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        leafKeyPath,
        '-out',
        leafCertPath,
        '-days',
        '365',
        '-subj',
        '/CN=discord.com',
        '-addext',
        'subjectAltName=DNS:discord.com',
        '-addext',
        'basicConstraints=critical,CA:FALSE',
        '-addext',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        '-addext',
        'extendedKeyUsage=serverAuth',
        '-CA',
        caCert,
        '-CAkey',
        caKeyPath,
        '-set_serial',
        serial,
      ],
      { stdio: 'ignore' }
    );
  } catch (error) {
    throw new Error(
      `Could not issue ${leafCertPath} with openssl from the CA at ${caCert}: ${String(error)}. ` +
        'Install openssl or delete the CA pair to let it be regenerated.'
    );
  }

  return { key: readFileSync(leafKeyPath), cert: readFileSync(leafCertPath) };
}

function verifiesAgainstCa(caCert: string): boolean {
  try {
    execFileSync('openssl', ['verify', '-CAfile', caCert, leafCertPath], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Port 443 needs root, so everything written while running under `sudo` would
 * belong to root and the developer could neither edit the control file nor let
 * a later unprivileged run reuse the certificate. Give those files back to
 * whoever invoked sudo, which is the developer.
 */
function handFixturesBack(): void {
  const uid = Number(process.env.SUDO_UID);
  const gid = Number(process.env.SUDO_GID);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return;
  for (const path of [fixturesDir, tlsDir, leafKeyPath, leafCertPath, answerPath]) {
    if (!existsSync(path)) continue;
    try {
      chownSync(path, uid, gid);
    } catch (error) {
      console.warn(`Could not hand ${path} back to uid ${uid}: ${String(error)}`);
    }
  }
}

export function startMockDiscord(): Server {
  mkdirSync(fixturesDir, { recursive: true });
  const tls = loadLeafTls();
  // The directory and certificate just created are handed back too, so the
  // next run and the control-file edit work without sudo.
  handFixturesBack();
  // Fail at startup, not on the first request, when the control file is bad.
  if (existsSync(answerPath)) {
    parseAnswer(readFileSync(answerPath, 'utf8'));
  }

  const server = createServer(tls, (request, response) => {
    handleRequest(request, response);
  });

  server.on('error', error => {
    const code = 'code' in error ? String(error.code) : '';
    if (code === 'EACCES') {
      console.error(
        `Cannot bind ${HOST}:${PORT}: ${String(error)}. Port 443 needs root; run it as ` +
          `\`sudo -n env MOCK_DISCORD_PORT=${PORT} $(command -v tsx) dev/mock-discord/server.ts\`.`
      );
      return;
    }
    console.error(`mock Discord server error: ${String(error)}`);
  });

  server.listen(PORT, HOST, () => {
    console.log(`mock Discord listening on ${BASE_URL}`);
    console.log(`control file: ${answerPath} (re-read on every request; missing means 200)`);
    console.log('');
    console.log('Setup for a local web app:');
    console.log(
      `  1. Point the name at this machine: echo "127.0.0.1 discord.com" | sudo tee -a /etc/hosts`
    );
    console.log(`  2. Trust the CA the app already loads: NODE_EXTRA_CA_CERTS=${caCertPath()}`);
    console.log(
      '     (`pnpm dev:start` exports it to the web app through the mock-snowflake bundle.)'
    );
    console.log('  3. Set both keys; any snowflake in DISCORD_SERVER_ID matches this route:');
    console.log('       DISCORD_OAUTH_BOT_TOKEN=dev-token');
    console.log('       DISCORD_SERVER_ID=123456789012345678');
    console.log('  4. Change the answer by editing the control file, e.g. {"status": 404}.');
  });

  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    startMockDiscord();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
