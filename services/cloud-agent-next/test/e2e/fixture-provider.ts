/**
 * Cloud fixture provider for K1's IDE-neutral end-to-end contract.
 *
 * Protocol invocation (what the K1 coordinator uses):
 *
 *   tsx test/e2e/fixture-provider.ts prepare --request <path> --result <path>
 *   tsx test/e2e/fixture-provider.ts cleanup --request <path> --result <path>
 *
 * Local operator commands:
 *
 *   tsx test/e2e/fixture-provider.ts prepare-lanes --run-id <id> --out <dir> [--git-url <url>]
 *   tsx test/e2e/fixture-provider.ts cleanup --descriptor <path> [--remove-descriptor]
 *   tsx test/e2e/fixture-provider.ts observe --descriptor <path> [--tag <tag>]
 *   tsx test/e2e/fixture-provider.ts gate --descriptor <path> --tag <tag> [--wait-ms <n>]
 *   tsx test/e2e/fixture-provider.ts release --descriptor <path> --tag <tag>
 *   tsx test/e2e/fixture-provider.ts directives --descriptor <path> [--token <token>]
 *
 * Credentials never appear on argv or in stdout: the descriptor is written 0600
 * and the protocol results contain no secrets.
 */

import { randomBytes } from 'node:crypto';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  type CleanupResult,
  FixtureDescriptor,
  FixtureProviderError,
  PreparedLanes,
  ProviderCleanupRequest,
  ProviderPrepareRequest,
  ProviderPrepareResult,
  PROVIDER_ID,
  PROVIDER_VERSION,
  SCHEMA_VERSION,
  assertLoopbackOrigins,
  assertSafeRunId,
  assertScopedTag,
  describeError,
  emptyCleanup,
  failedCleanup,
  parseFixtureDescriptor,
  parseProviderRequest,
  readRestrictedJson,
  redactText,
  writeRestrictedJson,
  type Lane,
} from './fixture-contract.js';
import {
  FAKE_MODEL,
  createCloudResources,
  profileOwnership,
  scopedDirective,
  workspaceOwnership,
  type FixtureCloud,
  type HostedResources,
  type OwnedIds,
  type ResourceState,
  type RunIdentity,
} from './fixture-resources.js';
import { discoverLocalStack } from './fixture-stack.js';
import { resolveFakeAdminToken } from './fake-llm-admin.js';

export const DEFAULT_GIT_URL = 'https://github.com/octocat/Hello-World.git';

export type PrepareInput = {
  request: ProviderPrepareRequest;
  cloud: FixtureCloud;
  gitUrl?: string;
  now?: () => Date;
};

export type CleanupInput = {
  request: ProviderCleanupRequest;
  descriptor: FixtureDescriptor | undefined;
  cloud: FixtureCloud;
};

export function scopeForRun(runId: string): string {
  return `kilo-e2e-${runId}`;
}

/**
 * `session.open` proves the IDE can render a stored transcript, so its workspace
 * is seeded. `prompt.stream` must start empty so the submitted prompt is turn 1.
 * An unscoped operator prepare keeps the previous seeded default.
 */
export function seedPromptForScenario(input: {
  scenarioId: ProviderPrepareRequest['scenarioId'];
  scope: string;
}): string | undefined {
  if (input.scenarioId === 'prompt.stream') return undefined;
  return scopedDirective(input.scope, 'idle');
}

