#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WRAPPER_VERSION } from '../src/shared/wrapper-version.js';

export const SNAPSHOT_RUNTIME = 'node24';
export const PINNED_BUN_VERSION = '1.3.14';
export const PINNED_KILO_VERSION = '7.4.20';
export const SNAPSHOT_MANIFEST_PATH = '/usr/local/share/kilo/runtime-manifest.json';
export const SNAPSHOT_WRAPPER_PATH = '/usr/local/bin/kilocode-wrapper.js';
export const SNAPSHOT_CONTROL_WRAPPER_PATH = '/usr/local/bin/kilocode-control-wrapper.js';
const API_BASE = 'https://api.vercel.com';
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_FAILURE_OUTPUT_CHARS = 8_000;
const WAITED_COMMAND_TRANSPORT_ALLOWANCE_MS = 15_000;
const SECRET_ENV_NAMES = ['VERCEL_TOKEN'];
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_VARS_PATH = resolve(PACKAGE_ROOT, '.dev.vars');
const DEFAULT_WRAPPER_PATH = resolve(PACKAGE_ROOT, 'wrapper', 'dist', 'wrapper.js');
const DEFAULT_CONTROL_WRAPPER_PATH = resolve(PACKAGE_ROOT, 'wrapper', 'dist', 'control-wrapper.js');
const DEV_VARS_FALLBACK_KEYS = ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'];

export type RuntimeManifest = {
  runtimeBuildId: string;
  wrapperVersion: string;
  runtime: typeof SNAPSHOT_RUNTIME;
  bunVersion: string;
  wrapperSha256: string;
};

export type ScanObservation = {
  kind: 'credential-path' | 'git-config' | 'git-remote' | 'repository' | 'session-log';
  path: string;
};

export type AcceptedConfig = {
  VERCEL_SANDBOX_SNAPSHOT_ID: string;
  VERCEL_SANDBOX_RUNTIME_BUILD_ID: string;
  VERCEL_SANDBOX_RUNTIME: typeof SNAPSHOT_RUNTIME;
};

type ProviderConfig = { token: string; teamId: string; projectId: string };
type Args = Record<string, string | boolean>;
type SessionTarget = { sandboxName: string; sessionId: string };
const liveSessions = new Set<SessionTarget>();

function log(message: string): void {
  process.stderr.write(`[snapshot] ${message}\n`);
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (value, secret) => (secret ? value.split(secret).join('[redacted]') : value),
    text
  );
}

export function truncateOutput(text: string, maxChars = MAX_FAILURE_OUTPUT_CHARS): string {
  const trimmed = text.replaceAll('\0', '').trimEnd();
  if (trimmed.length <= maxChars) return trimmed;
  return `…${trimmed.slice(-maxChars)}`;
}

export function createRuntimeManifest(input: {
  runtimeBuildId: string;
  wrapperVersion: string;
  wrapperBytes: Uint8Array;
  bunVersion?: string;
}): RuntimeManifest {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.runtimeBuildId)) {
    throw new Error('runtime build ID must be 1-128 URL-safe characters');
  }
  if (!/^\d+\.\d+\.\d+$/.test(input.wrapperVersion)) {
    throw new Error('wrapper version must be a semantic version');
  }
  return {
    runtimeBuildId: input.runtimeBuildId,
    wrapperVersion: input.wrapperVersion,
    runtime: SNAPSHOT_RUNTIME,
    bunVersion: input.bunVersion ?? PINNED_BUN_VERSION,
    wrapperSha256: createHash('sha256').update(input.wrapperBytes).digest('hex'),
  };
}

export function validateRuntimeManifest(actual: unknown, expected: RuntimeManifest): string[] {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual))
    return ['manifest is not an object'];
  const record = actual as Record<string, unknown>;
  return (Object.keys(expected) as Array<keyof RuntimeManifest>)
    .filter(key => record[key] !== expected[key])
    .map(key => `${key} mismatch`);
}

export function parseScanOutput(output: string): ScanObservation[] {
  const allowedKinds = new Set<ScanObservation['kind']>([
    'credential-path',
    'git-config',
    'git-remote',
    'repository',
    'session-log',
  ]);
  const observations: ScanObservation[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 1) throw new Error('invalid scan output');
    const kind = line.slice(0, tab);
    const path = line.slice(tab + 1);
    if (!allowedKinds.has(kind as ScanObservation['kind']) || !path.startsWith('/')) {
      throw new Error('invalid scan output');
    }
    observations.push({ kind: kind as ScanObservation['kind'], path });
  }
  return observations.sort((a, b) => `${a.kind}\0${a.path}`.localeCompare(`${b.kind}\0${b.path}`));
}

