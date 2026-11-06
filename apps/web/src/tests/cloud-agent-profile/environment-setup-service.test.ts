/**
 * Integration test for drafts and required network hosts in
 * `@kilocode/cloud-agent-profile`, exercised against the web Postgres test
 * harness because that's where the Drizzle migrations and seed helpers live.
 */
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  cloud_agent_environment_setup_runs,
  cloud_agent_environment_vars,
  cloud_agent_environments,
  organizations,
  type EnvironmentSetupRunStatus,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { generateKeyPairSync } from 'node:crypto';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  addNetworkRequests,
  addSecretRequests,
  attachSetupSession,
  attachVerificationChild,
  cancelSetupRun,
  cleanupSetupRuns,
  createEnvironment,
  createSetupRunWithDraft,
  getEnvironment,
  evaluateCompletionGate,
  getSetupRun,
  listEnvironmentsForOwner,
  listSetupRunsForEnvironment,
  loadEnvironmentForSession,
  loadSetupRunForSession,
  publishSetupRun,
  readEnvironmentReference,
  recordVerification,
  releaseVerification,
  reserveVerification,
  resolveNetworkRequests,
  resolveSecretRequests,
  resumeSetupRun,
  revertSetupRun,
  updateDraftByAgent,
  updateEnvironment,
  type CreateSetupRunWithDraftResult,
  type EnvironmentOwner,
  type EnvironmentRepositoryEntry,
  type EnvironmentRepositoryIdentity,
  type EnvironmentSetupCheck,
  type EnvironmentSetupVerification,
  deleteEnvironment,
  ENVIRONMENT_SETUP_LIMITS,
} from '@kilocode/cloud-agent-profile';

