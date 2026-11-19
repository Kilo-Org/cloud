import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  github_app_installations,
  kilocode_users,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  bindGitHubIntegrationToCanonicalInstallation,
  connectVerifiedGitHubInstallation,
} from '@/lib/integrations/db/github-installations';
import type * as GitHubInstallationsModule from '@/lib/integrations/db/github-installations';
import type * as PlatformIntegrationsModule from '@/lib/integrations/db/platform-integrations';
import type { InstallationCreatedPayload } from '../webhook-schemas';
import { handleInstallationCreated, handleInstallationUnsuspend } from './installation-handler';

jest.mock('../adapter', () => ({
  fetchGitHubRepositories: jest.fn(async () => []),
}));
jest.mock('@/lib/bot', () => ({
  bot: { initialize: jest.fn(async () => undefined), getState: jest.fn(() => ({})) },
}));
jest.mock('@/lib/bot-identity', () => ({
  unlinkTeamKiloUsers: jest.fn(async () => undefined),
}));

// Test-controlled pauses inside the pending completion and inside the canonical
// binding, used only by the controlled-concurrency tests below. The mock factory
// references this object only when the mocked function is called (long after
// initialization), so the hoisted factory never touches it while it is still
// uninitialized.
const autoCompleteGateState: {
  gate: Promise<void> | null;
  entered: Promise<void> | null;
  release: (() => void) | null;
  markEntered: (() => void) | null;
  bindGate: Promise<void> | null;
  bindEntered: Promise<void> | null;
  releaseBind: (() => void) | null;
  markBindEntered: (() => void) | null;
  failBind: boolean;
} = {
  gate: null,
  entered: null,
  release: null,
  markEntered: null,
  bindGate: null,
  bindEntered: null,
  releaseBind: null,
  markBindEntered: null,
  failBind: false,
};

jest.mock('@/lib/integrations/db/github-installations', () => {
  const actual = jest.requireActual<typeof GitHubInstallationsModule>(
    '@/lib/integrations/db/github-installations'
  );
  return {
    ...actual,
    bindGitHubIntegrationToCanonicalInstallation: async (
      ...args: Parameters<typeof actual.bindGitHubIntegrationToCanonicalInstallation>
    ) => {
      if (autoCompleteGateState.failBind) throw new Error('bind failed');
      autoCompleteGateState.markBindEntered?.();
      if (autoCompleteGateState.bindGate) await autoCompleteGateState.bindGate;
      return actual.bindGitHubIntegrationToCanonicalInstallation(...args);
    },
  };
});

jest.mock('@/lib/integrations/db/platform-integrations', () => {
  const actual = jest.requireActual<typeof PlatformIntegrationsModule>(
    '@/lib/integrations/db/platform-integrations'
  );
  return {
    ...actual,
    autoCompleteInstallation: async (
      ...args: Parameters<typeof actual.autoCompleteInstallation>
    ) => {
      autoCompleteGateState.markEntered?.();
      if (autoCompleteGateState.gate) await autoCompleteGateState.gate;
      return actual.autoCompleteInstallation(...args);
    },
  };
});

function installAutoCompleteGate() {
  const gate = Promise.withResolvers<void>();
  autoCompleteGateState.gate = gate.promise;
  autoCompleteGateState.release = gate.resolve;
  const entered = Promise.withResolvers<void>();
  autoCompleteGateState.entered = entered.promise;
  autoCompleteGateState.markEntered = entered.resolve;
}

function installBindGate() {
  const gate = Promise.withResolvers<void>();
  autoCompleteGateState.bindGate = gate.promise;
  autoCompleteGateState.releaseBind = gate.resolve;
  const entered = Promise.withResolvers<void>();
  autoCompleteGateState.bindEntered = entered.promise;
  autoCompleteGateState.markBindEntered = entered.resolve;
}

const ownerId = 'oauth/installation-handler-db-owner';
const otherOwnerId = 'oauth/installation-handler-db-other-owner';
const ACCOUNT_ID = 98765;
const ACCOUNT_LOGIN = 'handler-db-acme';
const REQUESTER_ID = 4242;

function createdPayload(installationId: string): InstallationCreatedPayload {
  return {
    action: 'created',
    installation: {
      id: Number(installationId),
      account: { id: ACCOUNT_ID, login: ACCOUNT_LOGIN },
      repository_selection: 'all',
      permissions: {},
      events: [],
      created_at: '2026-09-15T00:00:00.000Z',
    },
    requester: { id: REQUESTER_ID, login: 'requester' },
    sender: { id: REQUESTER_ID, login: 'requester' },
  } as InstallationCreatedPayload;
}

