/** Local-only proof of the native producer, upload authorization, and private storage. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, URL } from 'node:url';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import {
  fetchNativeSnapshot,
  type NativeSnapshot,
} from '../../../../packages/cloud-agent-sdk/src/native-sync-snapshot.js';
import { loadDevVars, loadExistingUserByEmail, loadRepoEnvFiles, mintApiToken } from './auth.js';
import {
  DEFAULT_CONFIG,
  startSession,
  sendMessage,
  trpcCall,
  openConnectedStream,
  isMessageCompleted,
  type DriverConfig,
} from './client.js';
import { containerProcessEnvironment, findControlPlaneKiloRuntime } from './sandbox-control.js';
import { PINNED_CLIS } from '../../scripts/runtime-cli-artifact.js';

const serviceRoot = fileURLToPath(new URL('../..', import.meta.url));
loadRepoEnvFiles(serviceRoot);
const database = new URL(process.env.POSTGRES_URL ?? '');
assert(
  ['localhost', '127.0.0.1'].includes(database.hostname),
  'Use this worktree’s local database'
);
const manifest = z
  .object({ services: z.array(z.object({ name: z.string(), port: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(new URL('../../../../dev/logs/manifest.json', import.meta.url), 'utf8')
    )
  );
function origin(name: string) {
  const service = manifest.services.find(item => item.name === name);
  assert(service && service.port > 0, `Start local service ${name}`);
  return `http://localhost:${service.port}`;
}
const organizationId = z.uuid().parse(process.env.E2E_ORG_ID);
const email = z.email().parse(process.env.E2E_USER_EMAIL);
const user = await loadExistingUserByEmail(database.toString(), email);
const vars = loadDevVars(serviceRoot);
const config: DriverConfig = {
  ...DEFAULT_CONFIG,
  user,
  nextAuthSecret: vars.NEXTAUTH_SECRET,
  bearerToken: mintApiToken(user, vars.NEXTAUTH_SECRET, 3600, organizationId),
  kilocodeOrganizationId: organizationId,
  internalApiSecret: vars.INTERNAL_API_SECRET,
  workerUrl: origin('cloud-agent-next'),
  fakeLlmUrl: origin('fake-llm'),
  skipBalanceCheck: false,
  expectControlPlane: true,
  fetchStreamTicket: async cloudAgentSessionId =>
    jwt.sign(
      {
        type: 'stream_ticket',
        userId: user.id,
        cloudAgentSessionId,
        organizationId,
        nonce: randomUUID(),
      },
      vars.NEXTAUTH_SECRET,
      { algorithm: 'HS256', audience: 'cloud-agent-stream', expiresIn: 120 }
    ),
};
const syncOrigin = origin('cloudflare-session-sync');
const { token: readerToken } = await signModernKiloToken({
  userId: user.id,
  pepper: user.api_token_pepper,
  secret: vars.NEXTAUTH_SECRET,
  expiresInSeconds: 3600,
  env: 'development',
  audience: 'kilo-api',
  tokenPurpose: 'human-api',
  credentialExchange: false,
});
const exchange = await fetch(`${syncOrigin}/v1/auth/exchange`, {
  method: 'POST',
  headers: { authorization: `Bearer ${readerToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ version: 1, organizationID: organizationId }),
});
assert(exchange.ok, 'The synthetic local reader could not authenticate');
const { token: readerGrant } = z.object({ token: z.string() }).parse(await exchange.json());
async function readSnapshotJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${readerGrant}`);
  const response = await fetch(`${syncOrigin}${path}`, {
    ...init,
    headers,
  });
  assert(response.ok, `Local snapshot read failed: ${response.status}`);
  const value: unknown = await response.json();
  // fetchNativeSnapshot owns the wire validation for each requested resource.
  return value as T;
}
const signal = AbortSignal.timeout(180_000);
const marker = `native-upload-${randomUUID().slice(0, 8)}`;
const session = await startSession(config, { prompt: `__fake__:echo:${marker}-cold`, signal });
await writeFile(
  new URL(`../../../../dev/logs/${marker}.json`, import.meta.url),
  JSON.stringify(session),
  { mode: 0o600 }
);
const stream = await openConnectedStream(
  config,
  session.cloudAgentSessionId,
  true,
  undefined,
  signal
);
const execute = promisify(execFile);
try {
  assert(
    isMessageCompleted(await stream.waitForTerminal(120_000, session.messageId), session.messageId),
    'Cold turn did not complete'
  );
  for (const directive of [`echo:${marker}-warm`, 'slow:40:0:2048']) {
    const sent = await sendMessage(config, {
      cloudAgentSessionId: session.cloudAgentSessionId,
      prompt: `__fake__:${directive}`,
      signal,
    });
    assert(
      isMessageCompleted(await stream.waitForTerminal(45_000, sent.messageId), sent.messageId),
      'Follow-up did not complete'
    );
  }
  const history = await trpcCall(
    config,
    'getSessionMessagesPage',
    { sessionId: session.cloudAgentSessionId, limit: 100 },
    { method: 'GET', signal }
  );
  z.object({ source: z.object({ version: z.literal('v2') }) }).parse(history);
  const runtime = await findControlPlaneKiloRuntime(session.kiloSessionId);
  assert(runtime, 'The owned native Kilo runtime was not found');
  const docker = async (args: string[]) =>
    execute('docker', args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  const version = await docker([
    'exec',
    runtime.container.id,
    '/opt/kilo-cloud/active/cli/package/bin/kilo2',
    '--version',
  ]);
  assert.equal(version.stdout.trim(), PINNED_CLIS.kilo2.reportedVersion);
  const environment = await containerProcessEnvironment(
    runtime.container.id,
    runtime.processId,
    docker
  );
  const handle = environment.KILOCODE_TOKEN;
  assert(handle, 'The native runtime has no contained credential');
  for (const [method, suffix] of [
    ['GET', '/entities'],
    ['GET', `/blobs/${'a'.repeat(64)}`],
    ['DELETE', ''],
  ] as const) {
    const denied = await fetch(`${syncOrigin}/v1/sessions/${session.kiloSessionId}${suffix}`, {
      method,
      headers: { authorization: `Bearer ${handle}` },
      signal,
    });
    assert.equal(denied.status, 403, `Hosted ${method} ${suffix} must be denied`);
    await denied.body?.cancel();
  }
  let snapshot: NativeSnapshot | undefined;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    snapshot = await fetchNativeSnapshot(readSnapshotJSON, session.kiloSessionId, signal);
    const texts = snapshot.messages.flatMap(item =>
      item.message.type === 'assistant'
        ? (item.message.content ?? []).flatMap(part =>
            part.type === 'text' ? [part.text ?? ''] : []
          )
        : []
    );
    if (
      texts.includes(`${marker}-cold`) &&
      texts.includes(`${marker}-warm`) &&
      texts.some(text => text.length > 65_536)
    )
      break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert(snapshot, 'The session was not uploaded');
  const texts = snapshot.messages.flatMap(item =>
    item.message.type === 'assistant'
      ? (item.message.content ?? []).flatMap(part =>
          part.type === 'text' ? [part.text ?? ''] : []
        )
      : []
  );
  assert(texts.includes(`${marker}-cold`), 'Cold output is absent from Session Sync');
  assert(texts.includes(`${marker}-warm`), 'Warm output is absent from Session Sync');
  assert(
    texts.some(text => text.length > 65_536),
    'Large native output did not survive private blob upload'
  );
  assert(
    snapshot.entities.some(entity => 'blob' in entity),
    'Large output has no private blob reference'
  );
  console.log(
    JSON.stringify({
      result: 'passed',
      runtime: version.stdout.trim(),
      messages: snapshot.messages.length,
      position: snapshot.position,
      revision: snapshot.revision,
      uploadOnly: true,
      privateBlob: true,
    })
  );
} finally {
  stream.close();
}