export function resolveGitUrl(input: {
  lane: Lane;
  projectDir: string;
  gitUrl: string | undefined;
}): string {
  if (input.lane === 'local') return `file://${input.projectDir}`;
  const value = input.gitUrl ?? process.env.E2E_GIT_URL ?? DEFAULT_GIT_URL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new FixtureProviderError('invalid_request', `git URL ${value} is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FixtureProviderError(
      'invalid_request',
      `Cloud lane requires a clonable http(s) git URL, got ${value}`
    );
  }
  return value;
}

export function buildDescriptor(input: {
  request: ProviderPrepareRequest;
  cloud: FixtureCloud;
  token: string;
  cleanupToken: string;
  gitUrl: string;
  hosted?: HostedResources;
  profileId?: string;
  now: Date;
}): FixtureDescriptor {
  const stack = input.cloud.stack;
  const origins = {
    web: stack.web,
    cloudAgent: stack.worker,
    gateway: `${stack.gateway}/api/v1`,
    fakeLlm: stack.fake,
    ...(stack.sessionIngest === undefined ? {} : { sessionIngest: stack.sessionIngest }),
    ...(stack.events === undefined ? {} : { events: stack.events }),
  };
  assertLoopbackOrigins(origins);
  const resources =
    input.hosted === undefined
      ? {}
      : {
          ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
          workspaceId: input.hosted.workspaceId,
          cloudSessionId: input.hosted.cloudAgentSessionId,
          nativeSessionId: input.hosted.kiloSessionId,
        };
  const ids = [
    ...(input.profileId === undefined ? [] : [{ kind: 'profile', id: input.profileId }]),
    ...(input.hosted === undefined
      ? []
      : [
          { kind: 'workspace', id: input.hosted.workspaceId },
          { kind: 'cloud-session', id: input.hosted.cloudAgentSessionId },
          { kind: 'native-session', id: input.hosted.kiloSessionId },
        ]),
    { kind: 'fake-llm-scope', id: input.request.fakeLlmScope },
  ];
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: input.request.runId,
    lane: input.request.lane,
    createdAt: input.now.toISOString(),
    fakeLlmScope: input.request.fakeLlmScope,
    origins,
    credentials: { apiKey: input.token },
    project: {
      fixture: 'deterministic-git',
      gitUrl: input.gitUrl,
      branch: 'main',
      model: FAKE_MODEL,
      seed: `kilo-e2e-${input.request.runId}`,
    },
    resources,
    cleanup: { token: input.cleanupToken, ids },
    state: input.request.state,
  };
}

export async function prepareFixture(input: PrepareInput): Promise<FixtureDescriptor> {
  const { request } = input;
  assertSafeRunId(request.runId);
  const scope = scopeForRun(request.runId);
  if (request.fakeLlmScope !== scope) {
    throw new FixtureProviderError(
      'scope',
      `provider request scope ${request.fakeLlmScope} does not match run scope ${scope}`
    );
  }
  const gitUrl = resolveGitUrl({
    lane: request.lane,
    projectDir: request.projectDir,
    gitUrl: input.gitUrl,
  });
  const identity = await input.cloud.identity(request.runId);
  const cleanupToken = randomBytes(24).toString('hex');
  const seedPrompt = seedPromptForScenario({
    scenarioId: request.scenarioId,
    scope: request.fakeLlmScope,
  });
  let profileId: string | undefined;
  let hosted: HostedResources | undefined;
  try {
    if (request.lane === 'cloud') {
      profileId = await input.cloud.createProfile({
        runId: request.runId,
        identity,
        cleanupToken,
      });
      hosted = await input.cloud.createWorkspace({
        identity,
        profileId,
        gitUrl,
        scope: request.fakeLlmScope,
        ...(seedPrompt === undefined ? {} : { seedPrompt }),
      });
    }
    const descriptor = buildDescriptor({
      request,
      cloud: input.cloud,
      token: identity.apiKey,
      cleanupToken,
      gitUrl,
      ...(hosted === undefined ? {} : { hosted }),
      ...(profileId === undefined ? {} : { profileId }),
      now: (input.now ?? (() => new Date()))(),
    });
    await writeRestrictedJson(request.descriptorPath, descriptor);
    return descriptor;
  } catch (error) {
    await recover({ identity, request, profileId, hosted, cloud: input.cloud });
    throw error;
  }
}

async function recover(input: {
  identity: RunIdentity;
  request: ProviderPrepareRequest;
  profileId?: string;
  hosted?: HostedResources;
  cloud: FixtureCloud;
}): Promise<void> {
  try {
    const state = await input.cloud.inspect({
      ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
      ...(input.hosted === undefined
        ? {}
        : {
            workspaceId: input.hosted.workspaceId,
            cloudSessionId: input.hosted.cloudAgentSessionId,
          }),
    });
    let workspaceGone = true;
    if (input.hosted !== undefined && state.worktree !== null) {
      if (state.worktree.deletionCompletedAt !== null) {
        workspaceGone = true;
      } else {
        const verdict = workspaceOwnership(state, {
          userId: input.identity.user.id,
          profileId: input.profileId,
        });
        if (verdict.owned) {
          await input.cloud.deleteWorkspace(input.hosted.workspaceId, input.identity);
          workspaceGone = await input.cloud.waitWorkspaceGone(input.hosted.workspaceId);
        } else {
          workspaceGone = false;
        }
      }
    }
    // Keep the ownership marker while an owned workspace may still exist so a
    // retry can verify it against the profile.
    if (input.profileId !== undefined && state.profile !== null && workspaceGone) {
      await input.cloud.deleteProfile(input.profileId, input.identity.user.id);
    }
  } catch {
    // Prepare already failed; recovery is best effort and never hides the cause.
  }
}

export async function cleanupFixture(input: CleanupInput): Promise<CleanupResult> {
  const { request, descriptor, cloud } = input;
  if (!request.descriptorPresent || descriptor === undefined) {
    return emptyCleanup(request.runId);
  }
  if (descriptor.runId !== request.runId) {
    return failedCleanup(request.runId, {
      error: 'fixture descriptor run id does not match the cleanup request',
    });
  }
  const runId = request.runId;
  const scope = descriptor.fakeLlmScope;
  const removed: CleanupResult['removed'] = [];
  const leftovers: CleanupResult['leftovers'] = [];

  try {
    const tags = (await cloud.listWaiters()).filter(
      tag => tag === scope || tag.startsWith(`${scope}-`)
    );
    for (const tag of tags) {
      await cloud.releaseGate(tag);
      removed.push({ kind: 'fake-llm-gate', id: tag });
    }
  } catch (error) {
    leftovers.push({ kind: 'fake-llm-scope', id: scope, reason: describeError(error) });
  }

  const ids: OwnedIds = {
    ...(descriptor.resources.profileId === undefined
      ? {}
      : { profileId: descriptor.resources.profileId }),
    ...(descriptor.resources.workspaceId === undefined
      ? {}
      : { workspaceId: descriptor.resources.workspaceId }),
    ...(descriptor.resources.cloudSessionId === undefined
      ? {}
      : { cloudSessionId: descriptor.resources.cloudSessionId }),
  };

  const state = await inspectOwned({ cloud, ids, runId, leftovers });
  if (state !== undefined) {
    const identity = await identityFor({ cloud, runId, leftovers });
    if (identity !== undefined) {
      await removeWorkspace({
        cloud,
        identity,
        descriptor,
        state,
        removed,
        leftovers,
      });
      // Keep the owned profile while the owned workspace still exists so a
      // retry can still verify the workspace/session/profile identity.
      const workspaceBlocked =
        descriptor.resources.workspaceId !== undefined &&
        leftovers.some(leftover => leftover.kind === 'workspace');
      if (workspaceBlocked) {
        if (descriptor.resources.profileId !== undefined) {
          leftovers.push({
            kind: 'profile',
            id: descriptor.resources.profileId,
            reason: 'profile retained until the owned workspace is removed',
          });
        }
      } else {
        await removeProfile({
          cloud,
          identity,
          descriptor,
          state,
          removed,
          leftovers,
        });
      }
    }
  }

  if (leftovers.length > 0) {
    return failedCleanup(runId, {
      removed,
      leftovers,
      error: leftovers[0]?.reason ?? 'fixture cleanup left owned resources',
    });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    status: 'clean',
    removed,
    leftovers: [],
  };
}

async function inspectOwned(input: {
  cloud: FixtureCloud;
  ids: OwnedIds;
  runId: string;
  leftovers: CleanupResult['leftovers'];
}): Promise<ResourceState | undefined> {
  try {
    return await input.cloud.inspect(input.ids);
  } catch (error) {
    input.leftovers.push({ kind: 'resources', id: input.runId, reason: describeError(error) });
    return undefined;
  }
}

async function identityFor(input: {
  cloud: FixtureCloud;
  runId: string;
  leftovers: CleanupResult['leftovers'];
}): Promise<RunIdentity | undefined> {
  try {
    return await input.cloud.identity(input.runId);
  } catch (error) {
    input.leftovers.push({ kind: 'local-user', id: input.runId, reason: describeError(error) });
    return undefined;
  }
}

async function removeProfile(input: {
  cloud: FixtureCloud;
  identity: RunIdentity;
  descriptor: FixtureDescriptor;
  state: ResourceState;
  removed: CleanupResult['removed'];
  leftovers: CleanupResult['leftovers'];
}): Promise<void> {
  const profileId = input.descriptor.resources.profileId;
  if (profileId === undefined) return;
  const verdict = profileOwnership(input.state, {
    userId: input.identity.user.id,
    runId: input.descriptor.runId,
    token: input.descriptor.cleanup.token,
  });
  if (!verdict.owned) {
    input.leftovers.push({
      kind: 'profile',
      id: profileId,
      reason: verdict.reason ?? 'profile is not owned by this run',
    });
    return;
  }
  if (input.state.profile === null) {
    input.removed.push({ kind: 'profile', id: profileId });
    return;
  }
  try {
    await input.cloud.deleteProfile(profileId, input.identity.user.id);
    input.removed.push({ kind: 'profile', id: profileId });
  } catch (error) {
    input.leftovers.push({ kind: 'profile', id: profileId, reason: describeError(error) });
  }
}

async function removeWorkspace(input: {
  cloud: FixtureCloud;
  identity: RunIdentity;
  descriptor: FixtureDescriptor;
  state: ResourceState;
  removed: CleanupResult['removed'];
  leftovers: CleanupResult['leftovers'];
}): Promise<void> {
  const workspaceId = input.descriptor.resources.workspaceId;
  if (workspaceId === undefined) return;
  const verdict = workspaceOwnership(input.state, {
    userId: input.identity.user.id,
    profileId: input.descriptor.resources.profileId,
  });
  const removedWorkspaceId = workspaceId;
  const recordRemoved = (): void => {
    input.removed.push({ kind: 'workspace', id: removedWorkspaceId });
    if (input.descriptor.resources.cloudSessionId !== undefined) {
      input.removed.push({
        kind: 'cloud-session',
        id: input.descriptor.resources.cloudSessionId,
      });
    }
    if (input.descriptor.resources.nativeSessionId !== undefined) {
      input.removed.push({
        kind: 'native-session',
        id: input.descriptor.resources.nativeSessionId,
      });
    }
  };
  if (!verdict.owned) {
    input.leftovers.push({
      kind: 'workspace',
      id: workspaceId,
      reason: verdict.reason ?? 'workspace is not owned by this run',
    });
    return;
  }
  if (input.state.worktree === null || input.state.worktree.deletionCompletedAt !== null) {
    recordRemoved();
    return;
  }
  try {
    await input.cloud.deleteWorkspace(workspaceId, input.identity);
    if (await input.cloud.waitWorkspaceGone(workspaceId)) {
      recordRemoved();
    } else {
      input.leftovers.push({
        kind: 'workspace',
        id: workspaceId,
        reason: 'workspace deletion did not complete before the cleanup deadline',
      });
    }
  } catch (error) {
    input.leftovers.push({ kind: 'workspace', id: workspaceId, reason: describeError(error) });
  }
}

export function directiveTemplates(input: {
  runId: string;
  token?: string;
}): Record<'open' | 'stream' | 'permission', string> {
  const scope = scopeForRun(input.runId);
  const token = input.token ?? '<token>';
  return {
    open: scopedDirective(scope, 'idle'),
    stream: scopedDirective(scope, `echo:${token}`),
    permission: scopedDirective(scope, `file:write:${scope}-permission:fixture.txt:${token}`),
  };
}

function usage(message: string): never {
  throw new FixtureProviderError('usage', message);
}

type Flags = Record<string, string | boolean>;

function parseFlags(argv: string[], allowed: readonly string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) usage(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (!allowed.includes(name)) usage(`unknown flag: ${arg}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }
  return flags;
}