const { publicKey: setupPublicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const setupPublicKeyBase64 = Buffer.from(
  setupPublicKey.export({ type: 'spki', format: 'pem' })
).toString('base64');

async function publishWithPassingVerification(
  tx: Parameters<typeof publishSetupRun>[0],
  input: Parameters<typeof publishSetupRun>[1]
) {
  const [run] = await tx
    .select()
    .from(cloud_agent_environment_setup_runs)
    .where(eq(cloud_agent_environment_setup_runs.id, input.runId));
  if (run?.draft_environment_id && input.mode !== 'force') {
    const [draft] = await tx
      .select()
      .from(cloud_agent_environments)
      .where(eq(cloud_agent_environments.id, run.draft_environment_id));
    if (draft)
      await tx
        .update(cloud_agent_environment_setup_runs)
        .set({
          last_verification: {
            childSessionId: 'child-session',
            childKiloSessionId: null,
            configurationRevision: draft.configuration_revision,
            preparation: 'completed',
            preparationError: null,
            setupDurationMs: 1,
            egressMode: draft.egress_mode ?? 'unrestricted',
            checks: [{ name: 'smoke', command: 'true', expect: 'success' }],
            results: [{ name: 'smoke', passed: true, evidence: 'ok' }],
            recordedAt: new Date().toISOString(),
          },
        })
        .where(eq(cloud_agent_environment_setup_runs.id, run.id));
  }
  return publishSetupRun(tx, input);
}

const WIDGETS: EnvironmentRepositoryIdentity = {
  platform: 'github',
  repoFullName: 'acme/widgets',
};

function userOwner(id: string): EnvironmentOwner {
  return { type: 'user', id };
}

async function createEnv(owner: EnvironmentOwner, repoFullName: string): Promise<string> {
  return db.transaction(async tx => {
    const { id } = await createEnvironment(tx, '', {
      owner,
      createdByUserId: owner.id,
      name: repoFullName,
      platform: 'github',
      repoFullName,
    });
    return id;
  });
}

async function insertDraft(userId: string, repoFullName: string): Promise<string> {
  const [draft] = await db
    .insert(cloud_agent_environments)
    .values({
      owned_by_user_id: userId,
      name: `draft ${repoFullName}`,
      repositories: [{ platform: 'github', repoFullName }],
      is_draft: true,
    })
    .returning({ id: cloud_agent_environments.id });
  return draft.id;
}

async function insertRun(
  userId: string,
  draftEnvironmentId: string,
  status: EnvironmentSetupRunStatus
): Promise<string> {
  const [run] = await db
    .insert(cloud_agent_environment_setup_runs)
    .values({
      owned_by_user_id: userId,
      created_by_user_id: userId,
      draft_environment_id: draftEnvironmentId,
      requirements: 'Set up the local dev stack.',
      model: 'anthropic/claude-sonnet-4',
      launch_repo_full_name: 'acme/widgets',
      status,
    })
    .returning({ id: cloud_agent_environment_setup_runs.id });
  return run.id;
}

describe('draft environments', () => {
  afterEach(cleanupDbForTest);

  test('a draft containing the repository is not matched without an environmentId', async () => {
    const user = await insertTestUser();
    const draftId = await insertDraft(user.id, 'acme/widgets');
    await insertRun(user.id, draftId, 'running');

    const resolution = await loadEnvironmentForSession(db, {
      owner: userOwner(user.id),
      repository: WIDGETS,
    });

    expect(resolution).toEqual({ status: 'none' });
  });

  test('an explicit draft id is not found without allowDraft', async () => {
    const user = await insertTestUser();
    const draftId = await insertDraft(user.id, 'acme/widgets');
    await insertRun(user.id, draftId, 'running');

    const resolution = await loadEnvironmentForSession(db, {
      owner: userOwner(user.id),
      repository: WIDGETS,
      environmentId: draftId,
    });

    expect(resolution).toEqual({ status: 'requested-not-found' });
  });

  test('allowDraft matches when the run is open and owns the requested draft', async () => {
    const user = await insertTestUser();
    const draftId = await insertDraft(user.id, 'acme/widgets');
    const runId = await insertRun(user.id, draftId, 'running');

    const resolution = await loadEnvironmentForSession(db, {
      owner: userOwner(user.id),
      repository: WIDGETS,
      environmentId: draftId,
      allowDraft: { setupRunId: runId },
    });

    expect(resolution.status).toBe('match');
    if (resolution.status !== 'match') throw new Error('expected a match');
    expect(resolution.environment.reference.environmentId).toBe(draftId);
    expect(resolution.environment.egressRequiredHosts).toEqual([]);
  });

  test('allowDraft does not expose a draft whose run is cancelled', async () => {
    const user = await insertTestUser();
    const draftId = await insertDraft(user.id, 'acme/widgets');
    const runId = await insertRun(user.id, draftId, 'cancelled');

    const resolution = await loadEnvironmentForSession(db, {
      owner: userOwner(user.id),
      repository: WIDGETS,
      environmentId: draftId,
      allowDraft: { setupRunId: runId },
    });

    expect(resolution).toEqual({ status: 'requested-not-found' });
  });

  test('allowDraft does not expose a draft whose run belongs to another owner', async () => {
    const user = await insertTestUser();
    const otherUser = await insertTestUser();
    const draftId = await insertDraft(user.id, 'acme/widgets');
    const runId = await insertRun(otherUser.id, draftId, 'running');

    const resolution = await loadEnvironmentForSession(db, {
      owner: userOwner(user.id),
      repository: WIDGETS,
      environmentId: draftId,
      allowDraft: { setupRunId: runId },
    });

    expect(resolution).toEqual({ status: 'requested-not-found' });
  });

  test('lists exclude drafts and a draft reference cannot be read for a build', async () => {
    const user = await insertTestUser();
    const saved = await createEnv(userOwner(user.id), 'acme/widgets');
    const draftId = await insertDraft(user.id, 'acme/widgets');

    const summaries = await listEnvironmentsForOwner(db, userOwner(user.id));
    expect(summaries.map(summary => summary.id)).toEqual([saved]);

    expect(await readEnvironmentReference(db, draftId)).toBeNull();
  });

  test('getEnvironment reports the draft flag and no required hosts', async () => {
    const user = await insertTestUser();
    const environmentId = await createEnv(userOwner(user.id), 'acme/widgets');

    const environment = await getEnvironment(db, environmentId, userOwner(user.id));
    expect(environment.isDraft).toBe(false);
    expect(environment.egressRequiredHosts).toEqual([]);
  });
});

describe('required network hosts', () => {
  afterEach(cleanupDbForTest);

  test('update stores lowercased, de-duplicated hosts and bumps the revision', async () => {
    const user = await insertTestUser();
    const environmentId = await createEnv(userOwner(user.id), 'acme/widgets');
    const owner = userOwner(user.id);

    const { configurationRevision } = await db.transaction(tx =>
      updateEnvironment(tx, '', {
        owner,
        environmentId,
        requiredHosts: ['API.example.com', 'api.example.com', 'cdn.example.com'],
      })
    );

    expect(configurationRevision).toBe(2);
    const environment = await getEnvironment(db, environmentId, owner);
    expect(environment.egressRequiredHosts).toEqual(['api.example.com', 'cdn.example.com']);
  });

  test('update rejects more than 50 required hosts', async () => {
    const user = await insertTestUser();
    const environmentId = await createEnv(userOwner(user.id), 'acme/widgets');
    const hosts = Array.from({ length: 51 }, (_, index) => `host-${index}.example.com`);

    await expect(
      db.transaction(tx =>
        updateEnvironment(tx, '', {
          owner: userOwner(user.id),
          environmentId,
          requiredHosts: hosts,
        })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('update rejects an invalid host', async () => {
    const user = await insertTestUser();
    const environmentId = await createEnv(userOwner(user.id), 'acme/widgets');

    await expect(
      db.transaction(tx =>
        updateEnvironment(tx, '', {
          owner: userOwner(user.id),
          environmentId,
          requiredHosts: ['https://api.example.com'],
        })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('required hosts and the allowlist together stay within 100 hostnames', async () => {
    const user = await insertTestUser();
    const environmentId = await createEnv(userOwner(user.id), 'acme/widgets');
    const owner = userOwner(user.id);
    const allowlist = Array.from({ length: 60 }, (_, index) => `allowed-${index}.example.com`);
    const requiredHosts = Array.from({ length: 41 }, (_, index) => `required-${index}.example.com`);

    await db.transaction(tx =>
      updateEnvironment(tx, '', {
        owner,
        environmentId,
        egressMode: 'allowlist',
        egressAllowlist: allowlist,
      })
    );

    await expect(
      db.transaction(tx => updateEnvironment(tx, '', { owner, environmentId, requiredHosts }))
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('stored required hosts survive an unrelated update', async () => {
    const user = await insertTestUser();
    const environmentId = await createEnv(userOwner(user.id), 'acme/widgets');
    const owner = userOwner(user.id);
    await db.transaction(tx =>
      updateEnvironment(tx, '', { owner, environmentId, requiredHosts: ['api.example.com'] })
    );

    const { configurationRevision } = await db.transaction(tx =>
      updateEnvironment(tx, '', { owner, environmentId, name: 'renamed' })
    );

    expect(configurationRevision).toBe(2);
    const environment = await getEnvironment(db, environmentId, owner);
    expect(environment.egressRequiredHosts).toEqual(['api.example.com']);
    expect(environment.name).toBe('renamed');
  });

  test('network edits validate stored required hosts and preserve a valid policy on rejection', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const environmentId = await createEnv(owner, 'acme/widgets');
    const requiredHosts = Array.from({ length: 41 }, (_, index) => `required-${index}.example.com`);
    const allowlist = Array.from({ length: 59 }, (_, index) => `allowed-${index}.example.com`);
    await db.transaction(tx => updateEnvironment(tx, '', { owner, environmentId, requiredHosts }));
    await db.transaction(tx =>
      updateEnvironment(tx, '', {
        owner,
        environmentId,
        egressMode: 'allowlist',
        egressAllowlist: allowlist,
      })
    );
    const before = await getEnvironment(db, environmentId, owner);
    await expect(
      db.transaction(tx =>
        updateEnvironment(tx, '', {
          owner,
          environmentId,
          egressMode: 'allowlist',
          egressAllowlist: [...allowlist, 'overflow.example.com'],
        })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await getEnvironment(db, environmentId, owner)).toEqual(before);
  });
});

type TargetOptions = {
  repoFullName?: string;
  commands?: string[];
  plainVars?: Record<string, string>;
  secrets?: Record<string, string>;
  sandboxAllocation?: string | null;
  egressMode?: 'unrestricted' | 'allowlist';
  egressAllowlist?: string[];
  requiredHosts?: string[];
};

async function createTargetEnvironment(
  owner: EnvironmentOwner,
  options: TargetOptions = {}
): Promise<string> {
  return db.transaction(async tx => {
    const { id } = await createEnvironment(tx, setupPublicKeyBase64, {
      owner,
      createdByUserId: owner.id,
      name: 'target environment',
      repositories: [{ platform: 'github', repoFullName: options.repoFullName ?? 'acme/widgets' }],
      commands: options.commands ?? [],
      plainVars: options.plainVars ?? {},
      secrets: options.secrets ?? {},
      sandboxAllocation: options.sandboxAllocation ?? null,
      ...(options.egressMode === undefined ? {} : { egressMode: options.egressMode }),
      ...(options.egressAllowlist === undefined
        ? {}
        : { egressAllowlist: options.egressAllowlist }),
    });
    if (options.requiredHosts !== undefined) {
      await updateEnvironment(tx, setupPublicKeyBase64, {
        owner,
        environmentId: id,
        requiredHosts: options.requiredHosts,
      });
    }
    return id;
  });
}

type DraftRunOptions = {
  targetEnvironmentId?: string;
  initialSecrets?: Record<string, string>;
  sandboxOptions?: string[];
  repositories?: EnvironmentRepositoryEntry[];
};

async function createDraftRun(
  owner: EnvironmentOwner,
  options: DraftRunOptions = {}
): Promise<CreateSetupRunWithDraftResult> {
  return db.transaction(tx =>
    createSetupRunWithDraft(tx, setupPublicKeyBase64, {
      owner,
      createdByUserId: owner.id,
      repositories: options.repositories ?? [{ platform: 'github', repoFullName: 'acme/widgets' }],
      ...(options.targetEnvironmentId === undefined
        ? {}
        : { targetEnvironmentId: options.targetEnvironmentId }),
      ...(options.initialSecrets === undefined ? {} : { initialSecrets: options.initialSecrets }),
      requirements: 'Set up the local development stack.',
      model: 'anthropic/claude-sonnet-4',
      launchRepoFullName: 'acme/widgets',
      sandboxOptions: options.sandboxOptions ?? ['standard-2', 'standard-4'],
      egressMode: 'allowlist',
    })
  );
}

async function startDraftRun(
  owner: EnvironmentOwner,
  options: DraftRunOptions = {}
): Promise<CreateSetupRunWithDraftResult> {
  const created = await createDraftRun(owner, options);
  await db.transaction(tx =>
    attachSetupSession(tx, {
      runId: created.runId,
      owner,
      cloudAgentSessionId: `ses_${created.runId}`,
      kiloSessionId: null,
    })
  );
  return created;
}

async function storedVars(
  environmentId: string
): Promise<{ key: string; value: string; isSecret: boolean }[]> {
  return db
    .select({
      key: cloud_agent_environment_vars.key,
      value: cloud_agent_environment_vars.value,
      isSecret: cloud_agent_environment_vars.is_secret,
    })
    .from(cloud_agent_environment_vars)
    .where(eq(cloud_agent_environment_vars.environment_id, environmentId))
    .orderBy(cloud_agent_environment_vars.key);
}

async function environmentRow(environmentId: string) {
  const [row] = await db
    .select()
    .from(cloud_agent_environments)
    .where(eq(cloud_agent_environments.id, environmentId));
  return row;
}

const CHECKS: EnvironmentSetupCheck[] = [
  { name: 'tests', command: 'npm test', expect: 'all tests pass' },
];

describe('setup run creation', () => {
  afterEach(cleanupDbForTest);

  test.each([
    { name: 'new default', current: undefined, selected: undefined, expected: 'unrestricted' },
    { name: 'new restricted', current: undefined, selected: 'allowlist', expected: 'allowlist' },
    {
      name: 'existing full',
      current: 'unrestricted',
      selected: undefined,
      expected: 'unrestricted',
    },
    {
      name: 'existing restricted',
      current: 'allowlist',
      selected: undefined,
      expected: 'allowlist',
    },
    {
      name: 'choose full',
      current: 'allowlist',
      selected: 'unrestricted',
      expected: 'unrestricted',
    },
    {
      name: 'choose restricted',
      current: 'unrestricted',
      selected: 'allowlist',
      expected: 'allowlist',
    },
  ] as const)('respects the network choice for $name', async ({ current, selected, expected }) => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetEnvironmentId =
      current === undefined
        ? undefined
        : await createTargetEnvironment(owner, { egressMode: current });
    const { draftEnvironmentId } = await db.transaction(tx =>
      createSetupRunWithDraft(tx, '', {
        owner,
        createdByUserId: user.id,
        repositories: [{ platform: 'github', repoFullName: 'acme/widgets' }],
        targetEnvironmentId,
        egressMode: selected,
        requirements: 'Run tests',
        model: 'test/model',
        launchRepoFullName: 'acme/widgets',
        sandboxOptions: ['cloudflare-containers-standard-3'],
      })
    );
    expect((await getEnvironment(db, draftEnvironmentId, owner)).egressMode).toBe(expected);
    if (targetEnvironmentId)
      expect((await getEnvironment(db, targetEnvironmentId, owner)).egressMode).toBe(current);
  });

  test('creates a draft with encrypted secrets and a starting run', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);

    const { runId, draftEnvironmentId } = await createDraftRun(owner, {
      initialSecrets: { API_TOKEN: 'generated-secret-value' },
    });

    const draft = await getEnvironment(db, draftEnvironmentId, owner);
    expect(draft.isDraft).toBe(true);
    expect(draft.repositories).toEqual([{ platform: 'github', repoFullName: 'acme/widgets' }]);
    expect(draft.secretKeys).toEqual(['API_TOKEN']);
    const [stored] = await storedVars(draftEnvironmentId);
    expect(stored.isSecret).toBe(true);
    expect(stored.value).not.toContain('generated-secret-value');

    const run = await getSetupRun(db, runId, owner);
    expect(run.status).toBe('starting');
    expect(run.target_environment_id).toBeNull();
    expect(run.target_settings_at_fork).toBeNull();
    expect(run.verification_limit).toBe(6);
  });

  test('copies the target configuration and stores its fork settings', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetId = await createTargetEnvironment(owner, {
      commands: ['npm ci'],
      plainVars: { NODE_ENV: 'development' },
      secrets: { TARGET_SECRET: 'target-secret-value' },
      sandboxAllocation: 'standard-4',
      egressMode: 'allowlist',
      egressAllowlist: ['api.example.com'],
      requiredHosts: ['api.example.com'],
    });

    const targetBefore = await environmentRow(targetId);
    const targetVars = await storedVars(targetId);
    const { runId, draftEnvironmentId } = await createDraftRun(owner, {
      targetEnvironmentId: targetId,
    });

    const draft = await getEnvironment(db, draftEnvironmentId, owner);
    expect(draft.commands).toEqual(['npm ci']);
    expect(draft.plainVars.map(variable => [variable.key, variable.value])).toEqual([
      ['NODE_ENV', 'development'],
    ]);
    expect(draft.sandboxAllocation).toBe('standard-4');
    expect(draft.egressMode).toBe('allowlist');
    expect(draft.egressAllowlist).toEqual(['api.example.com']);
    expect(draft.egressRequiredHosts).toEqual(['api.example.com']);
    expect(await storedVars(draftEnvironmentId)).toEqual(targetVars);

    const run = await getSetupRun(db, runId, owner);
    expect(run.target_revision_at_fork).toBe(targetBefore.configuration_revision);
    expect(run.target_settings_at_fork).toEqual({
      sandboxAllocation: 'standard-4',
      egressMode: 'allowlist',
      egressAllowlist: ['api.example.com'],
      egressRequiredHosts: ['api.example.com'],
    });
  });

  test('rejects a second open run for the same target', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetId = await createTargetEnvironment(owner);

    await createDraftRun(owner, { targetEnvironmentId: targetId });

    await expect(createDraftRun(owner, { targetEnvironmentId: targetId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'This environment already has a setup run in progress',
    });
  });

  test('deleting a draft cancels its run and frees the target', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetId = await createTargetEnvironment(owner);
    const first = await createDraftRun(owner, { targetEnvironmentId: targetId });
    await deleteEnvironment(db, first.draftEnvironmentId, owner);

    const second = await createDraftRun(owner, { targetEnvironmentId: targetId });

    const [orphan] = await db
      .select()
      .from(cloud_agent_environment_setup_runs)
      .where(eq(cloud_agent_environment_setup_runs.id, first.runId));
    expect(orphan.status).toBe('cancelled');
    expect(orphan.status_reason).toBe('draft_deleted');
    expect(orphan.completed_at).not.toBeNull();
    expect(second.runId).not.toBe(first.runId);
  });

  test('creates an organization-owned run', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Setup org', user.id, 0);
    const owner: EnvironmentOwner = { type: 'organization', id: organization.id };
    const targetId = await createTargetEnvironment(owner);

    const { runId } = await createDraftRun(owner, { targetEnvironmentId: targetId });

    const run = await getSetupRun(db, runId, owner);
    expect(run.owned_by_organization_id).toBe(organization.id);
    expect(run.owned_by_user_id).toBeNull();
  });
});

describe('updateDraftByAgent', () => {
  afterEach(cleanupDbForTest);

  test.each(['delete', 'replace'] as const)(
    'rejects %s of a user-provided secret',
    async operation => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const { runId, draftEnvironmentId } = await startDraftRun(owner);
      await db.transaction(tx =>
        addSecretRequests(tx, {
          runId,
          owner,
          requests: [{ key: 'API_TOKEN', reason: 'Run tests', references: [] }],
        })
      );
      await db.transaction(tx =>
        updateEnvironment(tx, setupPublicKeyBase64, {
          owner,
          environmentId: draftEnvironmentId,
          secrets: [{ key: 'API_TOKEN', value: 'user-value' }],
        })
      );
      await db.transaction(tx => resolveSecretRequests(tx, { runId, owner, skipped: [] }));
      const before = await storedVars(draftEnvironmentId);
      const draft = await getEnvironment(db, draftEnvironmentId, owner);
      await expect(
        db.transaction(tx =>
          updateDraftByAgent(tx, setupPublicKeyBase64, {
            runId,
            owner,
            expectedRevision: draft.configurationRevision,
            secrets: [
              operation === 'delete'
                ? { key: 'API_TOKEN', delete: true }
                : { key: 'API_TOKEN', value: 'agent-value' },
            ],
          })
        )
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await storedVars(draftEnvironmentId)).toEqual(before);
      expect((await getSetupRun(db, runId, owner)).generated_secret_keys).toEqual([]);
    }
  );

  test('only generated secrets can be deleted, while initial and copied secrets remain', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetEnvironmentId = await createTargetEnvironment(owner, {
      secrets: { COPIED_TOKEN: 'copied-value' },
    });
    const { runId, draftEnvironmentId } = await startDraftRun(owner, {
      targetEnvironmentId,
      initialSecrets: { INITIAL_TOKEN: 'initial-value' },
    });
    for (const key of ['COPIED_TOKEN', 'INITIAL_TOKEN', 'UNKNOWN_TOKEN']) {
      await expect(
        db.transaction(tx =>
          updateDraftByAgent(tx, setupPublicKeyBase64, {
            runId,
            owner,
            expectedRevision: 1,
            secrets: [{ key, delete: true }],
          })
        )
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    const { configurationRevision } = await db.transaction(tx =>
      updateDraftByAgent(tx, setupPublicKeyBase64, {
        runId,
        owner,
        expectedRevision: 1,
        secrets: [{ key: 'GENERATED_TOKEN', value: 'generated-value' }],
      })
    );
    expect((await getSetupRun(db, runId, owner)).generated_secret_keys).toEqual([
      'GENERATED_TOKEN',
    ]);
    await db.transaction(tx =>
      updateDraftByAgent(tx, setupPublicKeyBase64, {
        runId,
        owner,
        expectedRevision: configurationRevision,
        secrets: [{ key: 'GENERATED_TOKEN', delete: true }],
      })
    );
    expect((await getEnvironment(db, draftEnvironmentId, owner)).secretKeys.sort()).toEqual([
      'COPIED_TOKEN',
      'INITIAL_TOKEN',
    ]);
    expect((await getSetupRun(db, runId, owner)).generated_secret_keys).toEqual([]);
  });

  test('rejects a stale expected revision', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId } = await startDraftRun(owner);

    await expect(
      db.transaction(tx =>
        updateDraftByAgent(tx, setupPublicKeyBase64, {
          runId,
          owner,
          expectedRevision: 99,
          script: 'npm run setup',
        })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('rejects an allocation that was not offered', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId } = await startDraftRun(owner, { sandboxOptions: ['standard-2'] });

    await expect(
      db.transaction(tx =>
        updateDraftByAgent(tx, setupPublicKeyBase64, {
          runId,
          owner,
          expectedRevision: 1,
          sandboxAllocation: 'standard-8',
        })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('rejects required hosts under a restricted draft', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetId = await createTargetEnvironment(owner, {
      egressMode: 'allowlist',
      egressAllowlist: ['api.example.com'],
    });
    const { runId } = await startDraftRun(owner, { targetEnvironmentId: targetId });

    await expect(
      db.transaction(tx =>
        updateDraftByAgent(tx, setupPublicKeyBase64, {
          runId,
          owner,
          expectedRevision: 1,
          requiredHosts: ['cdn.example.com'],
        })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('rejects a network policy change on a draft that has a target', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetId = await createTargetEnvironment(owner);
    const { draftEnvironmentId } = await startDraftRun(owner, { targetEnvironmentId: targetId });

    await expect(
      db.transaction(tx =>
        updateEnvironment(tx, setupPublicKeyBase64, {
          owner,
          environmentId: draftEnvironmentId,
          egressMode: 'allowlist',
          egressAllowlist: ['api.example.com'],
        })
      )
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Change the network policy on the target environment',
    });
  });

  test('a script change bumps the revision and clears a pending verification', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId, draftEnvironmentId } = await startDraftRun(owner);

    await db.transaction(tx => reserveVerification(tx, { runId, owner, checks: CHECKS }));

    const { configurationRevision } = await db.transaction(tx =>
      updateDraftByAgent(tx, setupPublicKeyBase64, {
        runId,
        owner,
        expectedRevision: 1,
        script: 'npm ci && npm run setup',
      })
    );

    expect(configurationRevision).toBe(2);
    const run = await getSetupRun(db, runId, owner);
    expect(run.pending_verification).toBeNull();
    expect(run.status).toBe('running');
    const draft = await getEnvironment(db, draftEnvironmentId, owner);
    expect(draft.commands).toEqual(['npm ci && npm run setup']);
  });

  test('cancels a run whose draft was deleted before a write', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId, draftEnvironmentId } = await startDraftRun(owner);
    await deleteEnvironment(db, draftEnvironmentId, owner);

    await expect(
      db.transaction(tx =>
        updateDraftByAgent(tx, setupPublicKeyBase64, {
          runId,
          owner,
          expectedRevision: 1,
          script: 'npm run setup',
        })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'Setup run is cancelled' });

    const run = await getSetupRun(db, runId, owner);
    expect(run.status).toBe('cancelled');
    expect(run.status_reason).toBe('draft_deleted');
  });
});

describe('setup secret requests', () => {
  afterEach(cleanupDbForTest);

  test('an added request moves the run to needs_input', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId } = await startDraftRun(owner);

    await db.transaction(tx =>
      addSecretRequests(tx, {
        runId,
        owner,
        requests: [
          {
            key: 'PROD_STRIPE_SECRET_KEY',
            reason: 'The test suite needs a Stripe key.',
            references: [{ repoFullName: 'acme/widgets', path: 'src/stripe.ts', line: 12 }],
          },
        ],
      })
    );

    const run = await getSetupRun(db, runId, owner);
    expect(run.status).toBe('needs_input');
    expect(run.secret_requests).toHaveLength(1);
    expect(run.secret_requests[0]).toMatchObject({
      key: 'PROD_STRIPE_SECRET_KEY',
      state: 'pending',
      highPrivilege: true,
    });
  });

  test('resolving provided and skipped keys resumes the run', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId, draftEnvironmentId } = await startDraftRun(owner);
    await db.transaction(tx =>
      addSecretRequests(tx, {
        runId,
        owner,
        requests: [
          { key: 'FIRST_KEY', reason: 'Needed first.', references: [] },
          { key: 'SECOND_KEY', reason: 'Needed second.', references: [] },
        ],
      })
    );
    await db.transaction(tx =>
      updateEnvironment(tx, setupPublicKeyBase64, {
        owner,
        environmentId: draftEnvironmentId,
        secrets: [{ key: 'FIRST_KEY', value: 'first-value' }],
      })
    );

    const result = await db.transaction(tx =>
      resolveSecretRequests(tx, { runId, owner, skipped: ['SECOND_KEY'] })
    );

    expect(result).toEqual({
      provided: ['FIRST_KEY'],
      skipped: ['SECOND_KEY'],
      stillPending: [],
      resumed: true,
    });
    const run = await getSetupRun(db, runId, owner);
    expect(run.status).toBe('running');
    expect(run.secret_requests.map(request => [request.key, request.state])).toEqual([
      ['FIRST_KEY', 'provided'],
      ['SECOND_KEY', 'skipped'],
    ]);
  });

  test('rejects reserved and already-set keys', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId } = await startDraftRun(owner, { initialSecrets: { EXISTING_KEY: 'value' } });

    await expect(
      db.transaction(tx =>
        addSecretRequests(tx, {
          runId,
          owner,
          requests: [{ key: 'HOME', reason: 'Reserved.', references: [] }],
        })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await expect(
      db.transaction(tx =>
        addSecretRequests(tx, {
          runId,
          owner,
          requests: [{ key: 'EXISTING_KEY', reason: 'Already set.', references: [] }],
        })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('setup network requests', () => {
  afterEach(cleanupDbForTest);

  test('rejects a request under an unrestricted policy', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId, draftEnvironmentId } = await startDraftRun(owner);
    await db.transaction(tx =>
      updateEnvironment(tx, '', {
        environmentId: draftEnvironmentId,
        owner,
        egressMode: 'unrestricted',
      })
    );

    await expect(
      db.transaction(tx =>
        addNetworkRequests(tx, {
          runId,
          owner,
          requests: [
            {
              host: 'cdn.example.com',
              reason: 'The build downloads assets.',
              evidence: { childSessionId: 'child-1', deniedCount: 3 },
            },
          ],
        })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('approving a host adds it to the draft and bumps the revision', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetId = await createTargetEnvironment(owner, {
      egressMode: 'allowlist',
      egressAllowlist: ['api.example.com'],
      requiredHosts: ['api.example.com'],
    });
    const { runId, draftEnvironmentId } = await startDraftRun(owner, {
      targetEnvironmentId: targetId,
    });

    await db.transaction(tx =>
      addNetworkRequests(tx, {
        runId,
        owner,
        requests: [
          {
            host: 'cdn.example.com',
            reason: 'The build downloads assets.',
            evidence: { childSessionId: 'child-1', deniedCount: 3 },
          },
        ],
      })
    );
    expect((await getSetupRun(db, runId, owner)).status).toBe('needs_input');

    const { resumed } = await db.transaction(tx =>
      resolveNetworkRequests(tx, setupPublicKeyBase64, {
        runId,
        owner,
        approved: ['cdn.example.com'],
        declined: [],
      })
    );

    expect(resumed).toBe(true);
    const draft = await getEnvironment(db, draftEnvironmentId, owner);
    expect(draft.egressRequiredHosts).toEqual(['api.example.com', 'cdn.example.com']);
    expect(draft.configurationRevision).toBe(2);
    const run = await getSetupRun(db, runId, owner);
    expect(run.network_requests[0]).toMatchObject({ state: 'approved' });
    expect(run.status).toBe('running');
  });

  test('caps network requests per run, including declined hosts', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetId = await createTargetEnvironment(owner, {
      egressMode: 'allowlist',
      egressAllowlist: ['api.example.com'],
    });
    const { runId } = await startDraftRun(owner, { targetEnvironmentId: targetId });
    const declined = Array.from(
      { length: ENVIRONMENT_SETUP_LIMITS.MAX_NETWORK_REQUESTS_PER_RUN },
      (_, index) => ({
        host: `host-${index}.example.com`,
        reason: 'The build downloads assets.',
        evidence: { childSessionId: 'child-1', deniedCount: 1 },
        state: 'declined' as const,
        requestedAt: new Date().toISOString(),
      })
    );
    await db
      .update(cloud_agent_environment_setup_runs)
      .set({ network_requests: declined })
      .where(eq(cloud_agent_environment_setup_runs.id, runId));

    await expect(
      db.transaction(tx =>
        addNetworkRequests(tx, {
          runId,
          owner,
          requests: [
            {
              host: 'host-0.example.com',
              reason: 'Asking again.',
              evidence: { childSessionId: 'child-1', deniedCount: 1 },
            },
          ],
        })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await getSetupRun(db, runId, owner)).status).toBe('running');
  });
});

describe('setup verification', () => {
  afterEach(cleanupDbForTest);

  test('reserve, attach and record move through verifying to running', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId } = await startDraftRun(owner);

    const reserved = await db.transaction(tx =>
      reserveVerification(tx, { runId, owner, checks: CHECKS })
    );
    expect(reserved).toMatchObject({ status: 'reserved', configurationRevision: 1 });
    if (reserved.status !== 'reserved') throw new Error('expected a reservation');

    await db.transaction(tx =>
      attachVerificationChild(tx, {
        runId,
        owner,
        operationKey: reserved.operationKey,
        childSessionId: 'child-session',
        childKiloSessionId: 'kilo-child',
      })
    );
    const attached = await getSetupRun(db, runId, owner);
    expect(attached.status).toBe('verifying');
    expect(attached.pending_verification?.childSessionId).toBe('child-session');
    expect(attached.pending_verification?.sandboxAllocation).toBeNull();
    expect(attached.pending_verification?.egressAllowlist).toEqual([]);
    expect(attached.verification_count).toBe(1);

    await db.transaction(tx =>
      recordVerification(tx, {
        runId,
        owner,
        childSessionId: 'child-session',
        verification: {
          childSessionId: 'child-session',
          childKiloSessionId: 'kilo-child',
          configurationRevision: 1,
          preparation: 'completed',
          preparationError: null,
          setupDurationMs: 1000,
          egressMode: 'unrestricted',
          checks: CHECKS,
          results: [{ name: 'tests', passed: true, evidence: 'all tests pass' }],
          recordedAt: new Date().toISOString(),
        },
      })
    );

    const run = await getSetupRun(db, runId, owner);
    expect(run.status).toBe('running');
    expect(run.pending_verification).toBeNull();
    expect(run.last_verification?.childSessionId).toBe('child-session');
    expect(run.last_verification?.sandboxAllocation).toBeNull();
    expect(run.last_verification?.egressAllowlist).toEqual([]);
  });

  test('an abandoned unbound reservation can be replaced after thirty minutes', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId } = await startDraftRun(owner);
    const first = await db.transaction(tx =>
      reserveVerification(tx, { runId, owner, checks: CHECKS })
    );
    if (first.status !== 'reserved') throw new Error('expected a reservation');
    const run = await getSetupRun(db, runId, owner);
    if (!run.pending_verification) throw new Error('expected a pending verification');
    await db
      .update(cloud_agent_environment_setup_runs)
      .set({
        pending_verification: {
          ...run.pending_verification,
          startedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
        },
      })
      .where(eq(cloud_agent_environment_setup_runs.id, runId));

    const second = await db.transaction(tx =>
      reserveVerification(tx, { runId, owner, checks: CHECKS })
    );
    if (second.status !== 'reserved') throw new Error('expected a reservation');
    expect(second.operationKey).not.toBe(first.operationKey);
    await expect(
      db.transaction(tx =>
        attachVerificationChild(tx, {
          runId,
          owner,
          operationKey: first.operationKey,
          childSessionId: 'stale-child',
          childKiloSessionId: null,
        })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await getSetupRun(db, runId, owner)).pending_verification?.operationKey).toBe(
      second.operationKey
    );
  });

  test('rerecording an old child cannot clear a newer verification', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId } = await startDraftRun(owner);
    const verification = (childSessionId: string): EnvironmentSetupVerification => ({
      childSessionId,
      childKiloSessionId: null,
      configurationRevision: 1,
      preparation: 'completed',
      preparationError: null,
      setupDurationMs: 1000,
      egressMode: 'unrestricted',
      checks: CHECKS,
      results: [{ name: 'tests', passed: true, evidence: 'all tests pass' }],
      recordedAt: new Date().toISOString(),
    });
    const reserveAndAttach = async (childSessionId: string) => {
      const reserved = await db.transaction(tx =>
        reserveVerification(tx, { runId, owner, checks: CHECKS })
      );
      if (reserved.status !== 'reserved') throw new Error('expected a reservation');
      await db.transaction(tx =>
        attachVerificationChild(tx, {
          runId,
          owner,
          operationKey: reserved.operationKey,
          childSessionId,
          childKiloSessionId: null,
        })
      );
    };
    const record = (childSessionId: string) =>
      db.transaction(tx =>
        recordVerification(tx, {
          runId,
          owner,
          childSessionId,
          verification: verification(childSessionId),
        })
      );
    await reserveAndAttach('child-A');
    await record('child-A');
    await record('child-A');
    await reserveAndAttach('child-B');
    const before = await getSetupRun(db, runId, owner);

    await expect(record('child-A')).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'A newer verification is pending. Record its results before updating an earlier verification.',
    });
    expect(await getSetupRun(db, runId, owner)).toEqual(before);
    expect(before.status).toBe('verifying');
    expect(before.pending_verification?.childSessionId).toBe('child-B');
    await record('child-B');
    expect(await getSetupRun(db, runId, owner)).toMatchObject({
      status: 'running',
      pending_verification: null,
      last_verification: { childSessionId: 'child-B' },
    });
  });

  test('rejects recording a verification this run did not start', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId } = await startDraftRun(owner);

    await expect(
      db.transaction(tx =>
        recordVerification(tx, {
          runId,
          owner,
          childSessionId: 'someone-elses-child',
          verification: {
            childSessionId: 'someone-elses-child',
            childKiloSessionId: null,
            configurationRevision: 1,
            preparation: 'completed',
            preparationError: null,
            setupDurationMs: 1000,
            egressMode: 'unrestricted',
            checks: CHECKS,
            results: [{ name: 'tests', passed: true, evidence: 'all tests pass' }],
            recordedAt: new Date().toISOString(),
          },
        })
      )
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message:
        'Unknown verification session. A draft change may have superseded it; start a new verification.',
    });
  });

  test('rejects attaching a stale verification operation', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId } = await startDraftRun(owner);
    await db.transaction(tx => reserveVerification(tx, { runId, owner, checks: CHECKS }));

    await expect(
      db.transaction(tx =>
        attachVerificationChild(tx, {
          runId,
          owner,
          operationKey: 'stale-operation',
          childSessionId: 'child-session',
          childKiloSessionId: null,
        })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('the limit returns a discriminated result and fails the run', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId } = await startDraftRun(owner);
    await db
      .update(cloud_agent_environment_setup_runs)
      .set({ verification_limit: 0 })
      .where(eq(cloud_agent_environment_setup_runs.id, runId));

    const result = await db.transaction(tx =>
      reserveVerification(tx, { runId, owner, checks: CHECKS })
    );

    expect(result).toEqual({ status: 'limit_reached' });
    const run = await getSetupRun(db, runId, owner);
    expect(run.status).toBe('failed');
    expect(run.status_reason).toBe('verification_limit_reached');
  });

  test('release decrements the count and restores the status', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId } = await startDraftRun(owner);
    const reserved = await db.transaction(tx =>
      reserveVerification(tx, { runId, owner, checks: CHECKS })
    );
    if (reserved.status !== 'reserved') throw new Error('expected a reservation');

    await db.transaction(tx =>
      releaseVerification(tx, { runId, owner, operationKey: reserved.operationKey })
    );

    const run = await getSetupRun(db, runId, owner);
    expect(run.verification_count).toBe(0);
    expect(run.pending_verification).toBeNull();
    expect(run.status).toBe('running');
  });

  test('resume after reaching the limit raises it', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId } = await startDraftRun(owner);
    await db
      .update(cloud_agent_environment_setup_runs)
      .set({ verification_limit: 0 })
      .where(eq(cloud_agent_environment_setup_runs.id, runId));
    await db.transaction(tx => reserveVerification(tx, { runId, owner, checks: CHECKS }));

    await db.transaction(tx => resumeSetupRun(tx, { runId, owner, raiseVerificationLimit: true }));

    const run = await getSetupRun(db, runId, owner);
    expect(run.status).toBe('running');
    expect(run.verification_limit).toBe(6);
    expect(run.status_reason).toBeNull();
  });
});