export function createAcceptedConfig(
  snapshotId: string,
  manifest: RuntimeManifest
): AcceptedConfig {
  if (!snapshotId || snapshotId.length > 256) throw new Error('invalid snapshot ID');
  return {
    VERCEL_SANDBOX_SNAPSHOT_ID: snapshotId,
    VERCEL_SANDBOX_RUNTIME_BUILD_ID: manifest.runtimeBuildId,
    VERCEL_SANDBOX_RUNTIME: manifest.runtime,
  };
}

function parseArgs(argv: string[]): { command: string; args: Args } {
  const [command = 'help', ...rest] = argv;
  const args: Args = {};
  for (let index = 0; index < rest.length; index++) {
    const item = rest[index];
    if (!item.startsWith('--')) throw new Error(`unexpected argument: ${item}`);
    const key = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      index++;
    }
  }
  return { command, args };
}

export function parseDevVars(content: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) vars.set(key, value);
  }
  return vars;
}

export function applyDevVarsFallback(
  env: NodeJS.ProcessEnv,
  vars: Map<string, string>,
  keys: readonly string[] = DEV_VARS_FALLBACK_KEYS
): void {
  for (const key of keys) {
    if (env[key]?.trim()) continue;
    const value = vars.get(key)?.trim();
    if (value) env[key] = value;
  }
}

function loadLocalDevVars(): void {
  let content: string;
  try {
    content = readFileSync(DEV_VARS_PATH, 'utf8');
  } catch {
    return;
  }
  applyDevVarsFallback(process.env, parseDevVars(content));
}

function requiredArg(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function optionalArg(args: Args, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function defaultRuntimeBuildId(now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  const time = now.toISOString().slice(11, 19).replaceAll(':', '');
  return `local-${date}-${time}`;
}

export function resolveSnapshotInputs(args: Args): {
  wrapperPath: string;
  controlWrapperPath: string;
  wrapperVersion: string;
  runtimeBuildId: string;
} {
  return {
    wrapperPath: resolve(optionalArg(args, 'wrapper') ?? DEFAULT_WRAPPER_PATH),
    controlWrapperPath: resolve(
      optionalArg(args, 'control-wrapper') ?? DEFAULT_CONTROL_WRAPPER_PATH
    ),
    wrapperVersion: optionalArg(args, 'wrapper-version') ?? WRAPPER_VERSION,
    runtimeBuildId: optionalArg(args, 'build-id') ?? defaultRuntimeBuildId(),
  };
}

function optionalNumber(args: Args, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`--${name} requires a value`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000)
    throw new Error(`--${name} must be an integer >= 1000`);
  return parsed;
}

function providerConfig(args: Args): ProviderConfig {
  loadLocalDevVars();
  const token = process.env.VERCEL_TOKEN?.trim();
  if (!token) throw new Error('VERCEL_TOKEN is required for live operations');
  const teamId = optionalArg(args, 'team-id') ?? process.env.VERCEL_TEAM_ID?.trim();
  const projectId = optionalArg(args, 'project-id') ?? process.env.VERCEL_PROJECT_ID?.trim();
  if (!teamId) throw new Error('--team-id is required (or set VERCEL_TEAM_ID in .dev.vars)');
  if (!projectId)
    throw new Error('--project-id is required (or set VERCEL_PROJECT_ID in .dev.vars)');
  return { token, teamId, projectId };
}

function assertNoSecretArgs(argv: string[]): void {
  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name];
    if (value && argv.some(argument => argument.includes(value))) {
      throw new Error(`${name} must not be passed as a command argument`);
    }
  }
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  operation: string
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${operation} response is too large`);
  }
  if (!response.body) throw new Error(`${operation} returned an empty response`);
  const body = response.body as ReadableStream<Uint8Array>;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${operation} response is too large`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function boundedJson(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${operation} failed with status ${response.status}`);
  }
  const bytes = await readBoundedBytes(response, MAX_RESPONSE_BYTES, operation);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

async function api(config: ProviderConfig, path: string, init: RequestInit, operation: string) {
  const url = new URL(path, API_BASE);
  url.searchParams.set('teamId', config.teamId);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${config.token}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    return await boundedJson(
      await fetch(url, { ...init, headers, signal: controller.signal }),
      operation
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      throw new Error(`${operation} timed out`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function object(value: unknown, operation: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${operation} returned an invalid response`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, field: string, operation: string): string {
  const value = record[field];
  if (typeof value !== 'string' || !value)
    throw new Error(`${operation} returned an invalid response`);
  return value;
}

