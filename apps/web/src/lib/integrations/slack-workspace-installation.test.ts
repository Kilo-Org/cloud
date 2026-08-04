import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  platform_integrations,
  slack_workspace_installations,
  type PlatformIntegration,
} from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { upsertSlackInstallation } from './slack-service';
import {
  deleteSlackWorkspaceInstallationIfUnreferenced,
  getSlackBotToken,
  getSlackTeamIdFromInstallation,
  upsertSlackWorkspaceInstallation,
} from './slack-workspace-installation';

function buildIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'integration-1',
    platform: 'slack',
    platform_installation_id: 'T123',
    platform_account_id: 'T123',
    metadata: null,
    ...overrides,
  } as unknown as PlatformIntegration;
}

async function readWorkspaceInstallation(teamId: string) {
  const [row] = await db
    .select()
    .from(slack_workspace_installations)
    .where(eq(slack_workspace_installations.team_id, teamId));
  return row ?? null;
}

describe('getSlackTeamIdFromInstallation', () => {
  it('prefers the platform installation id', () => {
    expect(
      getSlackTeamIdFromInstallation(
        buildIntegration({ platform_installation_id: 'T123', platform_account_id: 'T456' })
      )
    ).toBe('T123');
  });

  it('falls back to the platform account id for detached rows', () => {
    expect(
      getSlackTeamIdFromInstallation(
        buildIntegration({ platform_installation_id: null, platform_account_id: 'T456' })
      )
    ).toBe('T456');
  });

  it('returns undefined when neither identifier is set', () => {
    expect(
      getSlackTeamIdFromInstallation(
        buildIntegration({ platform_installation_id: null, platform_account_id: null })
      )
    ).toBeUndefined();
  });
});

describe('upsertSlackWorkspaceInstallation', () => {
  it('refreshes the stored token for an existing workspace', async () => {
    const teamId = `T-${randomUUID()}`;

    await upsertSlackWorkspaceInstallation({
      teamId,
      teamName: 'First Name',
      botToken: 'xoxb-first',
      botUserId: 'U_FIRST',
      scopes: ['chat:write'],
    });
    await upsertSlackWorkspaceInstallation({
      teamId,
      teamName: 'Second Name',
      botToken: 'xoxb-second',
      botUserId: 'U_SECOND',
      scopes: ['chat:write', 'team:read'],
    });

    const row = await readWorkspaceInstallation(teamId);
    expect(row?.bot_token).toBe('xoxb-second');
    expect(row?.bot_user_id).toBe('U_SECOND');
    expect(row?.team_name).toBe('Second Name');
    expect(row?.scopes).toEqual(['chat:write', 'team:read']);
  });
});

describe('deleteSlackWorkspaceInstallationIfUnreferenced', () => {
  it('deletes the record when no integration references the workspace', async () => {
    const teamId = `T-${randomUUID()}`;
    await upsertSlackWorkspaceInstallation({ teamId, botToken: 'xoxb-orphan' });

    await deleteSlackWorkspaceInstallationIfUnreferenced(teamId);

    expect(await readWorkspaceInstallation(teamId)).toBeNull();
  });

  // This is the guarantee that keeps a concurrent install from losing its token:
  // the reference check is part of the delete statement, not a preceding query.
  it('keeps the record while an integration still references the workspace', async () => {
    const user = await insertTestUser();
    const teamId = `T-${randomUUID()}`;

    await upsertSlackWorkspaceInstallation({ teamId, botToken: 'xoxb-referenced' });
    await db.insert(platform_integrations).values({
      owned_by_user_id: user.id,
      platform: 'slack',
      integration_type: 'oauth',
      platform_installation_id: teamId,
      platform_account_id: teamId,
      integration_status: 'active',
    });

    await deleteSlackWorkspaceInstallationIfUnreferenced(teamId);

    expect(await readWorkspaceInstallation(teamId)).not.toBeNull();
  });

  it('ignores integrations for other workspaces', async () => {
    const user = await insertTestUser();
    const teamId = `T-${randomUUID()}`;
    const otherTeamId = `T-${randomUUID()}`;

    await upsertSlackWorkspaceInstallation({ teamId, botToken: 'xoxb-orphan' });
    await db.insert(platform_integrations).values({
      owned_by_user_id: user.id,
      platform: 'slack',
      integration_type: 'oauth',
      platform_installation_id: otherTeamId,
      platform_account_id: otherTeamId,
      integration_status: 'active',
    });

    await deleteSlackWorkspaceInstallationIfUnreferenced(teamId);

    expect(await readWorkspaceInstallation(teamId)).toBeNull();
  });

  // Rows detached by 0108 have a NULL platform_installation_id and no longer hold a
  // claim on the workspace, so they must not keep the token alive.
  it('does not treat a detached integration as a reference', async () => {
    const user = await insertTestUser();
    const teamId = `T-${randomUUID()}`;

    await upsertSlackWorkspaceInstallation({ teamId, botToken: 'xoxb-orphan' });
    await db.insert(platform_integrations).values({
      owned_by_user_id: user.id,
      platform: 'slack',
      integration_type: 'oauth',
      platform_installation_id: null,
      platform_account_id: teamId,
      integration_status: 'suspended',
    });

    await deleteSlackWorkspaceInstallationIfUnreferenced(teamId);

    expect(await readWorkspaceInstallation(teamId)).toBeNull();
  });
});