function requiredString(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.length === 0) usage(`--${name} is required`);
  return value;
}

async function protocolPrepare(flags: Flags): Promise<void> {
  const requestPath = requiredString(flags, 'request');
  const resultPath = requiredString(flags, 'result');
  const request = parseProviderRequest(
    await readRestrictedJson(requestPath, ProviderPrepareRequest, 'provider request')
  );
  if (request.operation !== 'prepare') usage('prepare requires a prepare request document');
  const cloud = await openCloud();
  try {
    await prepareFixture({
      request,
      cloud,
      ...(typeof flags['git-url'] === 'string' ? { gitUrl: flags['git-url'] } : {}),
    });
    await writeRestrictedJson(
      resultPath,
      ProviderPrepareResult.parse({
        schemaVersion: SCHEMA_VERSION,
        operation: 'prepare',
        runId: request.runId,
        descriptorPath: request.descriptorPath,
        provider: { id: PROVIDER_ID, version: PROVIDER_VERSION },
      })
    );
  } finally {
    await cloud.close();
  }
}

async function protocolCleanup(flags: Flags): Promise<void> {
  const requestPath = requiredString(flags, 'request');
  const resultPath = requiredString(flags, 'result');
  const request = parseProviderRequest(
    await readRestrictedJson(requestPath, ProviderCleanupRequest, 'provider request')
  );
  if (request.operation !== 'cleanup') usage('cleanup requires a cleanup request document');
  const cloud = await openCloud();
  try {
    const descriptor = request.descriptorPresent
      ? await readPrivateDescriptor(request.descriptorPath)
      : undefined;
    const result = await cleanupFixture({ request, descriptor, cloud });
    await writeRestrictedJson(resultPath, result);
  } finally {
    await cloud.close();
  }
}

