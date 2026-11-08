/**
 * Cloud implementation of K1's versioned fixture-provider protocol.
 *
 * The wire documents mirror `packages/kilo-e2e/schema/*.v1.json` from
 * `Kilo-Org/kilocode` at the merged K1 contract commit
 * (`e4833e5885b45f82115c1014ec003b14f63c7823`, SCHEMA_VERSION 1). Consumers
 * implement the JSON Schema documents; this module is the provider-side parser
 * so a version or shape change fails here instead of half-way through prepare.
 */

import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

export const SCHEMA_VERSION = 1;
export const PROVIDER_ID = 'kilo-cloud-local-fixture';
export const PROVIDER_VERSION = '1';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const LOOPBACK_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

export type FixtureProviderErrorCode =
  | 'usage'
  | 'invalid_request'
  | 'schema_version'
  | 'origin'
  | 'stack_unavailable'
  | 'database_mismatch'
  | 'resource_conflict'
  | 'ownership'
  | 'scope'
  | 'protocol'
  | 'cleanup';

export class FixtureProviderError extends Error {
  constructor(
    readonly code: FixtureProviderErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'FixtureProviderError';
  }
}

export const Lane = z.enum(['local', 'cloud']);
export type Lane = z.infer<typeof Lane>;

export const ScenarioID = z.enum(['session.open', 'prompt.stream', 'permission.continue']);
export type ScenarioID = z.infer<typeof ScenarioID>;

export const Resource = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
});
export type Resource = z.infer<typeof Resource>;

export const StateDirs = z.object({
  data: z.string().min(1),
  config: z.string().min(1),
  state: z.string().min(1),
  cache: z.string().min(1),
});
export type StateDirs = z.infer<typeof StateDirs>;

export const Origins = z.object({
  web: z.string().url(),
  cloudAgent: z.string().url(),
  sessionIngest: z.string().url().optional(),
  events: z.string().url().optional(),
  gateway: z.string().url().optional(),
  fakeLlm: z.string().url(),
});
export type Origins = z.infer<typeof Origins>;

export const FixtureDescriptor = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runId: z.string().min(1),
  lane: Lane,
  createdAt: z.string().datetime(),
  fakeLlmScope: z.string().min(1),
  origins: Origins,
  credentials: z.object({
    apiKey: z.string().min(1),
    orgId: z.string().min(1).optional(),
  }),
  project: z.object({
    fixture: z.literal('deterministic-git'),
    gitUrl: z.string().min(1),
    branch: z.string().min(1),
    model: z.string().min(1),
    seed: z.string().min(1),
  }),
  resources: z.object({
    profileId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    cloudSessionId: z.string().min(1).optional(),
    nativeSessionId: z.string().min(1).optional(),
  }),
  cleanup: z.object({
    token: z.string().min(1),
    ids: z.array(Resource),
  }),
  state: StateDirs,
});
export type FixtureDescriptor = z.infer<typeof FixtureDescriptor>;

export const ProviderPrepareRequest = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  operation: z.literal('prepare'),
  runId: z.string().min(1),
  lane: Lane,
  scenarioId: ScenarioID.optional(),
  fakeLlmScope: z.string().min(1),
  descriptorPath: z.string().min(1),
  projectDir: z.string().min(1),
  state: StateDirs,
});
export type ProviderPrepareRequest = z.infer<typeof ProviderPrepareRequest>;

export const ProviderCleanupRequest = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  operation: z.literal('cleanup'),
  runId: z.string().min(1),
  descriptorPath: z.string().min(1),
  descriptorPresent: z.boolean(),
});
export type ProviderCleanupRequest = z.infer<typeof ProviderCleanupRequest>;

export const ProviderRequest = z.discriminatedUnion('operation', [
  ProviderPrepareRequest,
  ProviderCleanupRequest,
]);
export type ProviderRequest = z.infer<typeof ProviderRequest>;