async function createSandbox(
  config: ProviderConfig,
  name: string,
  timeoutMs: number,
  snapshotId?: string
): Promise<SessionTarget> {
  const body = {
    projectId: config.projectId,
    name,
    runtime: SNAPSHOT_RUNTIME,
    timeout: timeoutMs,
    persistent: false,
    env: {},
    ...(snapshotId ? { source: { type: 'snapshot', snapshotId } } : {}),
    tags: { 'kilo-managed-by': 'snapshot-operator' },
  };
  const envelope = object(
    await api(
      config,
      '/v2/sandboxes',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      'create sandbox'
    ),
    'create sandbox'
  );
  const sandbox = object(envelope.sandbox, 'create sandbox');
  const session = object(envelope.session, 'create sandbox');
  const sessionId = stringField(session, 'id', 'create sandbox');
  if (
    stringField(sandbox, 'name', 'create sandbox') !== name ||
    sandbox.persistent !== false ||
    sandbox.currentSessionId !== sessionId ||
    session.sourceSandboxName !== name ||
    session.projectId !== config.projectId ||
    session.runtime !== SNAPSHOT_RUNTIME ||
    (snapshotId && session.sourceSnapshotId !== snapshotId)
  ) {
    throw new Error('create sandbox correlation failed');
  }
  const target = { sandboxName: name, sessionId };
  liveSessions.add(target);
  log(`created ${name} session=${sessionId}${snapshotId ? ` snapshot=${snapshotId}` : ''}`);
  return target;
}

function optionalStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function commandLabel(command: string, args: string[]): string {
  const first = args[0] === '-lc' ? args[1] : args.join(' ');
  const preview = first ? `${command} ${first}` : command;
  return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
}

function formatCommandFailure(
  config: ProviderConfig,
  sessionId: string,
  command: string,
  args: string[],
  finished: Record<string, unknown> | undefined,
  extras: string[]
): string {
  const exit =
    finished && typeof finished.exitCode === 'number' ? ` (exit ${finished.exitCode})` : '';
  const cmdId = finished ? optionalStringField(finished, 'id') : undefined;
  const parts = [
    `execute command failed${exit}: ${commandLabel(command, args)}`,
    `session=${sessionId}`,
  ];
  if (cmdId) parts.push(`cmd=${cmdId}`);
  const secrets = [config.token];
  for (const extra of extras) {
    const cleaned = truncateOutput(redactSecrets(extra, secrets));
    if (cleaned) parts.push(cleaned);
  }
  return parts.join('\n');
}

async function readRemoteTextIfPresent(
  config: ProviderConfig,
  sessionId: string,
  path: string
): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await readRemoteFile(config, sessionId, path));
  } catch {
    return undefined;
  }
}

async function execute(
  config: ProviderConfig,
  sessionId: string,
  command: string,
  args: string[],
  options: { sudo?: boolean; timeoutMs?: number; label?: string } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stdoutPath = `/tmp/kilo-operator-${randomUUID()}.stdout`;
  const stderrPath = `/tmp/kilo-operator-${randomUUID()}.stderr`;
  const wrapped = `${shellCommand(command, args)} >${shellQuote(stdoutPath)} 2>${shellQuote(stderrPath)}`;
  const body = {
    command: 'bash',
    args: ['-lc', wrapped],
    env: {},
    sudo: options.sudo ?? false,
    wait: true,
    timeout: timeoutMs,
  };
  log(options.label ?? `exec ${commandLabel(command, args)}`);
  const response = await fetchWithAuth(
    config,
    `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/cmd`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    timeoutMs + WAITED_COMMAND_TRANSPORT_ALLOWANCE_MS
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const stdout = await readRemoteTextIfPresent(config, sessionId, stdoutPath);
    const stderr = await readRemoteTextIfPresent(config, sessionId, stderrPath);
    throw new Error(
      formatCommandFailure(config, sessionId, command, args, undefined, [
        `http ${response.status}`,
        stdout ? `stdout:\n${stdout}` : '',
        stderr ? `stderr:\n${stderr}` : '',
      ])
    );
  }
  const text = await boundedText(response, 'execute command');
  const lines = text.split('\n').filter(Boolean);
  if (lines.length !== 2) throw new Error('execute command returned an invalid response');
  let finished: Record<string, unknown>;
  try {
    finished = object(object(JSON.parse(lines[1]), 'execute command').command, 'execute command');
  } catch {
    throw new Error('execute command returned an invalid response');
  }
  if (finished.sessionId !== sessionId || finished.exitCode !== 0) {
    const stdout = await readRemoteTextIfPresent(config, sessionId, stdoutPath);
    const stderr = await readRemoteTextIfPresent(config, sessionId, stderrPath);
    throw new Error(
      formatCommandFailure(config, sessionId, command, args, finished, [
        stdout ? `stdout:\n${stdout}` : '',
        stderr ? `stderr:\n${stderr}` : '',
      ])
    );
  }
  const stdout = (await readRemoteTextIfPresent(config, sessionId, stdoutPath)) ?? '';
  await executeRaw(config, sessionId, 'rm', ['-f', stdoutPath, stderrPath]).catch(() => undefined);
  return stdout;
}