describe('publishing setup runs', () => {
  test('rechecks the current revision after an outside gate check passed', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId, draftEnvironmentId } = await startDraftRun(owner);
    const draft = await getEnvironment(db, draftEnvironmentId, owner);
    await db
      .update(cloud_agent_environment_setup_runs)
      .set({
        last_verification: {
          childSessionId: 'child-session',
          childKiloSessionId: null,
          configurationRevision: draft.configurationRevision,
          preparation: 'completed',
          preparationError: null,
          setupDurationMs: 1,
          egressMode: 'allowlist',
          egressAllowlist: [],
          checks: CHECKS,
          results: CHECKS.map(check => ({ name: check.name, passed: true, evidence: 'ok' })),
          recordedAt: new Date().toISOString(),
        },
      })
      .where(eq(cloud_agent_environment_setup_runs.id, runId));
    const run = await getSetupRun(db, runId, owner);
    expect(
      evaluateCompletionGate({
        draftRevision: draft.configurationRevision,
        draftSandboxAllocation: draft.sandboxAllocation,
        draftEgressMode: draft.egressMode,
        draftEgressAllowlist: draft.egressAllowlist,
        draftEgressRequiredHosts: draft.egressRequiredHosts,
        run,
      })
    ).toEqual({ ok: true });
    await db.transaction(tx =>
      updateEnvironment(tx, '', {
        environmentId: draftEnvironmentId,
        owner,
        commands: ['echo changed after verification'],
      })
    );
    await expect(
      db.transaction(tx => publishSetupRun(tx, { runId, owner, mode: 'gate' }))
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('revision'),
    });
    expect((await getEnvironment(db, draftEnvironmentId, owner)).isDraft).toBe(true);
    expect((await getSetupRun(db, runId, owner)).status).toBe('running');
  });

  afterEach(cleanupDbForTest);

  test('publishes a new environment by clearing the draft flag', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId, draftEnvironmentId } = await startDraftRun(owner);

    const result = await db.transaction(tx =>
      publishWithPassingVerification(tx, { runId, owner, mode: 'gate' })
    );

    expect(result).toEqual({
      status: 'published',
      environmentId: draftEnvironmentId,
      configurationRevision: 1,
    });
    const environment = await getEnvironment(db, draftEnvironmentId, owner);
    expect(environment.isDraft).toBe(false);
    const run = await getSetupRun(db, runId, owner);
    expect(run.status).toBe('published');
    expect(run.previous_configuration).toBeNull();
    expect(run.published_environment_id).toBe(draftEnvironmentId);
  });

  test('publishes a draft into its target and keeps the old configuration', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetId = await createTargetEnvironment(owner, {
      commands: ['npm run old'],
      plainVars: { OLD_VAR: 'old-value' },
      secrets: { OLD_SECRET: 'old-secret-value' },
      sandboxAllocation: 'standard-2',
    });
    const targetBefore = await environmentRow(targetId);
    const targetVarsBefore = await storedVars(targetId);
    const { runId, draftEnvironmentId } = await startDraftRun(owner, {
      targetEnvironmentId: targetId,
    });
    await db.transaction(tx =>
      updateDraftByAgent(tx, setupPublicKeyBase64, {
        runId,
        owner,
        expectedRevision: 1,
        script: 'npm run new',
        plainVars: { NEW_VAR: 'new-value' },
        sandboxAllocation: 'standard-4',
      })
    );
    const draftVarsBefore = await storedVars(draftEnvironmentId);

    const result = await db.transaction(tx =>
      publishWithPassingVerification(tx, { runId, owner, mode: 'gate' })
    );

    expect(result).toEqual({
      status: 'published',
      environmentId: targetId,
      configurationRevision: targetBefore.configuration_revision + 1,
    });
    const target = await getEnvironment(db, targetId, owner);
    expect(target.commands).toEqual(['npm run new']);
    expect(target.sandboxAllocation).toBe('standard-4');
    expect(target.plainVars.map(variable => [variable.key, variable.value])).toEqual([
      ['NEW_VAR', 'new-value'],
    ]);
    expect(target.secretKeys).toEqual(['OLD_SECRET']);
    expect(await storedVars(targetId)).toEqual(draftVarsBefore);

    const run = await getSetupRun(db, runId, owner);
    expect(run.status).toBe('published');
    expect(run.draft_environment_id).toBeNull();
    expect(run.published_revision).toBe(targetBefore.configuration_revision + 1);
    expect(run.previous_configuration?.vars).toEqual(
      targetVarsBefore.map(variable => ({
        key: variable.key,
        value: variable.value,
        isSecret: variable.isSecret,
      }))
    );
    expect(run.previous_configuration?.sandboxAllocation).toBe('standard-2');
    expect(run.previous_configuration?.revision).toBe(targetBefore.configuration_revision);
    expect(run.published_settings).toEqual({
      sandboxAllocation: 'standard-4',
      egressMode: 'allowlist',
      egressAllowlist: [],
      egressRequiredHosts: null,
    });

    await expect(getEnvironment(db, draftEnvironmentId, owner)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  test('a target changed after the fork is a conflict unless forced', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetId = await createTargetEnvironment(owner, { commands: ['npm run old'] });
    const { runId } = await startDraftRun(owner, { targetEnvironmentId: targetId });
    await db.transaction(tx =>
      updateEnvironment(tx, setupPublicKeyBase64, {
        owner,
        environmentId: targetId,
        commands: ['npm run edited'],
      })
    );

    const conflictResult = await db.transaction(tx =>
      publishWithPassingVerification(tx, { runId, owner, mode: 'gate' })
    );
    expect(conflictResult).toEqual({ status: 'publish_conflict' });
    expect((await getSetupRun(db, runId, owner)).status).toBe('publish_conflict');

    const forced = await db.transaction(tx =>
      publishWithPassingVerification(tx, { runId, owner, mode: 'force' })
    );
    expect(forced).toMatchObject({ status: 'published', environmentId: targetId });
  });

  test('a target network change after the fork is a conflict even without a revision bump', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetId = await createTargetEnvironment(owner);
    const { runId } = await startDraftRun(owner, { targetEnvironmentId: targetId });
    await db.transaction(tx =>
      updateEnvironment(tx, setupPublicKeyBase64, {
        owner,
        environmentId: targetId,
        egressMode: 'allowlist',
        egressAllowlist: ['target.example.com'],
      })
    );
    expect((await environmentRow(targetId)).configuration_revision).toBe(1);

    const result = await db.transaction(tx =>
      publishWithPassingVerification(tx, { runId, owner, mode: 'gate' })
    );

    expect(result).toEqual({ status: 'publish_conflict' });
  });

  test('a forced publish into a newly allowlisted target keeps its policy and only approved hosts (synthetic draft network state)', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetId = await createTargetEnvironment(owner);
    const { runId, draftEnvironmentId } = await startDraftRun(owner, {
      targetEnvironmentId: targetId,
    });
    await db
      .update(cloud_agent_environments)
      .set({
        egress_mode: 'allowlist',
        egress_allowlist: ['draft.example.com'],
        egress_required_hosts: ['recorded.example.com'],
      })
      .where(eq(cloud_agent_environments.id, draftEnvironmentId));
    await db.transaction(tx =>
      addNetworkRequests(tx, {
        runId,
        owner,
        requests: [
          {
            host: 'approved.example.com',
            reason: 'The build downloads assets.',
            evidence: { childSessionId: 'child-1', deniedCount: 1 },
          },
        ],
      })
    );
    await db.transaction(tx =>
      resolveNetworkRequests(tx, setupPublicKeyBase64, {
        runId,
        owner,
        approved: ['approved.example.com'],
        declined: [],
      })
    );
    await db.transaction(tx =>
      updateEnvironment(tx, setupPublicKeyBase64, {
        owner,
        environmentId: targetId,
        egressMode: 'allowlist',
        egressAllowlist: ['target.example.com'],
        requiredHosts: ['target-required.example.com'],
      })
    );

    const conflictResult = await db.transaction(tx =>
      publishWithPassingVerification(tx, { runId, owner, mode: 'gate' })
    );
    expect(conflictResult).toEqual({ status: 'publish_conflict' });

    await db.transaction(tx => publishWithPassingVerification(tx, { runId, owner, mode: 'force' }));

    const target = await getEnvironment(db, targetId, owner);
    expect(target.egressMode).toBe('allowlist');
    expect(target.egressAllowlist).toEqual(['target.example.com']);
    expect(target.egressRequiredHosts).toEqual([
      'target-required.example.com',
      'approved.example.com',
    ]);
  });

  test('publishing a missing draft reports draft_missing', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId, draftEnvironmentId } = await startDraftRun(owner);
    await deleteEnvironment(db, draftEnvironmentId, owner);

    const result = await db.transaction(tx =>
      publishWithPassingVerification(tx, { runId, owner, mode: 'gate' })
    );

    expect(result).toEqual({ status: 'draft_missing' });
    const run = await getSetupRun(db, runId, owner);
    expect(run.status).toBe('cancelled');
    expect(run.status_reason).toBe('draft_deleted');
  });
});