async function standaloneCleanup(flags: Flags): Promise<void> {
  const descriptorPath = requiredString(flags, 'descriptor');
  const descriptor = await readOptionalDescriptor(descriptorPath);
  const cloud = await openCloud();
  try {
    const request: ProviderCleanupRequest = {
      schemaVersion: SCHEMA_VERSION,
      operation: 'cleanup',
      runId: descriptor?.runId ?? path.basename(descriptorPath, '.json'),
      descriptorPath,
      descriptorPresent: descriptor !== undefined,
    };
    const result = await cleanupFixture({ request, descriptor, cloud });
    if (result.status === 'clean' && flags['remove-descriptor'] === true) {
      await rm(descriptorPath, { force: true });
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'clean') process.exitCode = 1;
  } finally {
    await cloud.close();
  }
}

async function readOptionalDescriptor(
  descriptorPath: string
): Promise<FixtureDescriptor | undefined> {
  try {
    await access(descriptorPath);
  } catch {
    return undefined;
  }
  return readPrivateDescriptor(descriptorPath);
}

async function prepareLanes(flags: Flags): Promise<void> {
  const runId = requiredString(flags, 'run-id');
  const out = requiredString(flags, 'out');
  assertSafeRunId(runId);
  const scope = scopeForRun(runId);
  const lanes: Lane[] =
    typeof flags.lane === 'string' ? [parseLane(flags.lane)] : ['local', 'cloud'];
  const gitUrl =
    typeof flags['git-url'] === 'string'
      ? flags['git-url']
      : (process.env.E2E_GIT_URL ?? DEFAULT_GIT_URL);
  const cloud = await openCloud();
  const prepared: { lane: Lane; descriptorPath: string; descriptor: FixtureDescriptor }[] = [];
  try {
    for (const lane of lanes) {
      const descriptorPath = path.join(out, `${runId}-${lane}.json`);
      const request: ProviderPrepareRequest = {
        schemaVersion: SCHEMA_VERSION,
        operation: 'prepare',
        runId,
        lane,
        fakeLlmScope: scope,
        descriptorPath,
        projectDir: path.join(out, `${runId}-${lane}-project`),
        state: {
          data: path.join(out, `${runId}-${lane}-state`, 'data'),
          config: path.join(out, `${runId}-${lane}-state`, 'config'),
          state: path.join(out, `${runId}-${lane}-state`, 'state'),
          cache: path.join(out, `${runId}-${lane}-state`, 'cache'),
        },
      };
      const descriptor = await prepareFixture({ request, cloud, gitUrl });
      prepared.push({ lane, descriptorPath, descriptor });
    }
    const summary = PreparedLanes.parse({
      schemaVersion: SCHEMA_VERSION,
      runId,
      fakeLlmScope: scope,
      provider: { id: PROVIDER_ID, version: PROVIDER_VERSION },
      lanes: prepared.map(entry => ({ lane: entry.lane, descriptorPath: entry.descriptorPath })),
    });
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    for (const entry of prepared) {
      await cleanupFixture({
        request: {
          schemaVersion: SCHEMA_VERSION,
          operation: 'cleanup',
          runId,
          descriptorPath: entry.descriptorPath,
          descriptorPresent: true,
        },
        descriptor: entry.descriptor,
        cloud,
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await cloud.close();
  }
}

function parseLane(value: string): Lane {
  if (value === 'local' || value === 'cloud') return value;
  usage(`invalid --lane ${value} (expected local or cloud)`);
}

async function observe(flags: Flags): Promise<void> {
  const descriptor = await readPrivateDescriptor(requiredString(flags, 'descriptor'));
  const tag = typeof flags.tag === 'string' ? flags.tag : undefined;
  if (tag !== undefined) assertScopedTag(descriptor.fakeLlmScope, tag);
  const base = descriptor.origins.fakeLlm.replace(/\/$/, '');
  const requests = await fetch(
    `${base}/test/requests?scope=${encodeURIComponent(descriptor.fakeLlmScope)}`,
    { headers: fakeAdminHeaders(), signal: AbortSignal.timeout(10_000) }
  );
  if (!requests.ok) {
    throw new FixtureProviderError(
      'protocol',
      `fake-LLM observation failed: HTTP ${requests.status}`
    );
  }
  const counts = (await requests.json()) as { chatCompletions?: unknown };
  const observation: Record<string, unknown> = {
    schemaVersion: 1,
    runId: descriptor.runId,
    lane: descriptor.lane,
    scope: descriptor.fakeLlmScope,
    chatCompletions: typeof counts.chatCompletions === 'number' ? counts.chatCompletions : 0,
  };
  if (tag !== undefined) {
    const status = await fetch(`${base}/test/gate-status?tag=${encodeURIComponent(tag)}`, {
      headers: fakeAdminHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!status.ok) {
      throw new FixtureProviderError(
        'protocol',
        `fake-LLM gate observation failed: HTTP ${status.status}`
      );
    }
    const body = (await status.json()) as { engaged?: unknown };
    observation.gate = { tag, engaged: body.engaged === true };
  }
  console.log(JSON.stringify(observation, null, 2));
}

async function gate(flags: Flags): Promise<void> {
  const descriptor = await readPrivateDescriptor(requiredString(flags, 'descriptor'));
  const tag = requiredString(flags, 'tag');
  assertScopedTag(descriptor.fakeLlmScope, tag);
  const waitMs = typeof flags['wait-ms'] === 'string' ? Number(flags['wait-ms']) : 120_000;
  if (!Number.isFinite(waitMs) || waitMs < 0) usage('--wait-ms must be a non-negative number');
  const base = descriptor.origins.fakeLlm.replace(/\/$/, '');
  const deadline = Date.now() + waitMs;
  let engaged = false;
  while (Date.now() < deadline) {
    const status = await fetch(`${base}/test/gate-status?tag=${encodeURIComponent(tag)}`, {
      headers: fakeAdminHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (status.ok) {
      const body = (await status.json()) as { engaged?: unknown };
      if (body.engaged === true) {
        engaged = true;
        break;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  console.log(JSON.stringify({ tag, engaged }, null, 2));
  if (!engaged) process.exitCode = 1;
}

async function release(flags: Flags): Promise<void> {
  const descriptor = await readPrivateDescriptor(requiredString(flags, 'descriptor'));
  const tag = requiredString(flags, 'tag');
  assertScopedTag(descriptor.fakeLlmScope, tag);
  const base = descriptor.origins.fakeLlm.replace(/\/$/, '');
  const response = await fetch(`${base}/test/release?tag=${encodeURIComponent(tag)}`, {
    method: 'POST',
    headers: fakeAdminHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok && response.status !== 404) {
    throw new FixtureProviderError(
      'protocol',
      `fake-LLM gate release failed: HTTP ${response.status}`
    );
  }
  console.log(JSON.stringify({ tag, released: true }, null, 2));
}

async function directives(flags: Flags): Promise<void> {
  const descriptor = await readPrivateDescriptor(requiredString(flags, 'descriptor'));
  const token = typeof flags.token === 'string' ? flags.token : undefined;
  console.log(
    JSON.stringify(
      directiveTemplates({ runId: descriptor.runId, ...(token === undefined ? {} : { token }) }),
      null,
      2
    )
  );
}

function fakeAdminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${resolveFakeAdminToken()}` };
}

async function readPrivateDescriptor(file: string): Promise<FixtureDescriptor> {
  return parseFixtureDescriptor(
    await readRestrictedJson(file, FixtureDescriptor, 'fixture descriptor')
  );
}

async function openCloud(): Promise<FixtureCloud> {
  const stack = await discoverLocalStack();
  return createCloudResources({ stack });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'prepare':
        await protocolPrepare(parseFlags(rest, ['request', 'result', 'git-url']));
        return 0;
      case 'cleanup': {
        const flags = parseFlags(rest, ['request', 'result', 'descriptor', 'remove-descriptor']);
        if (typeof flags.request === 'string') {
          if (typeof flags.descriptor === 'string') {
            usage('cleanup takes either --request/--result or --descriptor');
          }
          await protocolCleanup(flags);
          return 0;
        }
        await standaloneCleanup(flags);
        return process.exitCode === 1 ? 1 : 0;
      }
      case 'prepare-lanes':
        await prepareLanes(parseFlags(rest, ['run-id', 'out', 'git-url', 'lane']));
        return 0;
      case 'observe':
        await observe(parseFlags(rest, ['descriptor', 'tag']));
        return 0;
      case 'gate':
        await gate(parseFlags(rest, ['descriptor', 'tag', 'wait-ms']));
        return process.exitCode === 1 ? 1 : 0;
      case 'release':
        await release(parseFlags(rest, ['descriptor', 'tag']));
        return 0;
      case 'directives':
        await directives(parseFlags(rest, ['descriptor', 'token']));
        return 0;
      default:
        usage(
          'usage: fixture-provider.ts <prepare|cleanup|prepare-lanes|observe|gate|release|directives> [flags]'
        );
    }
  } catch (error) {
    console.error(redactText(describeError(error)));
    return error instanceof FixtureProviderError && error.code === 'usage' ? 2 : 1;
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (invokedDirectly) {
  process.exitCode = await main();
}