async function executeRaw(
  config: ProviderConfig,
  sessionId: string,
  command: string,
  args: string[]
): Promise<void> {
  const response = await fetchWithAuth(
    config,
    `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/cmd`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command,
        args,
        env: {},
        sudo: false,
        wait: true,
        timeout: 30_000,
      }),
    },
    45_000
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`execute command failed with status ${response.status}`);
  }
  await response.body?.cancel().catch(() => undefined);
}

async function executeForFile(
  config: ProviderConfig,
  sessionId: string,
  command: string,
  args: string[]
): Promise<string> {
  return execute(config, sessionId, command, args, { label: 'capture remote output' });
}

async function fetchWithAuth(
  config: ProviderConfig,
  path: string,
  init: RequestInit,
  deadlineMs = 60_000
): Promise<Response> {
  const url = new URL(path, API_BASE);
  url.searchParams.set('teamId', config.teamId);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${config.token}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deadlineMs);
  try {
    return await fetch(url, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function boundedText(response: Response, operation: string): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(response, MAX_RESPONSE_BYTES, operation));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

function tarString(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength >= length) throw new Error('file path is too long');
  header.set(bytes, offset);
}

function tarOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  tarString(header, offset, length, value.toString(8).padStart(length - 1, '0'));
}

async function gzipTar(path: string, content: Uint8Array): Promise<Uint8Array> {
  const header = new Uint8Array(512);
  tarString(header, 0, 100, path);
  tarOctal(header, 100, 8, 0o755);
  tarOctal(header, 108, 8, 0);
  tarOctal(header, 116, 8, 0);
  tarOctal(header, 124, 12, content.byteLength);
  tarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  tarString(header, 257, 8, 'ustar  ');
  tarOctal(
    header,
    148,
    8,
    header.reduce((sum, byte) => sum + byte, 0)
  );
  const padding = new Uint8Array((512 - (content.byteLength % 512)) % 512);
  const stream = new Blob([header, content, padding, new Uint8Array(1024)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function writeRemoteFile(
  config: ProviderConfig,
  sessionId: string,
  destinationDirectory: string,
  name: string,
  content: Uint8Array
): Promise<void> {
  const response = await fetchWithAuth(
    config,
    `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/fs/write`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', 'x-cwd': destinationDirectory },
      body: await gzipTar(name, content),
    }
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`write file failed with status ${response.status}`);
  }
  await response.body?.cancel().catch(() => undefined);
}

async function readRemoteFile(
  config: ProviderConfig,
  sessionId: string,
  path: string
): Promise<Uint8Array> {
  const response = await fetchWithAuth(
    config,
    `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/fs/read`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`read file failed with status ${response.status}`);
  }
  return readBoundedBytes(response, MAX_RESPONSE_BYTES, 'read file');
}

async function stopSession(config: ProviderConfig, target: SessionTarget): Promise<void> {
  log(`stopping ${target.sandboxName} session=${target.sessionId}`);
  const envelope = object(
    await api(
      config,
      `/v2/sandboxes/sessions/${encodeURIComponent(target.sessionId)}/stop`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
      'stop session'
    ),
    'stop session'
  );
  const session = object(envelope.session, 'stop session');
  if (session.id !== target.sessionId || session.sourceSandboxName !== target.sandboxName) {
    throw new Error('stop session correlation failed');
  }
  liveSessions.delete(target);
}

async function stopTrackedSessions(config: ProviderConfig): Promise<void> {
  const remaining = [...liveSessions];
  if (remaining.length === 0) return;
  log(`stopping ${remaining.length} leftover sandbox${remaining.length === 1 ? '' : 'es'}`);
  const failures: string[] = [];
  for (const target of remaining) {
    try {
      await stopSession(config, target);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown failure';
      failures.push(`${target.sandboxName}: ${message}`);
    }
  }
  if (failures.length) throw new Error(`failed to stop leftover sandboxes: ${failures.join('; ')}`);
}

async function withTrackedSessions<T>(config: ProviderConfig, fn: () => Promise<T>): Promise<T> {
  const onSignal = () => {
    log('signal received; stopping leftover sandboxes');
    void stopTrackedSessions(config).finally(() => process.exit(1));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return await fn();
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await stopTrackedSessions(config).catch(error => {
      const message = error instanceof Error ? error.message : 'unknown failure';
      log(message);
    });
  }
}

async function extendSession(config: ProviderConfig, target: SessionTarget, duration: number) {
  const envelope = object(
    await api(
      config,
      `/v2/sandboxes/sessions/${encodeURIComponent(target.sessionId)}/extend-timeout`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration }),
      },
      'extend timeout'
    ),
    'extend timeout'
  );
  const session = object(envelope.session, 'extend timeout');
  if (session.id !== target.sessionId || session.sourceSandboxName !== target.sandboxName) {
    throw new Error('extend timeout correlation failed');
  }
}

