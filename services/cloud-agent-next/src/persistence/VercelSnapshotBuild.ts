import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import migrations from '../../drizzle/vercel-snapshot/migrations';
import { vercelSnapshotBuilds } from '../db/vercel-snapshot-schema.js';
import type { Env } from '../types.js';
import {
  ByocCredentialMissingError,
  ByocCredentialResolverError,
  fetchByocVercelCredential,
  projectByocVercelStatus,
  resolveByocVercelAccessConfig,
  type ByocVercelCredential,
} from '../byoc/vercel-credential-resolver.js';
import { getVercelRuntimeArtifacts } from '../byoc/vercel-runtime-artifacts.js';
import {
  VERCEL_CLOUD_AGENT_CREATE_OPERATION_TAG,
  VERCEL_CLOUD_AGENT_RESOURCE_TAG,
  VERCEL_CLOUD_AGENT_RESOURCE_TAG_VALUE,
  VERCEL_CLOUD_AGENT_RUNTIME_BUILD_TAG,
  VercelSandboxRestClient,
  VercelSandboxRestError,
  type CreateSandboxInput,
  type VercelSandboxCommand,
  type VercelSandboxCreateEnvelope,
  type VercelSandboxSnapshot,
} from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import { WRAPPER_VERSION } from '../shared/wrapper-version.js';
import { getSandboxControlStub } from '../sandbox-control/stub.js';
import { generateSandboxCredential, hashSandboxCredential } from '../sandbox-control/credential.js';
import { buildControlWrapperLaunchEnv } from '../sandbox-control/wrapper-launch-env.js';
import { withDORetry } from '../utils/do-retry.js';

const BUILD_ALARM_DELAY_MS = 1_000;
const RETRY_DELAY_MS = [1_000, 5_000, 15_000, 30_000, 60_000] as const;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_RETRIES = RETRY_DELAY_MS.length;
const BUILDER_TIMEOUT_MS = 10 * 60_000;
const SNAPSHOT_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1_000;
const PINNED_BUN_VERSION = '1.3.14';
const PINNED_KILO_VERSION = '7.4.20';

const StartInputSchema = z.object({
  organizationId: z.uuid(),
  credentialId: z.uuid(),
  buildGeneration: z.uuid(),
});

const CleanupInputSchema = StartInputSchema.extend({
  snapshotId: z.string().min(1).optional(),
});

const BuildStepSchema = z.enum([
  'validating_access',
  'create_builder',
  'install_system_dependencies',
  'install_node_dependencies',
  'upload_runtime_artifacts',
  'verify_runtime_artifacts',
  'snapshot_builder',
  'create_validator',
  'launch_validator_wrapper',
  'verify_validator_call_home',
  'stop_validator',
  'confirm_terminal',
]);

type BuildStep = z.infer<typeof BuildStepSchema>;
type BuildDb = ReturnType<typeof drizzle>;
type BuildRow = typeof vercelSnapshotBuilds.$inferSelect;
type BuildOwnership = Pick<BuildRow, 'organization_id' | 'credential_id' | 'build_generation'>;

class SnapshotBuildOwnershipLostError extends Error {
  constructor() {
    super('snapshot_build_ownership_lost');
    this.name = 'SnapshotBuildOwnershipLostError';
  }
}

function now(): number {
  return Date.now();
}

function iso(timestamp: number | null | undefined): string | null {
  return timestamp === null || timestamp === undefined ? null : new Date(timestamp).toISOString();
}

function deterministicName(prefix: string, credentialId: string, runtimeBuildId: string): string {
  const safeCredential = credentialId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 8);
  const safeRuntime = runtimeBuildId.replace(/[^A-Za-z0-9_-]/g, '-').slice(-32);
  return `ses-${prefix}-${safeRuntime}-${safeCredential}`.slice(0, 63);
}

function operationId(prefix: string, generation: string): string {
  return `byoc-${prefix}-${generation}`.slice(0, 256);
}

function controlId(generation: string): string {
  return `ses-byoc-validator-${generation.replace(/-/g, '').slice(0, 32)}`;
}

function requiredBuildField(value: string | null, error: string): string {
  if (!value) throw new Error(error);
  return value;
}

function buildInput(row: BuildRow, source: 'runtime' | 'snapshot') {
  const common = {
    name: row.builder_name,
    operationId: row.builder_operation_id,
    runtimeBuildId: row.runtime_build_id,
    runtime: 'node24' as const,
    timeoutMs: BUILDER_TIMEOUT_MS,
  };
  return source === 'runtime'
    ? { ...common, source: { type: 'runtime' as const } }
    : {
        ...common,
        source: {
          type: 'snapshot' as const,
          snapshotId: requiredBuildField(row.snapshot_id, 'snapshot_result_missing'),
        },
      };
}

function validatorInput(row: BuildRow): CreateSandboxInput {
  return {
    ...buildInput(row, 'snapshot'),
    name: row.validator_name,
    operationId: row.validator_operation_id,
  };
}