describe('reverting setup runs', () => {
  afterEach(cleanupDbForTest);

  async function publishTargetRun(
    owner: EnvironmentOwner
  ): Promise<{ runId: string; targetId: string; publishedRevision: number }> {
    const targetId = await createTargetEnvironment(owner, {
      commands: ['npm run old'],
      plainVars: { OLD_VAR: 'old-value' },
      secrets: { OLD_SECRET: 'old-secret-value' },
      sandboxAllocation: 'standard-2',
    });
    const { runId } = await startDraftRun(owner, { targetEnvironmentId: targetId });
    await db.transaction(tx =>
      updateDraftByAgent(tx, setupPublicKeyBase64, {
        runId,
        owner,
        expectedRevision: 1,
        script: 'npm run new',
        plainVars: { NEW_VAR: 'new-value' },
      })
    );
    const published = await db.transaction(tx =>
      publishWithPassingVerification(tx, { runId, owner, mode: 'gate' })
    );
    if (published.status !== 'published') throw new Error('expected a published run');
    return { runId, targetId, publishedRevision: published.configurationRevision };
  }

  test('restores the previous variables and bumps the revision', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId, targetId, publishedRevision } = await publishTargetRun(owner);

    await db.transaction(tx => revertSetupRun(tx, { runId, owner }));

    const target = await getEnvironment(db, targetId, owner);
    expect(target.commands).toEqual(['npm run old']);
    expect(target.plainVars.map(variable => [variable.key, variable.value])).toEqual([
      ['OLD_VAR', 'old-value'],
    ]);
    expect(target.secretKeys).toEqual(['OLD_SECRET']);
    expect(target.sandboxAllocation).toBe('standard-2');
    expect(target.configurationRevision).toBe(publishedRevision + 1);
    const run = await getSetupRun(db, runId, owner);
    expect(run.status).toBe('reverted');
    expect(run.previous_configuration).toBeNull();
  });

  test('reverting undoes the allocation and required hosts the publish wrote', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetId = await createTargetEnvironment(owner, { sandboxAllocation: 'standard-2' });
    const { runId } = await startDraftRun(owner, { targetEnvironmentId: targetId });
    await db.transaction(tx =>
      updateDraftByAgent(tx, setupPublicKeyBase64, {
        runId,
        owner,
        expectedRevision: 1,
        sandboxAllocation: 'standard-4',
      })
    );
    await db.transaction(tx =>
      addNetworkRequests(tx, {
        runId,
        owner,
        requests: [
          {
            host: 'draft.example.com',
            reason: 'Download dependencies',
            evidence: { sessionId: 'setup-session', requestCount: 1 },
          },
        ],
      })
    );
    await db.transaction(tx =>
      resolveNetworkRequests(tx, setupPublicKeyBase64, {
        runId,
        owner,
        approved: ['draft.example.com'],
        declined: [],
      })
    );

    const published = await db.transaction(tx =>
      publishWithPassingVerification(tx, { runId, owner, mode: 'gate' })
    );
    expect(published.status).toBe('published');

    const publishedRun = await getSetupRun(db, runId, owner);
    expect(publishedRun.published_settings).toEqual({
      sandboxAllocation: 'standard-4',
      egressMode: 'allowlist',
      egressAllowlist: [],
      egressRequiredHosts: ['draft.example.com'],
    });

    await db.transaction(tx => revertSetupRun(tx, { runId, owner }));

    const target = await getEnvironment(db, targetId, owner);
    expect(target.sandboxAllocation).toBe('standard-2');
    expect(target.egressRequiredHosts).toEqual([]);
    expect((await getSetupRun(db, runId, owner)).status).toBe('reverted');
  });

  test('rejects a manual edit unless forced', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId, targetId } = await publishTargetRun(owner);
    await db.transaction(tx =>
      updateEnvironment(tx, setupPublicKeyBase64, {
        owner,
        environmentId: targetId,
        commands: ['npm run human'],
      })
    );

    await expect(db.transaction(tx => revertSetupRun(tx, { runId, owner }))).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'The environment changed after publication. Revert anyway to overwrite those changes.',
    });

    await db.transaction(tx => revertSetupRun(tx, { runId, owner, force: true }));
    const target = await getEnvironment(db, targetId, owner);
    expect(target.commands).toEqual(['npm run old']);
  });

  test('detects a network settings change at revert', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId, targetId } = await publishTargetRun(owner);
    await db.transaction(tx =>
      updateEnvironment(tx, setupPublicKeyBase64, {
        owner,
        environmentId: targetId,
        egressMode: 'allowlist',
        egressAllowlist: ['human.example.com'],
      })
    );

    await expect(db.transaction(tx => revertSetupRun(tx, { runId, owner }))).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    await db.transaction(tx => revertSetupRun(tx, { runId, owner, force: true }));
    const target = await getEnvironment(db, targetId, owner);
    expect(target.egressMode).toBeNull();
    expect(target.egressAllowlist).toBeNull();
  });

  test.each([false, true])('rejects an expired target rollback with force=%s', async force => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId, targetId } = await publishTargetRun(owner);
    const now = new Date();
    await db
      .update(cloud_agent_environment_setup_runs)
      .set({ completed_at: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString() })
      .where(eq(cloud_agent_environment_setup_runs.id, runId));
    await cleanupSetupRuns(db, now);
    const environmentBefore = await environmentRow(targetId);
    const variablesBefore = await storedVars(targetId);
    const runBefore = await getSetupRun(db, runId, owner);
    expect(runBefore.previous_configuration).toBeNull();

    await expect(
      db.transaction(tx => revertSetupRun(tx, { runId, owner, force }))
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'The previous environment configuration expired. This setup run cannot be reverted.',
    });

    expect(await environmentRow(targetId)).toEqual(environmentBefore);
    expect(await storedVars(targetId)).toEqual(variablesBefore);
    expect(await getSetupRun(db, runId, owner)).toEqual(runBefore);
  });

  test.each([
    { name: 'allocation', change: { sandboxAllocation: 'standard-2' } },
    { name: 'network mode', change: { egressMode: 'unrestricted' as const } },
    {
      name: 'allowlist',
      change: { egressMode: 'allowlist' as const, egressAllowlist: ['human.example.com'] },
    },
  ])('protects a new environment after a $name edit', async ({ change }) => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId, draftEnvironmentId } = await startDraftRun(owner);
    await db.transaction(tx =>
      updateEnvironment(tx, setupPublicKeyBase64, {
        owner,
        environmentId: draftEnvironmentId,
        egressMode: 'allowlist',
        egressAllowlist: [],
      })
    );
    await db.transaction(tx => publishWithPassingVerification(tx, { runId, owner, mode: 'gate' }));
    const published = await getSetupRun(db, runId, owner);
    const environmentAtPublication = await environmentRow(draftEnvironmentId);
    await db.transaction(tx =>
      updateEnvironment(tx, setupPublicKeyBase64, {
        owner,
        environmentId: draftEnvironmentId,
        ...change,
      })
    );
    const environmentBefore = await environmentRow(draftEnvironmentId);
    expect(environmentBefore.configuration_revision).toBe(
      environmentAtPublication.configuration_revision
    );

    await expect(db.transaction(tx => revertSetupRun(tx, { runId, owner }))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await environmentRow(draftEnvironmentId)).toEqual(environmentBefore);
    expect(await getSetupRun(db, runId, owner)).toEqual(published);

    await db.transaction(tx => revertSetupRun(tx, { runId, owner, force: true }));
    expect(await environmentRow(draftEnvironmentId)).toBeUndefined();
    expect((await getSetupRun(db, runId, owner)).status).toBe('reverted');
  });

  test('deletes an environment that publish created', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId, draftEnvironmentId } = await startDraftRun(owner);
    await db.transaction(tx => publishWithPassingVerification(tx, { runId, owner, mode: 'gate' }));

    await db.transaction(tx => revertSetupRun(tx, { runId, owner }));

    await expect(getEnvironment(db, draftEnvironmentId, owner)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await getSetupRun(db, runId, owner)).status).toBe('reverted');
  });
});