async function createSnapshot(config: ProviderConfig, sessionId: string): Promise<string> {
  const envelope = object(
    await api(
      config,
      `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/snapshot`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiration: 0 }),
      },
      'create snapshot'
    ),
    'create snapshot'
  );
  const snapshot = object(envelope.snapshot, 'create snapshot');
  if (snapshot.sourceSessionId !== sessionId || snapshot.status !== 'created') {
    throw new Error('create snapshot correlation failed');
  }
  return stringField(snapshot, 'id', 'create snapshot');
}

async function listSnapshotIds(config: ProviderConfig): Promise<Set<string>> {
  const url = new URL('/v2/sandboxes/snapshots', API_BASE);
  url.searchParams.set('teamId', config.teamId);
  url.searchParams.set('project', config.projectId);
  url.searchParams.set('limit', '50');
  const headers = new Headers({ Authorization: `Bearer ${config.token}` });
  const envelope = object(
    await boundedJson(await fetch(url, { headers }), 'list snapshots'),
    'list snapshots'
  );
  if (!Array.isArray(envelope.snapshots))
    throw new Error('list snapshots returned an invalid response');
  return new Set(
    envelope.snapshots.map(value =>
      stringField(object(value, 'list snapshots'), 'id', 'list snapshots')
    )
  );
}

async function inspectSnapshot(
  config: ProviderConfig,
  snapshotId: string
): Promise<Record<string, unknown>> {
  const envelope = object(
    await api(
      config,
      `/v2/sandboxes/snapshots/${encodeURIComponent(snapshotId)}`,
      { method: 'GET' },
      'get snapshot'
    ),
    'get snapshot'
  );
  const snapshot = object(envelope.snapshot, 'get snapshot');
  if (snapshot.id !== snapshotId || snapshot.status !== 'created')
    throw new Error('snapshot is unavailable');
  return snapshot;
}

function scanCommand(): string {
  return String.raw`set -euo pipefail
emit() { printf '%s\t%s\n' "$1" "$2"; }
for path in /root/.ssh /root/.aws /root/.config/gh /root/.config/glab /home/vercel-sandbox/.ssh /home/vercel-sandbox/.aws /home/vercel-sandbox/.config/gh /home/vercel-sandbox/.config/glab /vercel/sandbox/.env /vercel/sandbox/.env.local; do
  [ ! -e "$path" ] || emit credential-path "$path"
done
for path in /root/.gitconfig /home/vercel-sandbox/.gitconfig /vercel/sandbox/.gitconfig; do
  [ ! -s "$path" ] || emit git-config "$path"
done
for root in /vercel/sandbox /usr/local/share/kilo; do
  [ -d "$root" ] || continue
  find "$root" -xdev -type d -name .git -print
done 2>/dev/null | LC_ALL=C sort | while IFS= read -r path; do emit repository "$path"; done
for root in /vercel/sandbox /usr/local/share/kilo /tmp; do
  [ -d "$root" ] || continue
  find "$root" -xdev -type f \( -name '*.log' -o -name '*session*' \) -print
done 2>/dev/null | LC_ALL=C sort | while IFS= read -r path; do emit session-log "$path"; done
for root in /vercel/sandbox /usr/local/share/kilo; do
  [ -d "$root" ] || continue
  find "$root" -xdev -type f -path '*/.git/config' -print
done 2>/dev/null | LC_ALL=C sort | while IFS= read -r path; do emit git-remote "$path"; done`;
}

async function scanRemote(config: ProviderConfig, sessionId: string): Promise<void> {
  const output = await executeForFile(config, sessionId, 'bash', ['-lc', scanCommand()]);
  const findings = parseScanOutput(output);
  if (findings.length) {
    throw new Error(
      `credential/state scan failed: ${findings.map(item => `${item.kind}:${item.path}`).join(', ')}`
    );
  }
}

async function installBuilder(config: ProviderConfig, sessionId: string): Promise<void> {
  const steps: Array<{ label: string; script: string }> = [
    {
      label: 'install packages (dnf)',
      script: 'sudo dnf install -y git git-lfs jq tar gzip',
    },
    {
      label: `install bun ${PINNED_BUN_VERSION}`,
      script: `curl -fsSL https://bun.sh/install | bash -s ${shellQuote(`bun-v${PINNED_BUN_VERSION}`)} && sudo install -m 0755 "$HOME/.bun/bin/bun" /usr/local/bin/bun`,
    },
    {
      label: `install kilo ${PINNED_KILO_VERSION}`,
      script: `sudo npm install -g ${shellQuote(`@kilocode/cli@${PINNED_KILO_VERSION}`)}`,
    },
    {
      label: 'verify runtime pins',
      script: [
        'sudo mkdir -p /usr/local/share/kilo /opt/git/etc',
        'sudo git lfs install --system --skip-repo',
        `test "$(bun --version)" = ${shellQuote(PINNED_BUN_VERSION)}`,
        'case "$(node --version)" in v24.*) ;; *) echo "unexpected node $(node --version)" >&2; exit 1 ;; esac',
        'curl --version >/dev/null',
        'git --version >/dev/null',
        'kilo --version >/dev/null',
      ].join('\n'),
    },
  ];
  for (const step of steps) {
    await execute(config, sessionId, 'bash', ['-lc', `set -euo pipefail\n${step.script}`], {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      label: step.label,
    });
  }
}