function safeError(error: unknown): string {
  if (error instanceof ByocCredentialMissingError) return 'byoc_credential_missing';
  if (error instanceof Error && error.message === 'snapshot_result_ambiguous') {
    return 'snapshot_result_ambiguous';
  }
  if (error instanceof VercelSandboxRestError) {
    if (error.status === 401 || error.status === 403) return 'byoc_vercel_forbidden';
    if (error.status === 429) return 'byoc_vercel_capacity';
    if (error.kind === 'correlation_mismatch') return 'provider_correlation_failed';
    if (error.kind === 'invalid_response') return 'provider_invalid_response';
  }
  if (error instanceof Error && error.message === 'setup_command_failed') {
    return 'setup_command_failed';
  }
  return 'provider_request_failed';
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ByocCredentialMissingError) return false;
  if (error instanceof ByocCredentialResolverError) return true;
  if (error instanceof VercelSandboxRestError) {
    return (
      error.status === undefined ||
      error.status === 408 ||
      error.status === 409 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  return false;
}

function snapshotMatches(
  snapshot: VercelSandboxSnapshot,
  sourceSessionId: string,
  baseline: Set<string>
): boolean {
  return (
    snapshot.sourceSessionId === sourceSessionId &&
    !baseline.has(snapshot.id) &&
    snapshot.status === 'created'
  );
}

function snapshotBaseline(value: string | null): Set<string> | undefined {
  if (!value) return undefined;

  try {
    return new Set(z.array(z.string()).parse(JSON.parse(value)));
  } catch {
    throw new Error('snapshot_baseline_invalid');
  }
}

function sameOwnership(
  first: BuildOwnership | undefined,
  second: BuildOwnership | undefined
): boolean {
  return (
    first?.organization_id === second?.organization_id &&
    first?.credential_id === second?.credential_id &&
    first?.build_generation === second?.build_generation
  );
}

function ownershipFromInput(input: z.infer<typeof StartInputSchema>): BuildOwnership {
  return {
    organization_id: input.organizationId,
    credential_id: input.credentialId,
    build_generation: input.buildGeneration,
  };
}

export class VercelSnapshotBuild extends DurableObject<Env> {
  private readonly db: BuildDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  async start(input: {
    organizationId: string;
    credentialId: string;
    buildGeneration: string;
  }): Promise<void> {
    const parsed = StartInputSchema.parse(input);
    if (parsed.organizationId !== this.ctx.id.name) {
      throw new Error('snapshot_organization_mismatch');
    }

    const observed = this.load();
    const credential = await fetchByocVercelCredential(this.env, {
      organizationId: parsed.organizationId,
      credentialId: parsed.credentialId,
    });
    if (credential.buildGeneration !== parsed.buildGeneration) return;

    const owner = ownershipFromInput(parsed);
    const current = this.load();
    if (sameOwnership(current, owner)) return;
    if (current && !sameOwnership(current, observed)) return;

    const timestamp = now();
    const next = {
      organization_id: parsed.organizationId,
      credential_id: parsed.credentialId,
      build_generation: parsed.buildGeneration,
      runtime_build_id: credential.runtimeBuildId ?? `vercel-runtime-${parsed.buildGeneration}`,
      step: 'validating_access' as const,
      retry_count: 0,
      next_attempt_at: timestamp,
      builder_name: deterministicName(
        'snapshot-builder',
        parsed.credentialId,
        credential.runtimeBuildId ?? parsed.buildGeneration
      ),
      builder_operation_id: operationId('builder', parsed.buildGeneration),
      builder_create_requested: 0,
      builder_session_id: null,
      validator_name: deterministicName(
        'snapshot-validator',
        parsed.credentialId,
        credential.runtimeBuildId ?? parsed.buildGeneration
      ),
      validator_operation_id: operationId('validator', parsed.buildGeneration),
      validator_create_requested: 0,
      validator_session_id: null,
      validator_wrapper_requested: 0,
      validator_wrapper_command_id: null,
      validator_control_id: null,
      team_slug: null,
      project_slug: null,
      snapshot_baseline_json: null,
      snapshot_source_session_id: null,
      snapshot_id: null,
      snapshot_candidate_id: null,
      snapshot_requested: 0,
      last_error: null,
      created_at: timestamp,
      updated_at: timestamp,
    } satisfies typeof vercelSnapshotBuilds.$inferInsert;

    const previousResources =
      current && current.credential_id === parsed.credentialId && this.hasBuildResources(current)
        ? current
        : undefined;
    const handover = previousResources
      ? {
          ...previousResources,
          credential_id: next.credential_id,
          build_generation: next.build_generation,
          next_attempt_at: null,
          updated_at: timestamp,
        }
      : next;

    const applied = current
      ? this.db
          .update(vercelSnapshotBuilds)
          .set(handover)
          .where(this.ownerCondition(current))
          .returning({ organization_id: vercelSnapshotBuilds.organization_id })
          .get()
      : this.db
          .insert(vercelSnapshotBuilds)
          .values(next)
          .onConflictDoNothing({ target: vercelSnapshotBuilds.organization_id })
          .returning({ organization_id: vercelSnapshotBuilds.organization_id })
          .get();
    if (!applied) return;

    if (previousResources) {
      try {
        const config = await this.external(handover, () =>
          resolveByocVercelAccessConfig(this.env, {
            organizationId: parsed.organizationId,
            credentialId: parsed.credentialId,
          })
        );
        await this.removeBuildResources(handover, this.createClient(config), previousResources);
        if (!this.save(next)) return;
      } catch (error) {
        if (error instanceof SnapshotBuildOwnershipLostError) return;
        if (error instanceof ByocCredentialMissingError) await this.erase(handover);
        throw error;
      }
    }

    await this.arm(next, timestamp);
  }

  async cleanup(input: {
    organizationId: string;
    credentialId: string;
    buildGeneration: string;
    snapshotId?: string;
  }): Promise<void> {
    const parsed = CleanupInputSchema.parse(input);
    if (parsed.organizationId !== this.ctx.id.name) {
      throw new Error('snapshot_organization_mismatch');
    }

    const owner = ownershipFromInput(parsed);
    const observed = this.load();
    if (observed && !sameOwnership(observed, owner)) return;

    try {
      const credential = await this.cleanupExternal(owner, () =>
        fetchByocVercelCredential(this.env, {
          organizationId: parsed.organizationId,
          credentialId: parsed.credentialId,
        })
      );
      if (credential.buildGeneration !== parsed.buildGeneration) return;

      const current = this.loadOwned(owner);
      if (!parsed.snapshotId && (!current || !this.hasBuildResources(current))) {
        if (current) await this.erase(current);
        return;
      }

      const config = await this.cleanupExternal(owner, () =>
        resolveByocVercelAccessConfig(this.env, {
          organizationId: parsed.organizationId,
          credentialId: parsed.credentialId,
        })
      );
      const client = this.createClient(config);
      const latest = this.loadOwned(owner);
      const explicitSnapshotIds = [
        parsed.snapshotId,
        observed?.snapshot_id,
        observed?.snapshot_candidate_id,
        current?.snapshot_id,
        current?.snapshot_candidate_id,
      ].filter((snapshotId): snapshotId is string => Boolean(snapshotId));

      await this.removeBuildResources(
        owner,
        client,
        latest ?? current ?? observed,
        explicitSnapshotIds,
        true
      );

      const remaining = this.loadOwned(owner);
      if (remaining) await this.erase(remaining);
    } catch (error) {
      if (error instanceof SnapshotBuildOwnershipLostError) return;
      if (error instanceof ByocCredentialMissingError) {
        const remaining = this.loadOwned(owner);
        if (remaining) await this.erase(remaining);
        return;
      }
      throw error;
    }
  }

  async alarm(): Promise<void> {
    const state = this.load();
    if (!state || state.next_attempt_at === null || state.next_attempt_at > now()) return;

    let credential: ByocVercelCredential;
    try {
      credential = await this.external(state, () =>
        fetchByocVercelCredential(this.env, {
          organizationId: state.organization_id,
          credentialId: state.credential_id,
        })
      );
    } catch (error) {
      if (error instanceof SnapshotBuildOwnershipLostError) return;
      await this.handleFailure(state, error);
      return;
    }

    let client: VercelSandboxRestClient | undefined;
    try {
      if (credential.buildGeneration !== state.build_generation) {
        await this.abandon(state);
        return;
      }

      const config = await this.external(state, () =>
        resolveByocVercelAccessConfig(this.env, {
          organizationId: state.organization_id,
          credentialId: state.credential_id,
        })
      );
      client = this.createClient(config);
      const next = await this.runStep(state, client);
      if (!next || !this.save(next)) return;

      const terminalConfirmed = state.step === 'confirm_terminal';
      const projected = await this.external(next, () =>
        projectByocVercelStatus(this.env, this.projection(next, terminalConfirmed))
      );
      if (!projected) {
        await this.abandon(next, client);
        return;
      }

      if (terminalConfirmed && next.step === 'confirm_terminal') {
        await this.erase(next);
      } else {
        await this.arm(next, now() + BUILD_ALARM_DELAY_MS);
      }
    } catch (error) {
      if (error instanceof SnapshotBuildOwnershipLostError) return;
      await this.handleFailure(state, error, client);
    }
  }

  private async runStep(
    state: BuildRow,
    client: VercelSandboxRestClient
  ): Promise<BuildRow | null> {
    switch (BuildStepSchema.parse(state.step)) {
      case 'validating_access': {
        if (!state.team_slug) {
          const team = await this.external(state, () => client.inspectTeam());
          return this.next(state, { team_slug: team.slug });
        }
        const project = await this.external(state, () => client.inspectProject());
        return this.next(state, {
          step: 'create_builder',
          project_slug: project.name,
          last_error: null,
        });
      }
      case 'create_builder': {
        const input = buildInput(state, 'runtime');
        let created;
        if (state.builder_create_requested === 1) {
          const intent = this.next(state, { builder_create_requested: 2 });
          if (!this.save(intent)) throw new SnapshotBuildOwnershipLostError();
          created = await this.createManagedSandbox(intent, client, input);
        } else {
          const { timeoutMs: _timeoutMs, ...inspectInput } = input;
          const existing = await this.external(state, () => client.inspectByName(inspectInput));
          if (existing) {
            created = existing;
          } else if (state.builder_create_requested === 2) {
            throw new VercelSandboxRestError('request_failed', 'inspect');
          } else {
            const prepared = this.next(state, { builder_create_requested: 1 });
            if (!this.save(prepared)) throw new SnapshotBuildOwnershipLostError();
            return prepared;
          }
        }
        return this.next(state, {
          step: 'install_system_dependencies',
          builder_session_id: created.session.id,
          last_error: null,
        });
      }
      case 'install_system_dependencies': {
        const builderSessionId = requiredBuildField(
          state.builder_session_id,
          'builder_session_missing'
        );
        await this.runCommand(state, client, builderSessionId, 'bash', [
          '-lc',
          'set -euo pipefail; sudo dnf install -y git git-lfs jq tar gzip; sudo mkdir -p /workspace /usr/local/share/kilo /opt/git/etc; sudo chown "$(id -u):$(id -g)" /workspace; test -w /workspace; sudo git lfs install --system --skip-repo',
        ]);
        return this.next(state, { step: 'install_node_dependencies' });
      }
      case 'install_node_dependencies': {
        const builderSessionId = requiredBuildField(
          state.builder_session_id,
          'builder_session_missing'
        );
        await this.runCommand(state, client, builderSessionId, 'bash', [
          '-lc',
          `set -euo pipefail; curl -fsSL https://bun.sh/install | bash -s bun-v${PINNED_BUN_VERSION}; sudo install -m 0755 "$HOME/.bun/bin/bun" /usr/local/bin/bun; sudo npm install -g @kilocode/cli@${PINNED_KILO_VERSION}; test "$(bun --version)" = ${JSON.stringify(PINNED_BUN_VERSION)}; case "$(node --version)" in v24.*) ;; *) exit 1 ;; esac; git --version >/dev/null; kilo --version >/dev/null`,
        ]);
        return this.next(state, { step: 'upload_runtime_artifacts' });
      }
      case 'upload_runtime_artifacts': {
        const builderSessionId = requiredBuildField(
          state.builder_session_id,
          'builder_session_missing'
        );
        const artifacts = await this.external(state, () => getVercelRuntimeArtifacts());
        const wrapper = artifacts.find(
          artifact => artifact.path === 'usr/local/bin/kilocode-wrapper.js'
        );
        const controlWrapper = artifacts.find(
          artifact => artifact.path === 'usr/local/bin/kilocode-control-wrapper.js'
        );
        if (!wrapper || !controlWrapper) throw new Error('runtime_artifact_missing');
        const manifest = JSON.stringify({
          runtimeBuildId: state.runtime_build_id,
          wrapperVersion: WRAPPER_VERSION,
          runtime: 'node24',
          bunVersion: PINNED_BUN_VERSION,
          wrapperSha256: wrapper.sha256,
        });
        await this.external(state, () =>
          client.writeFiles(builderSessionId, '/tmp', [
            { path: 'kilocode-wrapper.js', content: wrapper.bytes },
            { path: 'kilocode-control-wrapper.js', content: controlWrapper.bytes },
            { path: 'kilo-runtime-manifest.json', content: manifest },
          ])
        );
        return this.next(state, { step: 'verify_runtime_artifacts' });
      }
      case 'verify_runtime_artifacts': {
        const builderSessionId = requiredBuildField(
          state.builder_session_id,
          'builder_session_missing'
        );
        await this.runCommand(state, client, builderSessionId, 'bash', [
          '-lc',
          `set -euo pipefail; sudo install -m 0755 /tmp/kilocode-wrapper.js /usr/local/bin/kilocode-wrapper.js; sudo install -m 0755 /tmp/kilocode-control-wrapper.js /usr/local/bin/kilocode-control-wrapper.js; sudo install -m 0644 /tmp/kilo-runtime-manifest.json /usr/local/share/kilo/runtime-manifest.json; test -f /usr/local/bin/kilocode-wrapper.js; test -f /usr/local/bin/kilocode-control-wrapper.js; test "$(bun --version)" = ${JSON.stringify(PINNED_BUN_VERSION)}; test "$(node --version | cut -c1-3)" = "v24"; wrapper_hash="$(sha256sum /usr/local/bin/kilocode-wrapper.js | cut -d' ' -f1)"; jq -e --arg build ${JSON.stringify(state.runtime_build_id)} --arg bun ${JSON.stringify(PINNED_BUN_VERSION)} --arg hash "$wrapper_hash" '.runtimeBuildId == $build and .bunVersion == $bun and .wrapperSha256 == $hash' /usr/local/share/kilo/runtime-manifest.json >/dev/null`,
        ]);
        return this.next(state, {
          step: 'snapshot_builder',
          snapshot_source_session_id: state.builder_session_id,
          snapshot_baseline_json: null,
          snapshot_requested: 0,
        });
      }
      case 'snapshot_builder':
        return this.advanceSnapshot(state, client);
      case 'create_validator': {
        if (!state.snapshot_id) throw new Error('snapshot_result_missing');
        const input = validatorInput(state);
        let created;
        if (state.validator_create_requested === 1) {
          const intent = this.next(state, { validator_create_requested: 2 });
          if (!this.save(intent)) throw new SnapshotBuildOwnershipLostError();
          created = await this.createManagedSandbox(intent, client, input);
        } else {
          const { timeoutMs: _timeoutMs, ...inspectInput } = input;
          const existing = await this.external(state, () => client.inspectByName(inspectInput));
          if (existing) {
            created = existing;
          } else if (state.validator_create_requested === 2) {
            throw new VercelSandboxRestError('request_failed', 'inspect');
          } else {
            const prepared = this.next(state, { validator_create_requested: 1 });
            if (!this.save(prepared)) throw new SnapshotBuildOwnershipLostError();
            return prepared;
          }
        }
        return this.next(state, {
          step: 'launch_validator_wrapper',
          validator_session_id: created.session.id,
        });
      }
      case 'launch_validator_wrapper': {
        const validatorSessionId = requiredBuildField(
          state.validator_session_id,
          'validator_session_missing'
        );
        const validatorControlId = state.validator_control_id ?? controlId(state.build_generation);
        if (state.validator_wrapper_command_id) {
          return this.next(state, {
            step: 'verify_validator_call_home',
            validator_control_id: validatorControlId,
          });
        }
        if (state.validator_wrapper_requested === 1) {
          const commands = await this.external(state, () =>
            client.listCommands(validatorSessionId)
          );
          const matches = commands.filter(command =>
            command.args.some(argument =>
              argument.includes(`byoc-call-home:${state.build_generation}`)
            )
          );
          if (matches.length > 1) throw new Error('validator_call_home_ambiguous');
          const command = matches[0];
          if (!command) throw new VercelSandboxRestError('request_failed', 'list-commands');
          return this.next(state, {
            step: 'verify_validator_call_home',
            validator_control_id: validatorControlId,
            validator_wrapper_command_id: command.id,
          });
        }

        if (!this.env.WORKER_URL) throw new Error('provider_configuration_failed');
        const credential = generateSandboxCredential();
        const credentialHash = await this.external(state, () => hashSandboxCredential(credential));
        await this.external(state, () =>
          withDORetry(
            () => getSandboxControlStub(this.env, validatorControlId),
            stub => stub.setWrapperCredentialHash(credentialHash),
            'seedByocValidatorControl'
          )
        );
        const intent = this.next(state, {
          validator_wrapper_requested: 1,
          validator_control_id: validatorControlId,
        });
        if (!this.save(intent)) throw new SnapshotBuildOwnershipLostError();
        const command = await this.external(intent, () =>
          client.executeCommand(validatorSessionId, {
            command: 'sh',
            args: [
              '-lc',
              `exec bun run /usr/local/bin/kilocode-control-wrapper.js # byoc-call-home:${state.build_generation}`,
            ],
            cwd: '/',
            env: buildControlWrapperLaunchEnv({
              workerUrl: this.env.WORKER_URL,
              sandboxId: validatorControlId,
              credential,
            }),
            sudo: false,
            wait: false,
          })
        );
        return this.next(intent, {
          step: 'verify_validator_call_home',
          validator_wrapper_command_id: command.id,
        });
      }
      case 'verify_validator_call_home': {
        const validatorSessionId = requiredBuildField(
          state.validator_session_id,
          'validator_session_missing'
        );
        const validatorCommandId = requiredBuildField(
          state.validator_wrapper_command_id,
          'validator_command_missing'
        );
        const validatorControlId = requiredBuildField(
          state.validator_control_id,
          'validator_control_missing'
        );
        const command = await this.external(state, () =>
          client.getCommand(validatorSessionId, validatorCommandId)
        );
        if (command.exitCode !== null) {
          if (command.exitCode !== 0) throw new Error('validator_call_home_failed');
          throw new Error('validator_call_home_ended');
        }
        const status = await this.external(state, () =>
          withDORetry(
            () => getSandboxControlStub(this.env, validatorControlId),
            stub => stub.getStatus(),
            'verifyByocValidatorCallHome'
          )
        );
        return status.connection === 'ready'
          ? this.next(state, { step: 'stop_validator' })
          : this.next(state, { step: 'verify_validator_call_home' });
      }
      case 'stop_validator': {
        const validatorSessionId = requiredBuildField(
          state.validator_session_id,
          'validator_session_missing'
        );
        const session = await this.external(state, () =>
          client.stopSession(validatorSessionId, state.validator_name)
        );
        if (
          session.status !== 'stopped' &&
          session.status !== 'failed' &&
          session.status !== 'aborted'
        ) {
          throw new VercelSandboxRestError('request_failed', 'stop-session');
        }
        return this.next(state, { step: 'confirm_terminal' });
      }
      case 'confirm_terminal': {
        const validatorSessionId = requiredBuildField(
          state.validator_session_id,
          'validator_session_missing'
        );
        const observed = await this.external(state, () =>
          client.getSession(validatorSessionId, state.validator_name)
        );
        if (
          observed.session.status === 'stopped' ||
          observed.session.status === 'failed' ||
          observed.session.status === 'aborted'
        ) {
          return this.next(state, { step: 'confirm_terminal', last_error: null });
        }
        throw new VercelSandboxRestError('request_failed', 'get-session');
      }
    }
  }

  private async createManagedSandbox(
    owner: BuildRow,
    client: VercelSandboxRestClient,
    input: CreateSandboxInput
  ): Promise<VercelSandboxCreateEnvelope> {
    if (!this.loadOwned(owner)) throw new SnapshotBuildOwnershipLostError();

    const created = await client.createSandbox(input);
    if (this.loadOwned(owner)) return created;

    await this.removeDetachedSandbox(owner, client, input, created);
    throw new SnapshotBuildOwnershipLostError();
  }

  private async advanceSnapshot(
    state: BuildRow,
    client: VercelSandboxRestClient
  ): Promise<BuildRow> {
    const sourceSessionId = state.snapshot_source_session_id;
    if (!sourceSessionId) throw new Error('snapshot_source_missing');
    const baseline = snapshotBaseline(state.snapshot_baseline_json);
    if (!baseline) {
      const snapshots = await this.external(state, () => client.listSnapshots());
      return this.next(state, {
        snapshot_baseline_json: JSON.stringify(snapshots.map(snapshot => snapshot.id)),
      });
    }

    if (state.snapshot_candidate_id) {
      const snapshot = await this.external(state, () =>
        client.inspectSnapshot(
          requiredBuildField(state.snapshot_candidate_id, 'snapshot_candidate_missing')
        )
      );
      if (!snapshotMatches(snapshot, sourceSessionId, baseline)) {
        throw new Error('snapshot_result_ambiguous');
      }
      return this.next(state, {
        snapshot_id: snapshot.id,
        snapshot_candidate_id: null,
        snapshot_requested: 2,
        step: 'create_validator',
      });
    }

    if (state.snapshot_requested === 1) {
      const requested = this.next(state, { snapshot_requested: 2 });
      if (!this.save(requested)) throw new SnapshotBuildOwnershipLostError();
      const snapshot = await client.createSnapshot(sourceSessionId, SNAPSHOT_EXPIRATION_MS);
      if (!this.loadOwned(requested)) {
        await this.removeDetachedSnapshot(requested, client, snapshot.id);
        throw new SnapshotBuildOwnershipLostError();
      }
      return this.next(requested, { snapshot_id: snapshot.id, step: 'create_validator' });
    }

    const snapshots = await this.external(state, () => client.listSnapshots());
    const candidates = snapshots.filter(snapshot =>
      snapshotMatches(snapshot, sourceSessionId, baseline)
    );
    if (candidates.length > 1) throw new Error('snapshot_result_ambiguous');
    if (candidates.length === 1) {
      const [candidate] = candidates;
      if (!candidate) throw new Error('snapshot_result_ambiguous');
      return this.next(state, { snapshot_candidate_id: candidate.id });
    }
    if (state.snapshot_requested === 0) {
      const requested = this.next(state, { snapshot_requested: 1 });
      if (!this.save(requested)) throw new SnapshotBuildOwnershipLostError();
      return requested;
    }
    throw new VercelSandboxRestError('request_failed', 'list-snapshots');
  }

  private async runCommand(
    owner: BuildOwnership,
    client: VercelSandboxRestClient,
    sessionId: string,
    command: string,
    args: string[],
    timeoutMs = BUILDER_TIMEOUT_MS
  ): Promise<VercelSandboxCommand> {
    const result = await this.external(owner, () =>
      client.executeCommand(sessionId, {
        command,
        args,
        cwd: '/',
        env: {},
        sudo: false,
        wait: true,
        timeoutMs,
      })
    );
    if (result.finished.exitCode !== 0) throw new Error('setup_command_failed');
    return result.finished;
  }

  private next(state: BuildRow, changes: Partial<BuildRow>): BuildRow {
    return { ...state, ...changes, retry_count: 0, next_attempt_at: now(), updated_at: now() };
  }

  private projection(state: BuildRow, terminalConfirmed = false) {
    const ready =
      terminalConfirmed && state.step === 'confirm_terminal' && state.snapshot_id !== null;
    return {
      organizationId: state.organization_id,
      credentialId: state.credential_id,
      buildGeneration: state.build_generation,
      setupStatus: ready ? ('ready' as const) : ('building' as const),
      setupStep: ready ? null : (state.step as BuildStep),
      setupError: null,
      teamSlug: state.team_slug,
      projectSlug: state.project_slug,
      runtimeBuildId: state.runtime_build_id,
      runtimeSnapshotId: ready ? state.snapshot_id : null,
      setupStartedAt: iso(state.created_at),
      setupCompletedAt: ready ? iso(state.updated_at) : null,
    };
  }

  private async handleFailure(
    owner: BuildRow,
    error: unknown,
    client?: VercelSandboxRestClient
  ): Promise<void> {
    const state = this.loadOwned(owner);
    if (!state) return;

    if (error instanceof ByocCredentialMissingError) {
      await this.erase(state);
      return;
    }

    const attempt = state.retry_count + 1;
    if (isRetryable(error) && attempt <= MAX_RETRIES) {
      const retrying = {
        ...state,
        retry_count: attempt,
        next_attempt_at: now() + (RETRY_DELAY_MS[attempt - 1] ?? MAX_RETRY_DELAY_MS),
        last_error: safeError(error),
        updated_at: now(),
      } satisfies BuildRow;
      if (!this.save(retrying)) return;
      await this.arm(retrying, retrying.next_attempt_at);
      return;
    }

    const failed = {
      ...state,
      retry_count: attempt,
      next_attempt_at: null,
      last_error: safeError(error),
      updated_at: now(),
    } satisfies BuildRow;
    if (!this.save(failed)) return;

    try {
      await this.external(failed, () =>
        projectByocVercelStatus(this.env, {
          ...this.projection(failed),
          setupStatus: 'failed',
          setupError: safeError(error),
          setupStep: null,
          runtimeSnapshotId: null,
          setupCompletedAt: null,
        })
      );
      await this.abandon(failed, client);
    } catch (failure) {
      if (failure instanceof SnapshotBuildOwnershipLostError) return;
      if (failure instanceof ByocCredentialMissingError) {
        await this.erase(failed);
        return;
      }
      throw failure;
    }
  }

  private createClient(
    config: Awaited<ReturnType<typeof resolveByocVercelAccessConfig>>
  ): VercelSandboxRestClient {
    return new VercelSandboxRestClient({
      accessToken: config.accessToken,
      teamId: config.teamId,
      projectId: config.projectId,
      fetch,
    });
  }

  private hasBuildResources(state: BuildRow): boolean {
    return Boolean(
      state.builder_session_id ||
      state.validator_session_id ||
      state.builder_create_requested > 0 ||
      state.validator_create_requested > 0 ||
      state.snapshot_id ||
      state.snapshot_candidate_id ||
      (state.snapshot_requested > 0 &&
        state.snapshot_source_session_id &&
        state.snapshot_baseline_json)
    );
  }

  private async abandon(owner: BuildOwnership, client?: VercelSandboxRestClient): Promise<void> {
    const state = this.loadOwned(owner);
    if (!state) return;

    if (this.hasBuildResources(state)) {
      let credential: ByocVercelCredential;
      try {
        credential = await this.external(state, () =>
          fetchByocVercelCredential(this.env, {
            organizationId: state.organization_id,
            credentialId: state.credential_id,
          })
        );
      } catch (error) {
        if (error instanceof ByocCredentialMissingError) {
          await this.erase(state);
          return;
        }
        throw error;
      }

      if (!client || credential.buildGeneration !== state.build_generation) {
        const config = await this.external(state, () =>
          resolveByocVercelAccessConfig(this.env, {
            organizationId: state.organization_id,
            credentialId: state.credential_id,
          })
        );
        client = this.createClient(config);
      }

      await this.removeBuildResources(state, client, state);
    }

    await this.erase(state);
  }

  private async removeBuildResources(
    owner: BuildOwnership,
    client: VercelSandboxRestClient,
    state?: BuildRow,
    additionalSnapshotIds: string[] = [],
    allowMissingOwner = false
  ): Promise<void> {
    if (state) {
      await this.removeManagedSession(owner, client, state, 'validator', allowMissingOwner);
      if (!state.snapshot_id) {
        await this.removeManagedSession(owner, client, state, 'builder', allowMissingOwner);
      }
    }

    await this.removeSnapshotResources(
      owner,
      client,
      state,
      additionalSnapshotIds,
      allowMissingOwner
    );
  }

  private async removeManagedSession(
    owner: BuildOwnership,
    client: VercelSandboxRestClient,
    state: BuildRow,
    kind: 'builder' | 'validator',
    allowMissingOwner: boolean
  ): Promise<void> {
    const sessionId = kind === 'builder' ? state.builder_session_id : state.validator_session_id;
    const sandboxName = kind === 'builder' ? state.builder_name : state.validator_name;

    if (sessionId) {
      await this.stopBuildSession(owner, client, sessionId, sandboxName, allowMissingOwner);
      return;
    }

    const requested =
      kind === 'builder' ? state.builder_create_requested : state.validator_create_requested;
    if (requested === 0) return;

    const input = kind === 'builder' ? buildInput(state, 'runtime') : validatorInput(state);
    const { timeoutMs: _timeoutMs, ...inspectInput } = input;
    const existing = allowMissingOwner
      ? await this.cleanupExternal(owner, () => client.inspectByName(inspectInput))
      : await this.external(owner, () => client.inspectByName(inspectInput));

    if (!existing) {
      if (requested > 1) throw new VercelSandboxRestError('request_failed', 'inspect');
      return;
    }

    await this.stopBuildSession(owner, client, existing.session.id, sandboxName, allowMissingOwner);
  }

  private async stopBuildSession(
    owner: BuildOwnership,
    client: VercelSandboxRestClient,
    sessionId: string,
    sandboxName: string,
    allowMissingOwner: boolean
  ): Promise<void> {
    try {
      const session = allowMissingOwner
        ? await this.cleanupExternal(owner, () => client.stopSession(sessionId, sandboxName))
        : await this.external(owner, () => client.stopSession(sessionId, sandboxName));

      if (
        session.status !== 'stopped' &&
        session.status !== 'failed' &&
        session.status !== 'aborted'
      ) {
        throw new VercelSandboxRestError('request_failed', 'stop-session');
      }
    } catch (error) {
      if (
        !(error instanceof VercelSandboxRestError) ||
        (error.status !== 404 && error.status !== 410)
      ) {
        throw error;
      }

      if (allowMissingOwner) {
        const current = this.load();
        if (current && !sameOwnership(current, owner)) {
          throw new SnapshotBuildOwnershipLostError();
        }
      } else if (!this.loadOwned(owner)) {
        throw new SnapshotBuildOwnershipLostError();
      }
    }
  }

  private async removeSnapshotResources(
    owner: BuildOwnership,
    client: VercelSandboxRestClient,
    state?: BuildRow,
    additionalSnapshotIds: string[] = [],
    allowMissingOwner = false
  ): Promise<void> {
    const snapshotIds = new Set(additionalSnapshotIds);
    if (state?.snapshot_id) snapshotIds.add(state.snapshot_id);
    if (state?.snapshot_candidate_id) snapshotIds.add(state.snapshot_candidate_id);

    if (
      state &&
      state.snapshot_requested > 0 &&
      !state.snapshot_id &&
      state.snapshot_source_session_id
    ) {
      const baseline = snapshotBaseline(state.snapshot_baseline_json);
      if (baseline) {
        const observed = allowMissingOwner
          ? await this.cleanupExternal(owner, () => client.listSnapshots())
          : await this.external(owner, () => client.listSnapshots());
        for (const snapshot of observed) {
          if (snapshotMatches(snapshot, state.snapshot_source_session_id, baseline)) {
            snapshotIds.add(snapshot.id);
          }
        }
      }
    }

    for (const snapshotId of snapshotIds) {
      try {
        if (allowMissingOwner) {
          await this.cleanupExternal(owner, () => client.deleteSnapshot(snapshotId));
        } else {
          await this.external(owner, () => client.deleteSnapshot(snapshotId));
        }
      } catch (error) {
        if (!(error instanceof VercelSandboxRestError) || error.status !== 404) throw error;
        if (allowMissingOwner) {
          const current = this.load();
          if (current && !sameOwnership(current, owner)) {
            throw new SnapshotBuildOwnershipLostError();
          }
        } else if (!this.loadOwned(owner)) {
          throw new SnapshotBuildOwnershipLostError();
        }
      }
    }
  }

  private async removeDetachedSandbox(
    owner: BuildOwnership,
    client: VercelSandboxRestClient,
    input: CreateSandboxInput,
    created: VercelSandboxCreateEnvelope
  ): Promise<void> {
    const expectedSnapshotId =
      input.source?.type === 'snapshot' ? input.source.snapshotId : input.snapshotId;

    if (
      created.sandbox.name !== input.name ||
      created.sandbox.persistent ||
      created.sandbox.currentSessionId !== created.session.id ||
      created.sandbox.tags[VERCEL_CLOUD_AGENT_RESOURCE_TAG] !==
        VERCEL_CLOUD_AGENT_RESOURCE_TAG_VALUE ||
      created.sandbox.tags[VERCEL_CLOUD_AGENT_CREATE_OPERATION_TAG] !== input.operationId ||
      created.sandbox.tags[VERCEL_CLOUD_AGENT_RUNTIME_BUILD_TAG] !== input.runtimeBuildId ||
      created.session.sourceSandboxName !== input.name ||
      created.session.sourceSnapshotId !== expectedSnapshotId ||
      created.session.runtime !== input.runtime ||
      created.runtime.sandboxName !== input.name ||
      created.runtime.sessionId !== created.session.id
    ) {
      throw new VercelSandboxRestError('correlation_mismatch', 'create');
    }

    try {
      await fetchByocVercelCredential(this.env, {
        organizationId: owner.organization_id,
        credentialId: owner.credential_id,
      });
    } catch (error) {
      if (error instanceof ByocCredentialMissingError) return;
      throw error;
    }

    const current = this.load();
    if (current && current.credential_id !== owner.credential_id) return;
    if (current && sameOwnership(current, owner)) return;

    if (current) {
      const builderMatches =
        current.runtime_build_id === input.runtimeBuildId &&
        current.builder_name === input.name &&
        current.builder_operation_id === input.operationId &&
        current.builder_create_requested > 0;
      const validatorMatches =
        current.runtime_build_id === input.runtimeBuildId &&
        current.validator_name === input.name &&
        current.validator_operation_id === input.operationId &&
        current.validator_create_requested > 0;

      if (
        (current.builder_session_id === created.session.id && !builderMatches) ||
        (current.validator_session_id === created.session.id && !validatorMatches)
      ) {
        return;
      }

      if (builderMatches && current.builder_session_id === null) {
        if (!this.save({ ...current, builder_session_id: created.session.id, updated_at: now() })) {
          return;
        }
      } else if (validatorMatches && current.validator_session_id === null) {
        if (
          !this.save({ ...current, validator_session_id: created.session.id, updated_at: now() })
        ) {
          return;
        }
      }
    }

    try {
      const stopped = await client.stopSession(created.session.id, input.name);
      if (
        stopped.status !== 'stopped' &&
        stopped.status !== 'failed' &&
        stopped.status !== 'aborted'
      ) {
        throw new VercelSandboxRestError('request_failed', 'stop-session');
      }
    } catch (error) {
      if (
        !(error instanceof VercelSandboxRestError) ||
        (error.status !== 404 && error.status !== 410)
      ) {
        throw error;
      }
    }
  }

  private async removeDetachedSnapshot(
    owner: BuildOwnership,
    client: VercelSandboxRestClient,
    snapshotId: string
  ): Promise<void> {
    try {
      await fetchByocVercelCredential(this.env, {
        organizationId: owner.organization_id,
        credentialId: owner.credential_id,
      });
    } catch (error) {
      if (error instanceof ByocCredentialMissingError) return;
      throw error;
    }

    const current = this.load();
    if (current && current.credential_id !== owner.credential_id) return;

    try {
      await client.deleteSnapshot(snapshotId);
    } catch (error) {
      if (!(error instanceof VercelSandboxRestError) || error.status !== 404) throw error;
    }
  }

  private async external<T>(owner: BuildOwnership, action: () => Promise<T>): Promise<T> {
    if (!this.loadOwned(owner)) throw new SnapshotBuildOwnershipLostError();
    const result = await action();
    if (!this.loadOwned(owner)) throw new SnapshotBuildOwnershipLostError();
    return result;
  }

  private async cleanupExternal<T>(owner: BuildOwnership, action: () => Promise<T>): Promise<T> {
    const initial = this.load();
    if (initial && !sameOwnership(initial, owner)) throw new SnapshotBuildOwnershipLostError();
    const result = await action();
    const current = this.load();
    if (current && !sameOwnership(current, owner)) throw new SnapshotBuildOwnershipLostError();
    return result;
  }

  private ownerCondition(owner: BuildOwnership) {
    return and(
      eq(vercelSnapshotBuilds.organization_id, owner.organization_id),
      eq(vercelSnapshotBuilds.credential_id, owner.credential_id),
      eq(vercelSnapshotBuilds.build_generation, owner.build_generation)
    );
  }

  private load(): BuildRow | undefined {
    return this.db
      .select()
      .from(vercelSnapshotBuilds)
      .where(eq(vercelSnapshotBuilds.organization_id, this.ctx.id.name ?? ''))
      .get();
  }

  private loadOwned(owner: BuildOwnership): BuildRow | undefined {
    if (owner.organization_id !== this.ctx.id.name) return undefined;
    return this.db.select().from(vercelSnapshotBuilds).where(this.ownerCondition(owner)).get();
  }

  private save(row: BuildRow): boolean {
    return Boolean(
      this.db
        .update(vercelSnapshotBuilds)
        .set(row)
        .where(this.ownerCondition(row))
        .returning({ organization_id: vercelSnapshotBuilds.organization_id })
        .get()
    );
  }

  private async arm(owner: BuildOwnership, timestamp: number): Promise<boolean> {
    if (!this.loadOwned(owner)) return false;
    await this.ctx.storage.setAlarm(timestamp);
    return true;
  }

  private async erase(owner: BuildOwnership): Promise<boolean> {
    const erased = this.db
      .delete(vercelSnapshotBuilds)
      .where(this.ownerCondition(owner))
      .returning({ organization_id: vercelSnapshotBuilds.organization_id })
      .get();
    if (!erased) return false;
    await this.ctx.storage.deleteAlarm();
    return true;
  }
}