describe('setup run reads and cancellation', () => {
  afterEach(cleanupDbForTest);

  test('deleting the draft environment cancels its run', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId, draftEnvironmentId } = await startDraftRun(owner);
    await deleteEnvironment(db, draftEnvironmentId, owner);

    const run = await getSetupRun(db, runId, owner);

    expect(run.status).toBe('cancelled');
    expect(run.status_reason).toBe('draft_deleted');
    expect(run.completed_at).not.toBeNull();
  });

  test('deleting the target environment cancels its open run', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetId = await createTargetEnvironment(owner);
    const { runId } = await startDraftRun(owner, { targetEnvironmentId: targetId });

    await deleteEnvironment(db, targetId, owner);

    const run = await getSetupRun(db, runId, owner);
    expect(run.status).toBe('cancelled');
    expect(run.status_reason).toBe('draft_deleted');
  });

  test('lists runs that touch an environment', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetId = await createTargetEnvironment(owner);
    const { runId, draftEnvironmentId } = await startDraftRun(owner, {
      targetEnvironmentId: targetId,
    });

    expect(
      (await listSetupRunsForEnvironment(db, draftEnvironmentId, owner)).map(run => run.id)
    ).toEqual([runId]);
    expect((await listSetupRunsForEnvironment(db, targetId, owner)).map(run => run.id)).toEqual([
      runId,
    ]);
    const loaded = await loadSetupRunForSession(db, { runId, owner });
    expect(loaded).toEqual({ draftEnvironmentId, status: 'running' });
  });

  test('cancels an open run', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId } = await startDraftRun(owner);

    await db.transaction(tx => cancelSetupRun(tx, { runId, owner }));

    const run = await getSetupRun(db, runId, owner);
    expect(run.status).toBe('cancelled');
    expect(run.completed_at).not.toBeNull();
  });
});