function verifiedConnectionData(installationId: string, kiloUserId: string) {
  return {
    platformInstallationId: installationId,
    platformAccountId: String(ACCOUNT_ID),
    platformAccountLogin: ACCOUNT_LOGIN,
    permissions: {},
    scopes: [],
    repositoryAccess: 'all',
    repositories: null,
    installedAt: '2026-09-15T00:00:00.000Z',
    githubAppType: 'standard' as const,
    kiloUserId,
    githubUserId: '5678',
    accountType: 'Organization' as const,
  };
}

async function insertPendingRequest(
  organizationId: string,
  requesterAccountId: string | null = String(REQUESTER_ID)
) {
  const inserted = await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: organizationId,
      platform: 'github',
      integration_type: 'app',
      github_app_type: 'standard',
      platform_account_id: String(ACCOUNT_ID),
      platform_account_login: ACCOUNT_LOGIN,
      platform_requester_account_id: requesterAccountId,
      platform_installation_id: null,
      integration_status: 'pending',
      repository_access: 'all',
    })
    .returning();
  const pending = inserted[0];
  if (!pending) throw new Error('Expected the pending request row');
  return pending;
}

async function boundAssociations(installationId: string) {
  return db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, 'github'),
        eq(platform_integrations.platform_installation_id, installationId),
        isNotNull(platform_integrations.github_installation_id)
      )
    );
}

async function canonicalSharingMode(installationId: string) {
  const [canonical] = await db
    .select({ sharingMode: github_app_installations.sharing_mode })
    .from(github_app_installations)
    .where(
      and(
        eq(github_app_installations.github_app_type, 'standard'),
        eq(github_app_installations.installation_id, installationId)
      )
    );
  return canonical?.sharingMode;
}

async function canonicalInstallationId(installationId: string) {
  const [canonical] = await db
    .select({ id: github_app_installations.id })
    .from(github_app_installations)
    .where(
      and(
        eq(github_app_installations.github_app_type, 'standard'),
        eq(github_app_installations.installation_id, installationId)
      )
    );
  return canonical?.id;
}

async function insertActiveUnboundAssociation(input: {
  organizationId: string;
  installationId: string;
  githubAppType?: 'standard' | 'lite';
  connectionRole?: 'workflow' | 'agent_only' | null;
}) {
  const inserted = await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: input.organizationId,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: input.installationId,
      github_app_type: input.githubAppType ?? 'standard',
      github_connection_role: input.connectionRole ?? null,
      platform_account_id: String(ACCOUNT_ID),
      platform_account_login: ACCOUNT_LOGIN,
      integration_status: 'active',
      repository_access: 'all',
    })
    .returning();
  const association = inserted[0];
  if (!association) throw new Error('Expected the active unbound association');
  return association;
}