async function smokeWrapper(config: ProviderConfig, sessionId: string, manifest: RuntimeManifest) {
  const smokeSessionId = `agent_${randomUUID()}`;
  const script = `set -euo pipefail
rm -f /tmp/kilo-snapshot-smoke.log /tmp/kilo-snapshot-smoke.err /tmp/kilo-snapshot-health.json
mkdir -p /tmp/kilo-snapshot-home
dump_wrapper() {
  echo "wrapper smoke failed" >&2
  [ -s /tmp/kilo-snapshot-smoke.err ] && { echo "wrapper stderr:" >&2; cat /tmp/kilo-snapshot-smoke.err >&2; }
  [ -s /tmp/kilo-snapshot-smoke.log ] && { echo "wrapper log:" >&2; cat /tmp/kilo-snapshot-smoke.log >&2; }
}
cleanup() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf /tmp/kilo-snapshot-home /tmp/kilo-snapshot-smoke.log /tmp/kilo-snapshot-smoke.err /tmp/kilo-snapshot-health.json; }
HOME=/tmp/kilo-snapshot-home WRAPPER_PORT=5099 WRAPPER_LOG_PATH=/tmp/kilo-snapshot-smoke.log bun ${SNAPSHOT_WRAPPER_PATH} --agent-session ${shellQuote(smokeSessionId)} --user-id snapshot-operator >/tmp/kilo-snapshot-smoke.err 2>&1 &
pid=$!
trap cleanup EXIT
for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:5099/health > /tmp/kilo-snapshot-health.json; then break; fi
  if ! kill -0 "$pid" 2>/dev/null; then dump_wrapper; exit 1; fi
  sleep 1
done
if [ ! -s /tmp/kilo-snapshot-health.json ]; then dump_wrapper; exit 1; fi
jq -e --arg version ${shellQuote(manifest.wrapperVersion)} '.version == $version' /tmp/kilo-snapshot-health.json >/dev/null`;
  await execute(config, sessionId, 'bash', ['-lc', script], {
    timeoutMs: 90_000,
    label: 'smoke wrapper',
  });
}