describe('cleanupSetupRuns', () => {
  afterEach(cleanupDbForTest);

  const DAY = 24 * 60 * 60 * 1000;

  test.each(['running', 'publish_conflict'] as const)(
    'abandons stale %s runs after seven days',
    async status => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const { runId } = await startDraftRun(owner);
      const now = new Date();
      await db
        .update(cloud_agent_environment_setup_runs)
        .set({ status, updated_at: new Date(now.getTime() - 8 * DAY).toISOString() })
        .where(eq(cloud_agent_environment_setup_runs.id, runId));

      const counts = await cleanupSetupRuns(db, now);

      expect(counts.abandoned).toBe(1);
      const run = await getSetupRun(db, runId, owner);
      expect(run.status).toBe('cancelled');
      expect(run.status_reason).toBe('abandoned');
    }
  );

  test('deletes drafts of stale stopped runs after fourteen days', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const { runId, draftEnvironmentId } = await createDraftRun(owner);
    const now = new Date();
    await db
      .update(cloud_agent_environment_setup_runs)
      .set({
        status: 'failed',
        status_reason: 'agent_failed',
        updated_at: new Date(now.getTime() - 15 * DAY).toISOString(),
      })
      .where(eq(cloud_agent_environment_setup_runs.id, runId));

    const counts = await cleanupSetupRuns(db, now);

    expect(counts.draftsDeleted).toBe(1);
    await expect(getEnvironment(db, draftEnvironmentId, owner)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const [run] = await db
      .select()
      .from(cloud_agent_environment_setup_runs)
      .where(eq(cloud_agent_environment_setup_runs.id, runId));
    expect(run.status).toBe('cancelled');
    expect(run.status_reason).toBe('draft_deleted');
  });

  test.each(['resumed', 'updated'] as const)(
    'a failed draft %s after cleanup discovery survives',
    async change => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const { runId, draftEnvironmentId } = await startDraftRun(owner);
      await db.transaction(tx =>
        updateEnvironment(tx, setupPublicKeyBase64, {
          owner,
          environmentId: draftEnvironmentId,
          commands: ['echo retained'],
          secrets: [{ key: 'TEST_TOKEN', value: 'retained-test-value' }],
        })
      );
      const before = await getEnvironment(db, draftEnvironmentId, owner);
      const [secret] = await db
        .select()
        .from(cloud_agent_environment_vars)
        .where(eq(cloud_agent_environment_vars.environment_id, draftEnvironmentId));
      const now = new Date();
      await db
        .update(cloud_agent_environment_setup_runs)
        .set({
          status: 'failed',
          status_reason: 'agent_failed',
          updated_at: new Date(now.getTime() - 15 * DAY).toISOString(),
        })
        .where(eq(cloud_agent_environment_setup_runs.id, runId));
      const select = db.select.bind(db);
      const discovered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const selectSpy = jest.spyOn(db, 'select').mockImplementationOnce((...args) => {
        const selected = select(...args);
        const from = selected.from.bind(selected);
        jest.spyOn(selected, 'from').mockImplementationOnce((...fromArgs) => {
          const joined = from(...fromArgs);
          const originalWhere = joined.where.bind(joined);
          jest.spyOn(joined, 'where').mockImplementationOnce(condition => {
            const result = originalWhere(condition);
            const rows = result.then(async rows => {
              discovered.resolve();
              await released.promise;
              return rows;
            });
            return rows as unknown as ReturnType<typeof joined.where>;
          });
          return joined;
        });
        return selected;
      });
      const cleanup = cleanupSetupRuns(db, now);
      try {
        await discovered.promise;
        if (change === 'resumed') await db.transaction(tx => resumeSetupRun(tx, { runId, owner }));
        else
          await db
            .update(cloud_agent_environment_setup_runs)
            .set({ status_detail: 'New failure details' })
            .where(eq(cloud_agent_environment_setup_runs.id, runId));
      } finally {
        released.resolve();
        selectSpy.mockRestore();
      }
      expect((await cleanup).draftsDeleted).toBe(0);
      expect(await getSetupRun(db, runId, owner)).toMatchObject({
        status: change === 'resumed' ? 'running' : 'failed',
        draft_environment_id: draftEnvironmentId,
      });
      expect(await getEnvironment(db, draftEnvironmentId, owner)).toEqual(before);
      expect(
        await db
          .select()
          .from(cloud_agent_environment_vars)
          .where(eq(cloud_agent_environment_vars.environment_id, draftEnvironmentId))
      ).toEqual([secret]);
    }
  );

  test('clears previous configurations after thirty days', async () => {
    const user = await insertTestUser();
    const owner = userOwner(user.id);
    const targetId = await createTargetEnvironment(owner, { commands: ['npm run old'] });
    const { runId } = await startDraftRun(owner, { targetEnvironmentId: targetId });
    await db.transaction(tx => publishWithPassingVerification(tx, { runId, owner, mode: 'gate' }));
    const now = new Date();
    await db
      .update(cloud_agent_environment_setup_runs)
      .set({ completed_at: new Date(now.getTime() - 31 * DAY).toISOString() })
      .where(eq(cloud_agent_environment_setup_runs.id, runId));

    const organization = await createTestOrganization('Deleted setup owner', user.id, 0);
    const inactiveOwner: EnvironmentOwner = { type: 'organization', id: organization.id };
    const inactive = await createDraftRun(inactiveOwner);
    await db
      .update(cloud_agent_environment_setup_runs)
      .set({
        status: 'failed',
        updated_at: new Date(now.getTime() - 15 * DAY).toISOString(),
      })
      .where(eq(cloud_agent_environment_setup_runs.id, inactive.runId));
    await db
      .update(organizations)
      .set({ deleted_at: now.toISOString() })
      .where(eq(organizations.id, organization.id));

    const stale = await createDraftRun(owner, {
      repositories: [{ platform: 'github', repoFullName: 'acme/stale' }],
    });
    await db
      .update(cloud_agent_environment_setup_runs)
      .set({
        status: 'failed',
        updated_at: new Date(now.getTime() - 15 * DAY).toISOString(),
      })
      .where(eq(cloud_agent_environment_setup_runs.id, stale.runId));

    const counts = await cleanupSetupRuns(db, now);

    expect(counts.previousConfigurationsCleared).toBe(1);
    expect(counts.draftsDeleted).toBe(1);
    expect((await getSetupRun(db, runId, owner)).previous_configuration).toBeNull();
  });
});