export const ProviderPrepareResult = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  operation: z.literal('prepare'),
  runId: z.string().min(1),
  descriptorPath: z.string().min(1),
  provider: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
  }),
});
export type ProviderPrepareResult = z.infer<typeof ProviderPrepareResult>;

export const CleanupResult = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runId: z.string().min(1),
  status: z.enum(['clean', 'failed']),
  removed: z.array(Resource),
  leftovers: z.array(
    z.object({
      kind: z.string().min(1),
      id: z.string().min(1),
      reason: z.string().min(1),
    })
  ),
  error: z.string().optional(),
});
export type CleanupResult = z.infer<typeof CleanupResult>;

export const OBSERVATION_SCHEMA_VERSION = 1;

export const FixtureObservation = z.object({
  schemaVersion: z.literal(OBSERVATION_SCHEMA_VERSION),
  runId: z.string().min(1),
  lane: Lane,
  scope: z.string().min(1),
  chatCompletions: z.number().int().nonnegative(),
  gate: z
    .object({
      tag: z.string().min(1),
      engaged: z.boolean(),
    })
    .optional(),
});
export type FixtureObservation = z.infer<typeof FixtureObservation>;

/** A provider lane descriptor and where it was written. */
export const PreparedLane = z.object({
  lane: Lane,
  descriptorPath: z.string().min(1),
});
export type PreparedLane = z.infer<typeof PreparedLane>;

export const PreparedLanes = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runId: z.string().min(1),
  fakeLlmScope: z.string().min(1),
  provider: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
  }),
  lanes: z.array(PreparedLane),
});
export type PreparedLanes = z.infer<typeof PreparedLanes>;

export function isLoopback(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (!LOOPBACK_SCHEMES.has(parsed.protocol)) return false;
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Every descriptor origin is an explicit loopback service. A tunnel, a deployed
 * origin, or a production URL is a configuration error, never a fallback.
 */
export function assertLoopbackOrigins(origins: Origins): void {
  for (const [name, origin] of Object.entries(origins)) {
    if (origin === undefined) continue;
    if (!isLoopback(origin)) {
      throw new FixtureProviderError(
        'origin',
        `origin ${name}=${origin} is not an explicit loopback origin; refusing to write a fixture descriptor`
      );
    }
  }
}

// `scopeForRun` prefixes `kilo-e2e-` (9 characters) and the fake accepts a
// scope token of at most 64 characters, so the run id is capped at 55.
const RUN_ID = /^[A-Za-z0-9_-]{1,55}$/;

export function assertSafeRunId(runId: string): void {
  if (!RUN_ID.test(runId)) {
    throw new FixtureProviderError(
      'invalid_request',
      'run id must be 1-55 characters of letters, digits, underscore, or dash (the fake LLM scope token is capped at 64)'
    );
  }
}

export function assertSchemaVersion(value: { schemaVersion: number }, label: string): void {
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new FixtureProviderError(
      'schema_version',
      `${label} schemaVersion ${String(value.schemaVersion)} is not supported (expected ${SCHEMA_VERSION})`
    );
  }
}

async function restrictMode(target: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(target, mode);
}

export async function ensurePrivateDir(dir: string): Promise<void> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      throw new FixtureProviderError('protocol', `${dir} is not a directory`);
    }
    // A caller-supplied or system directory is never tightened: only
    // directories this helper creates are chmoded to 0700.
    return;
  } catch (error) {
    if (error instanceof FixtureProviderError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await restrictMode(dir, 0o700);
}

export async function writeRestrictedJson(
  file: string,
  value: unknown,
  mode = 0o600
): Promise<void> {
  await ensurePrivateDir(path.dirname(file));
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, data, { mode });
  await restrictMode(temp, mode);
  await rename(temp, file);
}

/**
 * The descriptor carries a short-lived local API key, so cleanup/observe must
 * refuse a descriptor that is group- or world-readable.
 */
