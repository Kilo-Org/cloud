import { cloudSessionMessagesPageSchema } from '../../../../packages/cloud-agent-sdk/src/schemas.js';
/** Local-only proof of Kilo v2 through the public Cloud Agent surface. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadDevVars, loadExistingUserByEmail, loadRepoEnvFiles, mintApiToken } from './auth.js';
import {
  DEFAULT_CONFIG,
  startSession,
  sendMessage,
  trpcCall,
  openConnectedStream,
  isMessageCompleted,
  answerQuestion,
  interruptSession,
  type DriverConfig,
  type StreamConnection,
} from './client.js';
import {
  findControlPlaneKiloRuntime,
  signalKiloServerProcess,
  killSandboxFamily,
} from './sandbox-control.js';

const execute = promisify(execFile);
const serviceRoot = fileURLToPath(new URL('../..', import.meta.url));
const repoRoot = path.resolve(serviceRoot, '../..');
const manifest = z
  .object({ services: z.array(z.object({ name: z.string(), port: z.number() })) })
  .parse(JSON.parse(await readFile(path.join(repoRoot, 'dev/logs/manifest.json'), 'utf8')));
const port = (name: string) => {
  const item = manifest.services.find(service => service.name === name);
  assert(item && item.port > 0, `Missing local service ${name}`);
  return item.port;
};
loadRepoEnvFiles(serviceRoot);
const database = new URL(process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? '');
assert(
  ['localhost', '127.0.0.1'].includes(database.hostname),
  'This driver requires a local database'
);
const vars = loadDevVars(serviceRoot);
const user = await loadExistingUserByEmail(
  database.toString(),
  process.env.E2E_USER_EMAIL ?? 'evgeny@kilocode.ai'
);
const config: DriverConfig = {
  ...DEFAULT_CONFIG,
  user,
  nextAuthSecret: vars.NEXTAUTH_SECRET,
  bearerToken: mintApiToken(user, vars.NEXTAUTH_SECRET, 60 * 60),
  internalApiSecret: vars.INTERNAL_API_SECRET,
  expectControlPlane: true,
  workerUrl: `http://localhost:${port('cloud-agent-next')}`,
  fakeLlmUrl: `http://localhost:${port('fake-llm')}`,
  githubRepo: 'na2-org/hi-how-are-you',
  skipBalanceCheck: false,
};
const tag = `kilo2-${randomUUID().slice(0, 8)}`;
const output = path.resolve(process.argv[2] ?? path.join(repoRoot, `dev/logs/${tag}`));
await mkdir(output, { recursive: true, mode: 0o700 });
const evidence: Array<{ at: string; stage: string; data: unknown }> = [];
async function record(stage: string, data: unknown) {
  evidence.push({ at: new Date().toISOString(), stage, data });
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify({ stage, data }));
}
const signal = AbortSignal.timeout(15 * 60_000);
let stream: StreamConnection | undefined;
try {
  const health = await fetch(`${config.workerUrl}/health`, { signal: AbortSignal.timeout(10_000) });
  assert(health.ok, `Local Worker health returned ${health.status}`);
  const session = await startSession(config, { prompt: `__fake__:echo:${tag}-cold`, signal });
  await record('admitted', session);
  stream = await openConnectedStream(config, session.cloudAgentSessionId, true, undefined, signal);
  const cold = await stream.waitForTerminal(240_000, session.messageId);
  assert(isMessageCompleted(cold, session.messageId), `Cold turn failed: ${JSON.stringify(cold)}`);
  await record('cold-completed', { messageId: session.messageId });

  async function turn(prompt: string, timeoutMs = 120_000) {
    const sent = await sendMessage(config, {
      cloudAgentSessionId: session.cloudAgentSessionId,
      prompt,
      signal,
    });
    await record('sent', { messageId: sent.messageId, prompt });
    const terminal = await stream?.waitForTerminal(timeoutMs, sent.messageId);
    assert(
      isMessageCompleted(terminal ?? null, sent.messageId),
      `Turn failed: ${JSON.stringify(terminal)}`
    );
    return sent;
  }
  const warm = await turn(`__fake__:echo:${tag}-warm`);
  const readHistory = async () => {
    const raw = await trpcCall(
      config,
      'getSessionMessagesPage',
      { sessionId: session.cloudAgentSessionId, limit: 100 },
      { method: 'GET', signal }
    );
    z.object({ source: z.object({ version: z.literal('v2') }) }).parse(raw);
    const page = cloudSessionMessagesPageSchema.parse(raw);
    assert(page, 'Local native history was not found');
    assert.equal(page.omittedItemCount, 0, 'Local native history must be complete');
    return page;
  };
  const history = await readHistory();
  for (const id of [session.messageId, warm.messageId])
    assert.equal(
      history.messages.filter(message => message.info.id === id).length,
      1,
      'User history identity must occur once'
    );
  assert(
    history.messages.some(message =>
      message.parts.some(part => part.type === 'text' && part.text === `${tag}-warm`)
    ),
    'Assistant output missing from local history'
  );
  await record('local-history', {
    messages: history.messages.length,
    userIds: history.messages
      .filter(message => message.info.role === 'user')
      .map(message => message.info.id),
  });

  stream.close();
  stream = await openConnectedStream(config, session.cloudAgentSessionId, true, undefined, signal);
  assert.deepEqual(
    (await readHistory()).messages,
    history.messages,
    'Reconnect changed persisted history'
  );
  await record('history-reloaded', { messages: history.messages.length });

  const native = await findControlPlaneKiloRuntime(session.kiloSessionId);
  assert(native, 'No owned Kilo v2 runtime found');
  const docker = async (...args: string[]) =>
    (await execute('docker', args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  assert.equal(
    await docker('exec', native.container.id, 'printenv', 'KILO_RUNTIME_HARNESS'),
    'kilo2'
  );
  const version = await docker('exec', native.container.id, 'kilo2', '--version');
  const hash = (
    await docker(
      'exec',
      native.container.id,
      'sha256sum',
      '/usr/local/bin/kilocode-control-plane-wrapper.js'
    )
  ).split(/\s+/)[0];
  if (process.env.E2E_WRAPPER_SHA256)
    assert.equal(hash, process.env.E2E_WRAPPER_SHA256, 'Running wrapper hash differs');
  await record('runtime-identity', {
    containerId: native.container.id,
    processId: native.processId,
    directory: native.directory,
    version,
    wrapperHash: hash,
  });

  await turn(`__fake__:file:write:${tag}-file:kilo2-proof.txt:local-v2-history`);
  const tools = await readHistory();
  assert(
    tools.messages.some(message =>
      message.parts.some(part => part.type === 'tool' && part.tool === 'write')
    ),
    'Native file tool missing'
  );
  await record('native-tool', { messages: tools.messages.length });

  const questionTurn = await sendMessage(config, {
    cloudAgentSessionId: session.cloudAgentSessionId,
    prompt: `__fake__:question:${tag}-question:Continue the Kilo v2 proof?`,
    signal,
  });
  const asked = await stream.waitFor(
    event => event.streamEventType === 'kilocode' && event.data.type === 'question.asked',
    90_000
  );
  assert(asked, 'No question reached the Cloud stream');
  const question = z.object({ id: z.string() }).parse(asked.data.properties);
  assert(
    (await answerQuestion(config, session.cloudAgentSessionId, question.id, [['Continue']], signal))
      .success
  );
  assert(
    isMessageCompleted(
      await stream.waitForTerminal(90_000, questionTurn.messageId),
      questionTurn.messageId
    ),
    'Question did not resume'
  );
  await record('question-resumed', { messageId: questionTurn.messageId });

  await signalKiloServerProcess(
    { containerId: native.container.id, processId: native.processId },
    'KILL'
  );
  const deadline = Date.now() + 60_000;
  let replacement = await findControlPlaneKiloRuntime(session.kiloSessionId);
  while (!replacement || replacement.processId === native.processId) {
    assert(Date.now() < deadline, 'Native process did not recover with its history');
    await new Promise(resolve => setTimeout(resolve, 1000));
    replacement = await findControlPlaneKiloRuntime(session.kiloSessionId);
  }
  await turn(`__fake__:echo:${tag}-recovered`);
  const recovered = await readHistory();
  assert(
    recovered.messages.some(message => message.info.id === session.messageId),
    'Native recovery lost cold history'
  );
  await record('native-recovery', {
    oldPid: native.processId,
    newPid: replacement.processId,
    messages: recovered.messages.length,
  });

  const beforeStop = new Set(stream.events);
  const stopped = await sendMessage(config, {
    cloudAgentSessionId: session.cloudAgentSessionId,
    prompt: '__fake__:hang',
    signal,
  });
  await stream.waitFor(
    event =>
      !beforeStop.has(event) &&
      event.streamEventType === 'kilocode' &&
      event.data.type === 'session.turn.open',
    30_000
  );
  assert((await interruptSession(config, session.cloudAgentSessionId, signal)).success);
  const cancelled = await stream.waitForTerminal(30_000, stopped.messageId);
  assert(cancelled, 'Stop did not settle the turn');
  assert.equal(cancelled.streamEventType, 'cloud.message.failed');
  assert.equal(cancelled.data.reason, 'interrupted', 'Stop must retain the interruption reason');
  await record('stop', { messageId: stopped.messageId, terminal: cancelled.streamEventType });
  await turn(`__fake__:echo:${tag}-after-stop`);
  const beforeReplacement = await findControlPlaneKiloRuntime(session.kiloSessionId);
  assert(beforeReplacement, 'No owned runtime before sandbox replacement');
  await killSandboxFamily(beforeReplacement.container);
  await record('sandbox-stopped', { containerId: beforeReplacement.container.id });
  // The local Containers emulator retains stopped proxy references. Restart
  // this worktree's Worker while preserving its Durable Object storage.
  stream.close();
  await execute('pnpm', ['dev:restart', 'cloud-agent-next'], {
    cwd: repoRoot,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  const readyDeadline = Date.now() + 120_000;
  while (true) {
    const ready = await fetch(`${config.workerUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => undefined);
    if (ready?.ok) break;
    assert(Date.now() < readyDeadline, 'Local Worker did not restart');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  stream = await openConnectedStream(config, session.cloudAgentSessionId, true, undefined, signal);
  await record('local-worker-restarted', {
    historyMessages: (await readHistory()).messages.length,
  });
  await turn(`__fake__:echo:${tag}-restored`, 240_000);
  const restored = await findControlPlaneKiloRuntime(session.kiloSessionId);
  assert(
    restored && restored.container.id !== beforeReplacement.container.id,
    'Sandbox was not replaced'
  );
  const nativeHistoryScript = `import fs from 'node:fs';
    const environment = Object.fromEntries(fs.readFileSync('/proc/${restored.processId}/environ', 'utf8').split('\\0').map(value => {
      const i = value.indexOf('='); return [value.slice(0, i), value.slice(i + 1)];
    }));
    const authorization = 'Basic ' + Buffer.from(environment.KILO_SERVER_USERNAME + ':' + environment.KILO_SERVER_PASSWORD).toString('base64');
    const response = await fetch(${JSON.stringify(restored.serverUrl + '/api/session/' + session.kiloSessionId + '/message?order=asc&limit=200')}, {headers:{Authorization:authorization}});
    if(!response.ok) throw new Error('Native history probe failed');
    const page = await response.json();
    console.log(JSON.stringify({ userIds: page.data.filter(message => message.type === 'user').map(message => message.id) }));`;
  const restoredHistory = z
    .object({ userIds: z.array(z.string()) })
    .parse(
      JSON.parse(
        await docker(
          'exec',
          restored.container.id,
          'node',
          '--input-type=module',
          '-e',
          nativeHistoryScript
        )
      )
    );
  for (const id of [session.messageId, warm.messageId])
    assert(restoredHistory.userIds.includes(id), 'Replacement sandbox lost earlier model context');
  await record('sandbox-history-restored', {
    containerId: restored.container.id,
    nativeUserIds: restoredHistory.userIds,
  });
  await record('passed', {
    sessionId: session.cloudAgentSessionId,
    kiloSessionId: session.kiloSessionId,
    evidenceDirectory: output,
  });
} catch (error) {
  await record('failed', {
    message: error instanceof Error ? error.message : 'Local proof failed',
  });
  throw error;
} finally {
  if (stream)
    await writeFile(path.join(output, 'events.json'), JSON.stringify(stream.events, null, 2), {
      mode: 0o600,
    });
  stream?.close();
}