describe('handleInstallationCreated sharing-admission serialization', () => {
  beforeEach(async () => {
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = '';
    process.env.GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS = '';
    await cleanupDbForTest();
    await db.insert(kilocode_users).values([
      {
        id: ownerId,
        google_user_email: 'handler-db-owner@example.com',
        google_user_name: 'Handler DB Owner',
        google_user_image_url: '',
        stripe_customer_id: 'cus_handler_db_owner',
      },
      {
        id: otherOwnerId,
        google_user_email: 'handler-db-other@example.com',
        google_user_name: 'Handler DB Other',
        google_user_image_url: '',
        stripe_customer_id: 'cus_handler_db_other',
      },
    ]);
  });

  afterEach(async () => {
    // A test that fails on a gate assertion must not leave a paused call
    // waiting: release any installed pause, then clear the gate state for the
    // tests that follow it.
    autoCompleteGateState.failBind = false;
    autoCompleteGateState.release?.();
    autoCompleteGateState.releaseBind?.();
    autoCompleteGateState.gate = null;
    autoCompleteGateState.entered = null;
    autoCompleteGateState.release = null;
    autoCompleteGateState.markEntered = null;
    autoCompleteGateState.bindGate = null;
    autoCompleteGateState.bindEntered = null;
    autoCompleteGateState.releaseBind = null;
    autoCompleteGateState.markBindEntered = null;
    await cleanupDbForTest();
  });

  test('leaves a pending request pending when another tenant already owns the installation', async () => {
    const organizationA = await createTestOrganization('Handler DB Pending A', ownerId, 0);
    const organizationB = await createTestOrganization('Handler DB Pending B', otherOwnerId, 0);
    const installationId = '424242';

    const bound = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      verifiedConnectionData(installationId, otherOwnerId)
    );
    if (!bound.ok) throw new Error('Expected the competing tenant to connect first');

    const pending = await insertPendingRequest(organizationA.id);

    const response = await handleInstallationCreated(createdPayload(installationId), 'standard');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      message: 'Installation association requires verified connection confirmation',
    });

    const [pendingAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, pending.id));
    expect(pendingAfter).toMatchObject({
      integration_status: 'pending',
      github_installation_id: null,
      platform_installation_id: null,
    });

    const rows = await boundAssociations(installationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.owned_by_organization_id).toBe(organizationB.id);
    await expect(canonicalSharingMode(installationId)).resolves.toBe('exclusive');
  });

  test('leaves pending requests pending when the delivery is not attributed to their recorded requester', async () => {
    const otherRequester = await createTestOrganization('Handler DB Other Requester', ownerId, 0);
    const noRequester = await createTestOrganization('Handler DB No Requester', otherOwnerId, 0);
    const installationId = '474747';

    // One request records a different GitHub identity than this delivery's
    // requester; the other never captured an identity at all.
    const recordedOther = await insertPendingRequest(otherRequester.id, '9999');
    const unrecorded = await insertPendingRequest(noRequester.id, null);

    const response = await handleInstallationCreated(createdPayload(installationId), 'standard');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ message: 'Installation recorded' });

    const rows = await db
      .select()
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, 'github'),
          eq(platform_integrations.platform_account_id, String(ACCOUNT_ID)),
          eq(platform_integrations.integration_status, 'pending')
        )
      );
    expect(rows.map(row => row.id).sort()).toEqual([recordedOther.id, unrecorded.id].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        platform_installation_id: null,
        github_installation_id: null,
      });
    }
    await expect(boundAssociations(installationId)).resolves.toHaveLength(0);
  });

  test('a pending completion that wins the installation lock still forces the verified path through sharing admission', async () => {
    const organizationA = await createTestOrganization('Handler DB Winner A', ownerId, 0);
    const organizationB = await createTestOrganization('Handler DB Winner B', otherOwnerId, 0);
    const installationId = '434343';

    await insertPendingRequest(organizationA.id);

    const response = await handleInstallationCreated(createdPayload(installationId), 'standard');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ message: 'Installation completed' });

    const rows = await boundAssociations(installationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.owned_by_organization_id).toBe(organizationA.id);

    // The organization that lost the race is not on the shared-installation
    // allowlist, so the verified path must require admission instead of
    // silently becoming a second exclusive tenant.
    await expect(
      connectVerifiedGitHubInstallation(
        { type: 'org', id: organizationB.id },
        verifiedConnectionData(installationId, otherOwnerId)
      )
    ).resolves.toEqual({ ok: false, reason: 'shared_installation_disabled' });

    await expect(boundAssociations(installationId)).resolves.toHaveLength(1);
    await expect(canonicalSharingMode(installationId)).resolves.toBe('exclusive');
  });

  test('a concurrent verified connection cannot commit between the pending-row check and its bind', async () => {
    const organizationA = await createTestOrganization('Handler DB Gate A', ownerId, 0);
    const organizationB = await createTestOrganization('Handler DB Gate B', otherOwnerId, 0);
    const installationId = '515151';

    await insertPendingRequest(organizationA.id);

    installAutoCompleteGate();
    const handlerPromise = handleInstallationCreated(createdPayload(installationId), 'standard');
    // The handler has passed its exclusivity check and is paused mid-completion.
    await autoCompleteGateState.entered;

    const verifiedPromise = connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      verifiedConnectionData(installationId, otherOwnerId)
    );
    // Give the competing verified connection every chance to commit.
    await new Promise(resolve => setTimeout(resolve, 250));

    // It must be blocked on the installation lock rather than becoming the
    // first exclusive tenant while the pending completion is still in flight.
    await expect(boundAssociations(installationId)).resolves.toHaveLength(0);

    autoCompleteGateState.release?.();
    const [response, verifiedResult] = await Promise.all([handlerPromise, verifiedPromise]);

    expect(response.status).toBe(200);
    expect(verifiedResult).toEqual({ ok: false, reason: 'shared_installation_disabled' });

    const rows = await boundAssociations(installationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.owned_by_organization_id).toBe(organizationA.id);
    await expect(canonicalSharingMode(installationId)).resolves.toBe('exclusive');
  });

  test('rolls back the pending completion when the canonical binding fails', async () => {
    const organization = await createTestOrganization('Handler DB Rollback', ownerId, 0);
    const installationId = '525252';

    const pending = await insertPendingRequest(organization.id);
    autoCompleteGateState.failBind = true;
    await expect(
      handleInstallationCreated(createdPayload(installationId), 'standard')
    ).rejects.toThrow('bind failed');
    autoCompleteGateState.failBind = false;

    // The completion ran inside the same transaction as the binding, so a
    // binding failure must leave nothing partially applied.
    const [pendingAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, pending.id));
    expect(pendingAfter).toMatchObject({
      integration_status: 'pending',
      platform_installation_id: null,
      github_installation_id: null,
    });
  });

  test('does not auto-attach a second tenant while legacy associations are committed but unbound', async () => {
    const legacyOwner = await createTestOrganization('Handler DB Legacy Unbound', otherOwnerId, 0);
    const otherLegacyOwner = await createTestOrganization(
      'Handler DB Legacy Unbound Two',
      otherOwnerId,
      0
    );
    const requester = await createTestOrganization('Handler DB Legacy Pending', ownerId, 0);
    const installationId = '575757';

    // The fixture rows stand for legacy associations that are already
    // committed against this installation and not yet bound to a canonical
    // row; the callback that wrote them is not part of this test. Two such
    // rows exist here, so the repair path does not converge them to a single
    // candidate before the pending completion runs.
    const legacyRows = await db
      .insert(platform_integrations)
      .values(
        [legacyOwner.id, otherLegacyOwner.id].map((organizationId, index) => ({
          github_connection_role: index === 0 ? ('workflow' as const) : null,
          owned_by_organization_id: organizationId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: installationId,
          github_app_type: 'standard' as const,
          platform_account_id: String(ACCOUNT_ID),
          platform_account_login: ACCOUNT_LOGIN,
          integration_status: 'active' as const,
          repository_access: 'all',
        }))
      )
      .returning();
    const legacy = legacyRows[0];
    if (!legacy) throw new Error('Expected a legacy association');

    const pending = await insertPendingRequest(requester.id);

    await handleInstallationCreated(createdPayload(installationId), 'standard');

    // The pending request must not become a second tenant on this installation
    // just because the legacy peer is not bound yet.
    const [pendingAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, pending.id));
    expect(pendingAfter).toMatchObject({
      integration_status: 'pending',
      github_installation_id: null,
    });

    // The legacy path then completes its own bind, as the callback does.
    await bindGitHubIntegrationToCanonicalInstallation({
      integrationId: legacy.id,
      installationId,
      appType: 'standard',
    });

    // Invariant: never two live tenants on one installation.
    const bound = await boundAssociations(installationId);
    expect(bound.length).toBeLessThanOrEqual(1);
  });

  test('binds the sole active unbound association to the canonical installation', async () => {
    const organization = await createTestOrganization('Handler DB Sole Candidate', ownerId, 0);
    const installationId = '600601';
    const candidate = await insertActiveUnboundAssociation({
      organizationId: organization.id,
      installationId,
      connectionRole: 'workflow',
    });

    // The delivery records the canonical row, so the repair attaches the
    // association to it without changing the sharing mode from its default.
    await expect(canonicalSharingMode(installationId)).resolves.toBeUndefined();

    const response = await handleInstallationCreated(createdPayload(installationId), 'standard');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ message: 'Installation recorded' });

    const canonicalId = await canonicalInstallationId(installationId);
    if (!canonicalId) throw new Error('Expected the canonical installation row');
    const [candidateAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, candidate.id));
    expect(candidateAfter?.github_installation_id).toBe(canonicalId);

    const rows = await boundAssociations(installationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(candidate.id);
    await expect(canonicalSharingMode(installationId)).resolves.toBe('exclusive');
  });

  test('leaves an active unbound association unbound while another tenant holds the installation', async () => {
    const organizationA = await createTestOrganization('Handler DB Repair Peer A', ownerId, 0);
    const organizationB = await createTestOrganization('Handler DB Repair Peer B', otherOwnerId, 0);
    const installationId = '600602';

    const connected = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      verifiedConnectionData(installationId, otherOwnerId)
    );
    if (!connected.ok) throw new Error('Expected the first tenant to connect');

    // UQ_platform_integrations_github_workflow_identity allows one workflow-role
    // association per installation identity, so an association that still waits
    // for its canonical binding carries no connection role.
    const candidate = await insertActiveUnboundAssociation({
      organizationId: organizationA.id,
      installationId,
    });
    await expect(canonicalSharingMode(installationId)).resolves.toBe('exclusive');

    const response = await handleInstallationCreated(createdPayload(installationId), 'standard');
    expect(response.status).toBe(200);

    const [candidateAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, candidate.id));
    expect(candidateAfter).toMatchObject({
      integration_status: 'active',
      github_installation_id: null,
    });

    const rows = await boundAssociations(installationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.owned_by_organization_id).toBe(organizationB.id);
    await expect(canonicalSharingMode(installationId)).resolves.toBe('exclusive');
  });

  test('leaves the workflow candidate unbound while a bound legacy peer holds the installation', async () => {
    const legacyOrganization = await createTestOrganization(
      'Handler DB Legacy Bound Peer',
      otherOwnerId,
      0
    );
    const candidateOrganization = await createTestOrganization(
      'Handler DB Legacy Bound Candidate',
      ownerId,
      0
    );
    const installationId = '600611';

    const inserted = await db
      .insert(github_app_installations)
      .values({
        github_app_type: 'standard',
        installation_id: installationId,
        account_id: String(ACCOUNT_ID),
        account_login: ACCOUNT_LOGIN,
        account_type: 'Organization',
        repository_access: 'all',
        lifecycle_state: 'active',
        observed_at: new Date().toISOString(),
      })
      .returning({ id: github_app_installations.id });
    const canonical = inserted[0];
    if (!canonical) throw new Error('Expected the canonical installation row');

    // The peer is a legacy association that already points at the canonical
    // installation.
    const legacyInserted = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: legacyOrganization.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: installationId,
        github_app_type: 'standard',
        github_installation_id: canonical.id,
        platform_account_id: String(ACCOUNT_ID),
        platform_account_login: ACCOUNT_LOGIN,
        integration_status: 'active',
        repository_access: 'all',
      })
      .returning();
    const legacyPeer = legacyInserted[0];
    if (!legacyPeer) throw new Error('Expected the legacy peer');

    const candidate = await insertActiveUnboundAssociation({
      organizationId: candidateOrganization.id,
      installationId,
      connectionRole: 'workflow',
    });
    await expect(canonicalSharingMode(installationId)).resolves.toBe('exclusive');

    const response = await handleInstallationCreated(createdPayload(installationId), 'standard');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ message: 'Installation recorded' });

    const rows = await boundAssociations(installationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(legacyPeer.id);

    const [candidateAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, candidate.id));
    expect(candidateAfter).toMatchObject({
      integration_status: 'active',
      github_installation_id: null,
    });
    await expect(canonicalSharingMode(installationId)).resolves.toBe('exclusive');
  });

  test('leaves the sole candidate unbound while a pending peer projects the installation', async () => {
    const organization = await createTestOrganization('Handler DB Pending Peer', ownerId, 0);
    const peerOrganization = await createTestOrganization(
      'Handler DB Pending Peer Two',
      otherOwnerId,
      0
    );
    const installationId = '600603';

    const candidate = await insertActiveUnboundAssociation({
      organizationId: organization.id,
      installationId,
      connectionRole: 'workflow',
    });
    const inserted = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: peerOrganization.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: installationId,
        github_app_type: 'standard',
        platform_account_id: String(ACCOUNT_ID),
        platform_account_login: ACCOUNT_LOGIN,
        platform_requester_account_id: '9999',
        integration_status: 'pending',
        repository_access: 'all',
      })
      .returning();
    const peer = inserted[0];
    if (!peer) throw new Error('Expected the pending peer');

    const response = await handleInstallationCreated(createdPayload(installationId), 'standard');
    expect(response.status).toBe(200);

    const [candidateAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, candidate.id));
    expect(candidateAfter).toMatchObject({ github_installation_id: null });

    const [peerAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, peer.id));
    expect(peerAfter).toMatchObject({
      integration_status: 'pending',
      platform_installation_id: installationId,
      github_installation_id: null,
    });

    await expect(boundAssociations(installationId)).resolves.toHaveLength(0);
  });

  test('binds the sole candidate when a pending request carries no installation projection', async () => {
    const organization = await createTestOrganization(
      'Handler DB Pending No Projection',
      ownerId,
      0
    );
    const requesterOrganization = await createTestOrganization(
      'Handler DB Pending No Projection Two',
      otherOwnerId,
      0
    );
    const installationId = '600604';

    const candidate = await insertActiveUnboundAssociation({
      organizationId: organization.id,
      installationId,
      connectionRole: 'workflow',
    });
    const pending = await insertPendingRequest(requesterOrganization.id, '9999');

    const response = await handleInstallationCreated(createdPayload(installationId), 'standard');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ message: 'Installation recorded' });

    const [candidateAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, candidate.id));
    expect(candidateAfter?.github_installation_id).not.toBeNull();

    const [pendingAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, pending.id));
    expect(pendingAfter).toMatchObject({
      integration_status: 'pending',
      platform_installation_id: null,
      github_installation_id: null,
    });

    const rows = await boundAssociations(installationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(candidate.id);
  });

  test('serializes the active repair with a concurrent verified connection', async () => {
    const organizationA = await createTestOrganization('Handler DB Repair Race A', ownerId, 0);
    const organizationB = await createTestOrganization('Handler DB Repair Race B', otherOwnerId, 0);
    const installationId = '600605';

    const candidate = await insertActiveUnboundAssociation({
      organizationId: organizationA.id,
      installationId,
      connectionRole: 'workflow',
    });
    await expect(canonicalSharingMode(installationId)).resolves.toBeUndefined();

    installBindGate();
    const handlerPromise = handleInstallationCreated(createdPayload(installationId), 'standard');
    // The repair has taken the installation identity and is paused before
    // the canonical binding.
    await autoCompleteGateState.bindEntered;

    const verifiedPromise = connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      verifiedConnectionData(installationId, otherOwnerId)
    );
    // The wait being observed is a Postgres advisory lock, so real time is
    // the only clock that can prove the promise stays unsettled.
    const timer = Promise.withResolvers<'pending'>();
    setTimeout(() => timer.resolve('pending'), 250);
    const firstSettled = await Promise.race([
      verifiedPromise.then(() => 'settled' as const),
      timer.promise,
    ]);

    // The verified connection waits on the installation identity, so it
    // cannot commit a second tenant while the repair is in flight.
    expect(firstSettled).toBe('pending');
    await expect(boundAssociations(installationId)).resolves.toHaveLength(0);

    autoCompleteGateState.releaseBind?.();
    const [response, verifiedResult] = await Promise.all([handlerPromise, verifiedPromise]);

    expect(response.status).toBe(200);
    expect(verifiedResult).toEqual({ ok: false, reason: 'shared_installation_disabled' });

    const rows = await boundAssociations(installationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(candidate.id);
    await expect(canonicalSharingMode(installationId)).resolves.toBe('exclusive');
  }, 30000);

  test('admits allowlisted shared tenants besides an unbound legacy association', async () => {
    const organizationA = await createTestOrganization('Handler DB Sharing A', ownerId, 0);
    const organizationB = await createTestOrganization('Handler DB Sharing B', otherOwnerId, 0);
    const organizationC = await createTestOrganization('Handler DB Sharing C', ownerId, 0);
    const organizationD = await createTestOrganization('Handler DB Sharing D', otherOwnerId, 0);
    const installationId = '600606';

    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = [
      organizationB.id,
      organizationD.id,
    ].join(',');

    const first = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationA.id },
      verifiedConnectionData(installationId, ownerId)
    );
    if (!first.ok) throw new Error('Expected the first tenant to connect');
    const second = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      verifiedConnectionData(installationId, otherOwnerId)
    );
    if (!second.ok) throw new Error('Expected the shared tenant to connect');

    const third = await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationD.id },
      verifiedConnectionData(installationId, ownerId)
    );
    expect(third).toMatchObject({ ok: true });
    await expect(boundAssociations(installationId)).resolves.toHaveLength(3);

    // A live, shared installation still admits allowlisted tenants, and the
    // association that holds no canonical binding stays unbound beside them.
    const candidate = await insertActiveUnboundAssociation({
      organizationId: organizationC.id,
      installationId,
    });

    const response = await handleInstallationCreated(createdPayload(installationId), 'standard');
    expect(response.status).toBe(200);

    const [candidateAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, candidate.id));
    expect(candidateAfter).toMatchObject({ github_installation_id: null });

    const admitted = await boundAssociations(installationId);
    expect(admitted.map(row => row.owned_by_organization_id).sort()).toEqual(
      [organizationA.id, organizationB.id, organizationD.id].sort()
    );
    await expect(canonicalSharingMode(installationId)).resolves.toBe('exclusive');

    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = '';
  }, 30000);

  test('binds the sole candidate beside a disconnected former tenant', async () => {
    const organization = await createTestOrganization('Handler DB Recovery Candidate', ownerId, 0);
    const formerOrganization = await createTestOrganization(
      'Handler DB Recovery Former Tenant',
      otherOwnerId,
      0
    );
    const installationId = '600607';

    const candidate = await insertActiveUnboundAssociation({
      organizationId: organization.id,
      installationId,
      connectionRole: 'workflow',
    });
    await db.insert(platform_integrations).values({
      owned_by_organization_id: formerOrganization.id,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: installationId,
      github_app_type: 'standard',
      platform_account_id: String(ACCOUNT_ID),
      platform_account_login: ACCOUNT_LOGIN,
      integration_status: 'suspended',
      suspended_at: new Date().toISOString(),
      suspended_by: 'local_disconnect',
      github_disconnected_at: new Date().toISOString(),
      repository_access: 'all',
    });

    const response = await handleInstallationCreated(createdPayload(installationId), 'standard');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ message: 'Installation recorded' });

    const [candidateAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, candidate.id));
    expect(candidateAfter?.github_installation_id).not.toBeNull();

    const rows = await boundAssociations(installationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(candidate.id);
  });

  test('binds the standard candidate when a lite association uses the same installation number', async () => {
    const organization = await createTestOrganization('Handler DB App Type Standard', ownerId, 0);
    const liteOrganization = await createTestOrganization(
      'Handler DB App Type Lite',
      otherOwnerId,
      0
    );
    const installationId = '600608';

    const candidate = await insertActiveUnboundAssociation({
      organizationId: organization.id,
      installationId,
      connectionRole: 'workflow',
    });
    const lite = await insertActiveUnboundAssociation({
      organizationId: liteOrganization.id,
      installationId,
      githubAppType: 'lite',
      connectionRole: 'workflow',
    });

    const response = await handleInstallationCreated(createdPayload(installationId), 'standard');
    expect(response.status).toBe(200);

    const [candidateAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, candidate.id));
    expect(candidateAfter?.github_installation_id).not.toBeNull();

    const [liteAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, lite.id));
    expect(liteAfter).toMatchObject({
      github_app_type: 'lite',
      integration_status: 'active',
      github_installation_id: null,
    });

    const rows = await boundAssociations(installationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(candidate.id);
  });

  test('records the delivery without binding when no active unbound association exists', async () => {
    const organization = await createTestOrganization('Handler DB No Candidate', ownerId, 0);
    const installationId = '600609';

    const inserted = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organization.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: installationId,
        github_app_type: 'standard',
        platform_account_id: String(ACCOUNT_ID),
        platform_account_login: ACCOUNT_LOGIN,
        integration_status: 'suspended',
        suspended_at: new Date().toISOString(),
        suspended_by: 'local_disconnect',
        github_disconnected_at: new Date().toISOString(),
        repository_access: 'all',
      })
      .returning();
    const inactive = inserted[0];
    if (!inactive) throw new Error('Expected the suspended association');

    const response = await handleInstallationCreated(createdPayload(installationId), 'standard');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ message: 'Installation recorded' });

    const [inactiveAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, inactive.id));
    expect(inactiveAfter).toMatchObject({
      integration_status: 'suspended',
      github_disconnected_at: expect.any(String),
      github_installation_id: null,
    });
    await expect(boundAssociations(installationId)).resolves.toHaveLength(0);
  });

  test('rolls back the repair when the canonical binding fails', async () => {
    const organization = await createTestOrganization('Handler DB Repair Rollback', ownerId, 0);
    const installationId = '600610';

    const candidate = await insertActiveUnboundAssociation({
      organizationId: organization.id,
      installationId,
      connectionRole: 'workflow',
    });

    autoCompleteGateState.failBind = true;
    await expect(
      handleInstallationCreated(createdPayload(installationId), 'standard')
    ).rejects.toThrow('bind failed');
    autoCompleteGateState.failBind = false;

    // The repair runs inside one transaction, so a binding failure leaves the
    // candidate unbound and the canonical row untouched.
    const [candidateAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, candidate.id));
    expect(candidateAfter).toMatchObject({ github_installation_id: null });
    await expect(boundAssociations(installationId)).resolves.toHaveLength(0);
  });

  test('recovers the connected tenant when a disconnected former tenant is also present', async () => {
    const disconnectedOwner = await createTestOrganization(
      'Handler DB Unsuspend Former Tenant',
      otherOwnerId,
      0
    );
    const connectedOwner = await createTestOrganization(
      'Handler DB Unsuspend Live Tenant',
      ownerId,
      0
    );
    const installationId = '585858';

    const inserted = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_organization_id: disconnectedOwner.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: installationId,
          github_app_type: 'standard',
          platform_account_id: String(ACCOUNT_ID),
          platform_account_login: ACCOUNT_LOGIN,
          integration_status: 'suspended',
          suspended_at: new Date().toISOString(),
          suspended_by: 'local_disconnect',
          github_disconnected_at: new Date().toISOString(),
          repository_access: 'all',
        },
        {
          owned_by_organization_id: connectedOwner.id,
          github_connection_role: 'workflow',
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: installationId,
          github_app_type: 'standard',
          platform_account_id: String(ACCOUNT_ID),
          platform_account_login: ACCOUNT_LOGIN,
          integration_status: 'suspended',
          suspended_at: new Date().toISOString(),
          suspended_by: 'github_suspend',
          repository_access: 'all',
        },
      ])
      .returning();
    const live = inserted[1];
    if (!live) throw new Error('Expected the connected association');

    await handleInstallationUnsuspend(
      { action: 'unsuspend', installation: { id: Number(installationId) } } as never,
      'standard'
    );

    // The connected tenant must recover even though an arbitrary lookup can
    // return the retained disconnected row first.
    const [recovered] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, live.id));
    expect(recovered).toMatchObject({ integration_status: 'active', suspended_at: null });
  });

  test('recovers a suspended association when GitHub delivers installation.unsuspend', async () => {
    const organization = await createTestOrganization('Handler DB Unsuspend', ownerId, 0);
    const installationId = '545454';

    const inserted = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organization.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: installationId,
        github_connection_role: 'workflow',
        github_app_type: 'standard',
        platform_account_id: String(ACCOUNT_ID),
        platform_account_login: ACCOUNT_LOGIN,
        integration_status: 'suspended',
        suspended_at: new Date().toISOString(),
        suspended_by: 'github_suspend',
        repository_access: 'all',
      })
      .returning();
    const suspended = inserted[0];
    if (!suspended) throw new Error('Expected the suspended association');

    const response = await handleInstallationUnsuspend(
      { action: 'unsuspend', installation: { id: Number(installationId) } } as never,
      'standard'
    );

    await expect(response.json()).resolves.toEqual({ message: 'Installation unsuspended' });
    const [recovered] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, suspended.id));
    expect(recovered).toMatchObject({ integration_status: 'active', suspended_at: null });
  });

  test('does not unsuspend a locally disconnected former tenant', async () => {
    const organization = await createTestOrganization(
      'Handler DB Unsuspend Disconnected',
      ownerId,
      0
    );
    const installationId = '565656';

    const inserted = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organization.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: installationId,
        github_app_type: 'standard',
        platform_account_id: String(ACCOUNT_ID),
        platform_account_login: ACCOUNT_LOGIN,
        integration_status: 'suspended',
        suspended_at: new Date().toISOString(),
        suspended_by: 'local_disconnect',
        github_disconnected_at: new Date().toISOString(),
        repository_access: 'all',
      })
      .returning();
    const disconnected = inserted[0];
    if (!disconnected) throw new Error('Expected the disconnected association');

    await handleInstallationUnsuspend(
      { action: 'unsuspend', installation: { id: Number(installationId) } } as never,
      'standard'
    );

    const [unchanged] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, disconnected.id));
    expect(unchanged).toMatchObject({
      github_disconnected_at: expect.any(String),
      integration_status: 'suspended',
    });
  });
});