async function runLocal(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out`));
    }, DEFAULT_TIMEOUT_MS);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(new Error(`${command} failed to start: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed (${signal ?? `exit ${code ?? 'unknown'}`})`));
    });
  });
}

async function readExpectedManifest(args: Args): Promise<RuntimeManifest> {
  const input = resolveSnapshotInputs(args);
  const wrapperBytes = await readFile(input.wrapperPath);
  return createRuntimeManifest({
    runtimeBuildId: input.runtimeBuildId,
    wrapperVersion: input.wrapperVersion,
    wrapperBytes,
  });
}

async function validateChild(
  config: ProviderConfig,
  snapshotId: string,
  expected: RuntimeManifest,
  timeoutMs: number
): Promise<void> {
  const target = await createSandbox(
    config,
    `ses-snapshot-validate-${randomUUID()}`,
    timeoutMs,
    snapshotId
  );
  try {
    const raw = await readRemoteFile(config, target.sessionId, SNAPSHOT_MANIFEST_PATH);
    let manifest: unknown;
    try {
      manifest = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new Error('runtime manifest is invalid JSON');
    }
    const errors = validateRuntimeManifest(manifest, expected);
    if (errors.length) throw new Error(`runtime manifest validation failed: ${errors.join(', ')}`);
    await execute(config, target.sessionId, 'bash', [
      '-lc',
      `test "$(bun --version)" = ${shellQuote(expected.bunVersion)} && test "$(sha256sum ${SNAPSHOT_WRAPPER_PATH} | cut -d' ' -f1)" = ${shellQuote(expected.wrapperSha256)} && test -f ${SNAPSHOT_CONTROL_WRAPPER_PATH} && git --version >/dev/null && kilo --version >/dev/null`,
    ]);
    await smokeWrapper(config, target.sessionId, expected);
    await scanRemote(config, target.sessionId);
  } finally {
    await stopSession(config, target).catch(error => {
      const message = error instanceof Error ? error.message : 'unknown failure';
      log(`failed to stop ${target.sandboxName}: ${message}`);
    });
  }
}

async function buildSnapshot(args: Args): Promise<void> {
  const config = providerConfig(args);
  const { wrapperPath, controlWrapperPath } = resolveSnapshotInputs(args);
  if (args['skip-wrapper-build'] !== true) {
    log('building wrapper bundle');
    await runLocal('bun', ['run', 'build'], dirname(dirname(wrapperPath)));
  }
  const expected = await readExpectedManifest(args);
  const timeoutMs = optionalNumber(args, 'timeout-ms', DEFAULT_TIMEOUT_MS);
  const wrapper = await readFile(wrapperPath);
  const controlWrapper = await readFile(controlWrapperPath);
  await withTrackedSessions(config, async () => {
    const builder = await createSandbox(config, `ses-snapshot-builder-${randomUUID()}`, timeoutMs);
    await installBuilder(config, builder.sessionId);
    const stagedWrapperPath = `/tmp/${basename(SNAPSHOT_WRAPPER_PATH)}`;
    const stagedControlWrapperPath = `/tmp/${basename(SNAPSHOT_CONTROL_WRAPPER_PATH)}`;
    const stagedManifestPath = `/tmp/${basename(SNAPSHOT_MANIFEST_PATH)}`;
    log('uploading wrapper, control wrapper, and runtime manifest');
    await writeRemoteFile(config, builder.sessionId, '/tmp', basename(stagedWrapperPath), wrapper);
    await writeRemoteFile(
      config,
      builder.sessionId,
      '/tmp',
      basename(stagedControlWrapperPath),
      controlWrapper
    );
    await writeRemoteFile(
      config,
      builder.sessionId,
      '/tmp',
      basename(stagedManifestPath),
      new TextEncoder().encode(`${JSON.stringify(expected, null, 2)}\n`)
    );
    await execute(
      config,
      builder.sessionId,
      'bash',
      [
        '-lc',
        `sudo install -m 0755 ${shellQuote(stagedWrapperPath)} ${shellQuote(SNAPSHOT_WRAPPER_PATH)} && sudo install -m 0755 ${shellQuote(stagedControlWrapperPath)} ${shellQuote(SNAPSHOT_CONTROL_WRAPPER_PATH)} && sudo install -m 0644 ${shellQuote(stagedManifestPath)} ${shellQuote(SNAPSHOT_MANIFEST_PATH)} && rm -f ${shellQuote(stagedWrapperPath)} ${shellQuote(stagedControlWrapperPath)} ${shellQuote(stagedManifestPath)}`,
      ],
      { label: 'install wrappers and manifest' }
    );
    log('smoking wrapper');
    await smokeWrapper(config, builder.sessionId, expected);
    log('scanning builder for leftover credentials/state');
    await scanRemote(config, builder.sessionId);
    log('creating snapshot');
    const snapshotId = await createSnapshot(config, builder.sessionId);
    log(`snapshot ${snapshotId}`);
    await stopSession(config, builder);
    await inspectSnapshot(config, snapshotId);
    log('validating child from snapshot');
    await validateChild(config, snapshotId, expected, timeoutMs);
    const accepted = createAcceptedConfig(snapshotId, expected);
    if (typeof args.output === 'string')
      await writeFile(resolve(args.output), `${JSON.stringify(accepted, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(accepted)}\n`);
  });
}

async function validateSnapshot(args: Args): Promise<void> {
  const config = providerConfig(args);
  await withTrackedSessions(config, async () => {
    const expected = await readExpectedManifest(args);
    const snapshotId = requiredArg(args, 'snapshot-id');
    await inspectSnapshot(config, snapshotId);
    await validateChild(
      config,
      snapshotId,
      expected,
      optionalNumber(args, 'timeout-ms', DEFAULT_TIMEOUT_MS)
    );
    process.stdout.write(`${JSON.stringify(createAcceptedConfig(snapshotId, expected))}\n`);
  });
}

async function checkSnapshot(args: Args): Promise<void> {
  const config = providerConfig(args);
  const snapshotId = requiredArg(args, 'snapshot-id');
  const snapshot = await inspectSnapshot(config, snapshotId);
  process.stdout.write(
    `${JSON.stringify({ snapshotId, available: true, expiresAt: snapshot.expiresAt ?? null, lastUsedAt: snapshot.lastUsedAt ?? null })}\n`
  );
}

async function stopNamedSession(args: Args): Promise<void> {
  const config = providerConfig(args);
  const sessionId = requiredArg(args, 'session-id');
  const sandboxName = requiredArg(args, 'sandbox-name');
  await stopSession(config, { sandboxName, sessionId });
  process.stdout.write(`${JSON.stringify({ stopped: true, sandboxName, sessionId })}\n`);
}

async function acceptance(args: Args): Promise<void> {
  const config = providerConfig(args);
  await withTrackedSessions(config, async () => {
    const expected = await readExpectedManifest(args);
    const snapshotId = requiredArg(args, 'snapshot-id');
    const timeoutMs = optionalNumber(args, 'timeout-ms', DEFAULT_TIMEOUT_MS);
    await inspectSnapshot(config, snapshotId);
    await validateChild(config, snapshotId, expected, timeoutMs);
    const snapshotsBefore = await listSnapshotIds(config);
    const target = await createSandbox(
      config,
      `ses-snapshot-accept-${randomUUID()}`,
      timeoutMs,
      snapshotId
    );
    const results: Record<string, 'pass' | 'external'> = {
      snapshotValidation: 'pass',
      create: 'pass',
      command: 'pass',
      wrapperBootstrap: 'pass',
      keepalive: 'pass',
      stop: 'pass',
      noAutomaticSnapshot: 'pass',
      workspace: 'external',
      delivery: 'external',
      networking: 'external',
      activeLoss: 'external',
      cloudflareRegression: 'external',
    };
    await execute(config, target.sessionId, 'bash', [
      '-lc',
      'case "$(node --version)" in v24.*) ;; *) echo "unexpected node $(node --version)" >&2; exit 1 ;; esac',
    ]);
    await extendSession(config, target, 60_000);
    await stopSession(config, target);
    await inspectSnapshot(config, snapshotId);
    const snapshotsAfter = await listSnapshotIds(config);
    const unexpectedSnapshots = [...snapshotsAfter].filter(id => !snapshotsBefore.has(id));
    if (unexpectedSnapshots.length)
      throw new Error('non-persistent session created an unexpected snapshot');
    process.stdout.write(
      `${JSON.stringify({ acceptedConfig: createAcceptedConfig(snapshotId, expected), results })}\n`
    );
  });
}

function printHelp(): void {
  process.stdout.write(`Vercel credential-free base snapshot operator harness

Usage:
  pnpm --filter cloud-agent-next snapshot:vercel <command> [options]

Commands:
  build       Build wrapper assets into a clean builder, scan, snapshot, and validate a child
  validate    Validate an existing snapshot through a disposable non-persistent child
  check       Check snapshot availability and retention metadata
  stop        Stop one leftover session by exact session ID
  acceptance Run the provider-level acceptance matrix and report external Worker-only rows
  help        Show this help

Live commands require VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID.
These may come from the environment, services/cloud-agent-next/.dev.vars, or:
  --team-id <id> --project-id <id>

Build/validate/acceptance arguments:
  --snapshot-id <id>       Required except for build
  --build-id <id>          Defaults to local-YYYYMMDD-HHMMSS
  --wrapper <path>         Defaults to wrapper/dist/wrapper.js
  --control-wrapper <path> Defaults to wrapper/dist/control-wrapper.js
  --wrapper-version <semver> Defaults to the current WRAPPER_VERSION
  --timeout-ms <ms>        Optional bounded sandbox timeout (default ${DEFAULT_TIMEOUT_MS})
  --skip-wrapper-build     Build only: use the existing wrapper bundle
  --output <path>          Build only: write accepted config JSON
  --session-id <id>        Stop only: exact Vercel session ID
  --sandbox-name <name>    Stop only: exact sandbox name used to create it

Activation and rollback:
  1. Deploy code with VERCEL_SANDBOX_ORG_IDS empty.
  2. Verify no deployed version-1 Vercel tombstones exist.
  3. Build and accept the snapshot.
  4. Configure accepted runtime values and one allowlisted organization.
  5. Enable enrollment.
  6. During an incident, disable enrollment first.
  7. Disabling enrollment prevents new Vercel selection but does not stop already-pinned sessions.
  8. Do not roll code back past version-2 tombstone support until live Vercel sessions and version-2 tombstones are drained or remediated.

The harness never prints provider response bodies or tokens. Failed remote commands print redacted stdout/stderr.
It never sends DELETE for a named sandbox. Every created session is stopped by exact session ID, including after snapshot and on SIGINT/SIGTERM.
`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  loadLocalDevVars();
  assertNoSecretArgs(argv);
  const { command, args } = parseArgs(argv);
  if (command === 'help' || command === '--help' || command === '-h') return printHelp();
  if (command === 'build') return buildSnapshot(args);
  if (command === 'validate') return validateSnapshot(args);
  if (command === 'check') return checkSnapshot(args);
  if (command === 'stop') return stopNamedSession(args);
  if (command === 'acceptance') return acceptance(args);
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : 'unknown failure';
    process.stderr.write(`snapshot operator failed: ${message}\n`);
    process.exitCode = 1;
  });
}