export async function assertPrivateFile(file: string, label: string): Promise<void> {
  if (process.platform === 'win32') return;
  const info = await stat(file);
  if ((info.mode & 0o077) !== 0) {
    throw new FixtureProviderError(
      'ownership',
      `${label} ${file} is accessible to other users (mode ${(info.mode & 0o777).toString(8)}); expected 600`
    );
  }
}

export async function readRestrictedJson(
  file: string,
  schema: z.ZodType,
  label: string
): Promise<unknown> {
  await assertPrivateFile(file, label);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new FixtureProviderError(
      'protocol',
      `${label} ${file} could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FixtureProviderError('protocol', `${label} ${file} is not valid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || '$';
    throw new FixtureProviderError(
      'protocol',
      `${label} ${file} does not match schema v${SCHEMA_VERSION}: ${where}: ${issue?.message ?? 'invalid document'}`
    );
  }
  return parsed.data;
}

export function emptyCleanup(runId: string): CleanupResult {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    status: 'clean',
    removed: [],
    leftovers: [],
  };
}

export function failedCleanup(
  runId: string,
  input: { removed?: Resource[]; leftovers?: CleanupResult['leftovers']; error: string }
): CleanupResult {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    status: 'failed',
    removed: input.removed ?? [],
    leftovers: input.leftovers ?? [],
    error: input.error,
  };
}

const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const BEARER = /Bearer\s+[^\s,;]+/gi;

/**
 * Scrub one log/error line before it reaches a terminal or a report. Known
 * secrets are replaced first; JWT/bearer shapes are replaced regardless so an
 * unexpected token shape never survives.
 */
export function redactText(value: string, secrets: readonly (string | undefined)[] = []): string {
  let output = value;
  for (const secret of secrets) {
    if (secret && secret.length > 0) output = output.replaceAll(secret, '[redacted]');
  }
  return output.replace(BEARER, 'Bearer [redacted]').replace(JWT, '[redacted-jwt]');
}

export function describeError(
  error: unknown,
  secrets: readonly (string | undefined)[] = []
): string {
  if (error instanceof FixtureProviderError)
    return redactText(`${error.code}: ${error.message}`, secrets);
  if (error instanceof Error) return redactText(error.message, secrets);
  return redactText(String(error), secrets);
}

export function parseProviderRequest(value: unknown): ProviderRequest {
  const record = z.object({ schemaVersion: z.number() }).safeParse(value);
  if (record.success) assertSchemaVersion(record.data, 'provider request');
  const parsed = ProviderRequest.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FixtureProviderError(
      'protocol',
      `provider request does not match schema v${SCHEMA_VERSION}: ${issue?.path.join('.') || '$'}: ${issue?.message ?? 'invalid document'}`
    );
  }
  return parsed.data;
}

export function parseFixtureDescriptor(value: unknown): FixtureDescriptor {
  const record = z.object({ schemaVersion: z.number() }).safeParse(value);
  if (record.success) assertSchemaVersion(record.data, 'fixture descriptor');
  const parsed = FixtureDescriptor.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FixtureProviderError(
      'protocol',
      `fixture descriptor does not match schema v${SCHEMA_VERSION}: ${issue?.path.join('.') || '$'}: ${issue?.message ?? 'invalid document'}`
    );
  }
  assertLoopbackOrigins(parsed.data.origins);
  return parsed.data;
}

/**
 * A run-scoped fake-LLM tag must be the run scope itself or prefixed by it, so a
 * consumer can never release or observe another run's gate.
 */
export function assertScopedTag(scope: string, tag: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(tag)) {
    throw new FixtureProviderError('scope', `fake-LLM tag "${tag}" is not a valid tag`);
  }
  if (tag !== scope && !tag.startsWith(`${scope}-`)) {
    throw new FixtureProviderError(
      'scope',
      `fake-LLM tag "${tag}" is not scoped to this run (scope "${scope}"); refusing foreign gate access`
    );
  }
}