describe('upsertSlackInstallation atomicity', () => {
  // The whole point of writing both rows in one transaction: a failed integration
  // write must not leave a token behind that nothing references. The insert below
  // fails on the owned_by_user_id foreign key, after the workspace record has
  // already been written inside the transaction.
  it('rolls the workspace record back when the integration row cannot be written', async () => {
    const teamId = `T-${randomUUID()}`;

    await expect(
      upsertSlackInstallation({
        owner: { type: 'user', id: `missing-user-${randomUUID()}` },
        teamId,
        installation: {
          botToken: 'xoxb-should-not-persist',
          botUserId: 'U_BOT',
          teamName: 'Rollback Team',
        },
      })
    ).rejects.toThrow();

    expect(await readWorkspaceInstallation(teamId)).toBeNull();
  });

  it('commits the workspace record together with the integration row', async () => {
    const user = await insertTestUser();
    const teamId = `T-${randomUUID()}`;

    await upsertSlackInstallation({
      owner: { type: 'user', id: user.id },
      teamId,
      installation: {
        botToken: 'xoxb-committed',
        botUserId: 'U_BOT',
        teamName: 'Commit Team',
      },
      installedByUserId: user.id,
    });

    const row = await readWorkspaceInstallation(teamId);
    expect(row?.bot_token).toBe('xoxb-committed');
    expect(row?.last_installed_by_user_id).toBe(user.id);

    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, teamId));
    expect(integration).toBeDefined();
  });
});

describe('getSlackBotToken', () => {
  it('returns the token from the workspace installation when metadata has none', async () => {
    const teamId = `T-${randomUUID()}`;
    await upsertSlackWorkspaceInstallation({ teamId, botToken: 'xoxb-workspace' });

    await expect(
      getSlackBotToken(buildIntegration({ platform_installation_id: teamId }))
    ).resolves.toBe('xoxb-workspace');
  });

  // The previous release writes only to metadata, so a disconnect and reconnect
  // served by it leaves a revoked token on the workspace record. Metadata has to
  // win for as long as the mirror exists.
  it('prefers the metadata copy over the workspace installation', async () => {
    const teamId = `T-${randomUUID()}`;
    await upsertSlackWorkspaceInstallation({ teamId, botToken: 'xoxb-stale-workspace' });

    await expect(
      getSlackBotToken(
        buildIntegration({
          platform_installation_id: teamId,
          metadata: { access_token: 'xoxb-fresh-metadata' },
        })
      )
    ).resolves.toBe('xoxb-fresh-metadata');
  });

  it('returns undefined when metadata has no token and no workspace record exists', async () => {
    await expect(
      getSlackBotToken(
        buildIntegration({ platform_installation_id: `T-${randomUUID()}`, metadata: {} })
      )
    ).resolves.toBeUndefined();
  });

  it('returns undefined when metadata has no token and the integration has no team id', async () => {
    await expect(
      getSlackBotToken(
        buildIntegration({
          platform_installation_id: null,
          platform_account_id: null,
          metadata: {},
        })
      )
    ).resolves.toBeUndefined();
  });
});
