/** Local production-timer acceptance. Leaves the stopped chat available for UI/replay inspection. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadDevVars, loadExistingUserByEmail, loadRepoEnvFiles, mintApiToken } from './auth.js';
import {
  DEFAULT_CONFIG,
  getMessageResult,
  getSessionSnapshot,
  interruptSession,
  isMessageCompleted,
  openConnectedStream,
  sendCommand,
  startSession,
  trpcCall,
  type DriverConfig,
  type StreamConnection,
} from './client.js';
import { findControlPlaneKiloRuntime } from './sandbox-control.js';
import { SandboxStatusSnapshotSchema } from '../../src/shared/sandbox-status.js';

const execute = promisify(execFile);
const serviceRoot = fileURLToPath(new URL('../..', import.meta.url).href);
const repoRoot = path.resolve(serviceRoot, '../..');
const mode = z.enum(['progress', 'stuck', 'silent']).parse(process.argv[2]);
const outputDirectory = path.resolve(process.argv[3] ?? '');
assert(process.argv[3], 'Provide a new private evidence directory');
const expectedHash = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .parse(process.env.E2E_WRAPPER_SHA256);
const manifest = z
  .object({ services: z.array(z.object({ name: z.string(), port: z.number() })) })
  .parse(JSON.parse(await readFile(path.join(repoRoot, 'dev/logs/manifest.json'), 'utf8')));
const port = (name: string) => {
  const entry = manifest.services.find(service => service.name === name);
  assert(entry && entry.port > 0, `Missing local service ${name}`);
  return entry.port;
};
loadRepoEnvFiles(serviceRoot);
const vars = loadDevVars(serviceRoot);
const user = await loadExistingUserByEmail(
  process.env.DATABASE_URL,
  process.env.E2E_USER_EMAIL ?? 'evgeny@kilocode.ai'
);
const config: DriverConfig = {
  ...DEFAULT_CONFIG,
  user,
  nextAuthSecret: vars.NEXTAUTH_SECRET,
  // The session retains its creation credential across sleep. Allow time for
  // production-duration cases plus later manual same-chat recovery checks.
  bearerToken: mintApiToken(user, vars.NEXTAUTH_SECRET, 4 * 60 * 60),
  internalApiSecret: vars.INTERNAL_API_SECRET,
  expectControlPlane: true,
  workerUrl: `http://localhost:${port('cloud-agent-next')}`,
  fakeLlmUrl: `http://localhost:${port('fake-llm')}`,
  githubRepo: 'na2-org/hi-how-are-you',
  skipBalanceCheck: false,
};
await mkdir(outputDirectory, { mode: 0o700 });
const startedAt = Date.now();
const signal = AbortSignal.timeout(45 * 60_000);
const tag = `${mode}-${randomUUID().slice(0, 8)}`;
const evidence = (kind: string, data: unknown) =>
  appendFile(
    path.join(outputDirectory, 'evidence.jsonl'),
    JSON.stringify({ at: Date.now(), elapsedMs: Date.now() - startedAt, kind, data }) + '\n',
    { mode: 0o600 }
  );
const sleep = () => new Promise<void>(resolve => setTimeout(resolve, 5_000));
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
let stream: StreamConnection | undefined;
let sessionId: string | undefined;
let passed = false;
try {
  config.onSessionCreated = (id, kiloId) => {
    sessionId = id;
    console.log(JSON.stringify({ stage: 'created', sessionId: id, kiloSessionId: kiloId }));
  };
  const session = await startSession(config, { prompt: `__fake__:echo:boot-${tag}`, signal });
  sessionId = session.cloudAgentSessionId;
  await writeFile(path.join(outputDirectory, 'session.json'), JSON.stringify(session, null, 2), {
    mode: 0o600,
  });
  stream = await openConnectedStream(config, sessionId, true, undefined, signal);
  assert(
    isMessageCompleted(await stream.waitForTerminal(240_000, session.messageId), session.messageId),
    'Boot did not complete'
  );
  const runtime = await findControlPlaneKiloRuntime(session.kiloSessionId);
  assert(runtime, 'No owned native runtime found');
  const containerId = runtime.container.id;
  const docker = (...args: string[]) =>
    execute('docker', args, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  const hash = (
    await docker(
      'exec',
      containerId,
      'sha256sum',
      '/usr/local/bin/kilocode-control-plane-wrapper.js'
    )
  ).stdout
    .trim()
    .split(/\s+/)[0];
  assert.equal(hash, expectedHash, 'Running wrapper does not match the reviewed build');
  assert.equal((await docker('exec', containerId, 'kilo', '--version')).stdout.trim(), '7.8.1');
  const snapshot = await getSessionSnapshot(config, sessionId, signal);
  await evidence('identity', {
    sessionId,
    kiloSessionId: session.kiloSessionId,
    sandboxId: snapshot.sandboxId,
    containerId,
    wrapperHash: hash,
    version: '7.8.1',
  });
  const seconds = mode === 'progress' ? 660 : mode === 'silent' ? 300 : 1800;
  let cursor = stream.events.length;
  const commandAt = Date.now();
  const command = await sendCommand(config, {
    cloudAgentSessionId: sessionId,
    command: 'goal',
    arguments: `__fake__:supervision:${tag}:${mode}:${seconds}`,
    signal,
  });
  await evidence('command', { messageId: command.messageId, mode, seconds });
  assert(
    isMessageCompleted(await stream.waitForTerminal(120_000, command.messageId), command.messageId),
    'Initial goal command did not settle before autonomous work'
  );
  const cloudCompletedAt = Date.now();
  await evidence('cloud-completed', { messageId: command.messageId });
  console.log(JSON.stringify({ stage: 'autonomous', mode, sessionId, containerId }));

  let finishedAt: number | undefined;
  let errorReason: unknown;
  let nativeFailed = false;
  let nativeOpens = 0;
  let lastProgressAt = 0;
  let previousEstimate: number | null = null;
  let latestActiveAt = cloudCompletedAt;
  let renewals = 0;
  while (!finishedAt) {
    signal.throwIfAborted();
    for (const event of stream.events.slice(cursor)) {
      if (event.streamEventType !== 'kilocode') continue;
      const data = record(event.data);
      const props = record(data.properties);
      if (data.type === 'session.turn.open') nativeOpens++;
      if (data.type === 'session.error') {
        nativeFailed = true;
        errorReason = props.reason;
        await evidence('session-error', {
          sessionID: props.sessionID,
          reason: props.reason,
          error: typeof props.error === 'string' ? props.error : '[native error]',
        });
        finishedAt = Date.now();
      }
      const part = record(props.part);
      if (typeof part.text === 'string' && part.text.includes(`supervision-complete-${tag}`))
        finishedAt = Date.now();
      if (
        (typeof part.text === 'string' && part.text.includes(`supervision-progress-${tag}`)) ||
        (typeof props.delta === 'string' && props.delta.includes(`supervision-progress-${tag}`))
      )
        lastProgressAt = Date.now();
    }
    cursor = stream.events.length;
    const status = SandboxStatusSnapshotSchema.parse(
      await trpcCall(
        config,
        'getSandboxStatus',
        { cloudAgentSessionId: sessionId },
        { method: 'GET', signal }
      )
    );
    assert.equal(
      status.inactivityTimeoutMs,
      600_000,
      'Acceptance must use the production idle timer'
    );
    assert.equal(status.status, 'active', 'Sandbox stopped during native work');
    assert.equal(
      (await docker('inspect', '--format', '{{.State.Running}}', containerId)).stdout.trim(),
      'true'
    );
    if (status.estimatedSleepAt !== null && status.estimatedSleepAt !== previousEstimate) {
      previousEstimate = status.estimatedSleepAt;
      latestActiveAt = status.estimatedSleepAt - 600_000;
      renewals++;
    }
    await evidence('activity', {
      status,
      nativeOpens,
      lastProgressAt,
      commandStatus: (await getMessageResult(config, sessionId, command.messageId, signal)).status,
    });
    if (!finishedAt) await sleep();
  }
  assert(nativeOpens >= 2, 'No second native execution was observed');
  assert(renewals >= 3, 'Active native work did not advance the allocation idle anchor');
  assert.equal(
    (await getMessageResult(config, sessionId, command.messageId, signal)).status,
    'completed',
    'Autonomous failure overwrote the completed Cloud message'
  );
  if (mode === 'stuck') {
    assert.equal(errorReason, 'no_progress');
    assert(finishedAt - commandAt >= 20 * 60_000, 'No-progress fired before production deadline');
    assert(finishedAt - commandAt < 23 * 60_000, 'No-progress reporting was not bounded');
  } else {
    assert.equal(nativeFailed, false, 'Native execution failed instead of completing');
    assert.equal(errorReason, undefined);
    assert(
      finishedAt - cloudCompletedAt >= (seconds - 5) * 1000,
      'Native work ended before the requested duration'
    );
    if (mode === 'progress')
      assert(
        lastProgressAt - cloudCompletedAt > 600_000,
        'No progress survived the sandbox idle window'
      );
  }
  await evidence('native-finished', { finishedAt, errorReason, nativeOpens, renewals });
  console.log(JSON.stringify({ stage: 'waiting-for-idle-stop', mode, sessionId }));
  for (;;) {
    signal.throwIfAborted();
    const status = SandboxStatusSnapshotSchema.parse(
      await trpcCall(
        config,
        'getSandboxStatus',
        { cloudAgentSessionId: sessionId },
        { method: 'GET', signal }
      )
    );
    await evidence('idle', status);
    if (status.status === 'sleeping') break;
    assert(
      Date.now() - finishedAt < 13 * 60_000,
      'Native work left activity pinned after completion'
    );
    if (status.estimatedSleepAt !== null) latestActiveAt = status.estimatedSleepAt - 600_000;
    await sleep();
  }
  const physical = await docker('ps', '--filter', `id=${containerId}`, '--format', '{{.ID}}');
  assert.equal(
    physical.stdout.trim(),
    '',
    'Public sleeping status preceded physical container stop'
  );
  assert(Date.now() - latestActiveAt >= 590_000, 'Sandbox bypassed its ordinary idle grace');
  passed = true;
  await evidence('passed', { sessionId, mode, durationMs: Date.now() - startedAt });
  console.log(JSON.stringify({ stage: 'passed', sessionId, mode, outputDirectory }));
} catch (error) {
  await evidence('failed', { message: error instanceof Error ? error.message : 'Unknown failure' });
  throw error;
} finally {
  stream?.close();
  if (!passed && sessionId)
    await interruptSession(config, sessionId, AbortSignal.timeout(15_000)).catch(() => undefined);
}
